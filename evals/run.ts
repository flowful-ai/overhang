import "./load-env"; // must be first: cad-worker.ts snapshots env at import time
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { liveCadWorker, openRouterModel, runAgentTurn, type AgentWorker } from "../src/lib/agent-turn";
import { webSearchProviderOptions } from "../src/lib/web-search";
import { caseCostDecision, stepUsage, type CostDecision, type StepUsage } from "./cost";
import { callCadWorker, pingCadWorker } from "../src/lib/cad-worker";
import type { BoundingBox } from "../src/lib/cad-worker-protocol";
import { EVAL_CASES, type EvalCase } from "./cases";
import { scoreCase, type CaseScore } from "./scoring";
import {
  Fixture,
  RESULTS_DIR,
  loadFixtures,
  modelSlug,
  saveFixture,
  stripStl,
  systemPromptSha256,
  type RunMetrics,
  type WorkerCallFixture,
} from "./recorder";

// Live eval runner. Runs the SAME agent turn as /api/generate-cad
// (runAgentTurn in src/lib/agent-turn.ts) against real OpenRouter and a real
// cad-worker, scores each case deterministically, and optionally records
// fixtures for the free CI replay.
//
// Usage:
//   npm run eval                                # all cases, default model
//   npm run eval -- --case l-bracket            # one case
//   npm run eval -- --model google/gemini-3-flash-preview --model anthropic/claude-sonnet-5
//                                               # model ids: MODELS in src/lib/utils.ts
//   npm run eval -- --record                    # also write evals/fixtures/
//   npm run eval -- --replay-worker             # recorded scripts -> live worker, no LLM cost
//   npm run eval -- --web-search                # let the model search the web on the first step
//                                               # (off by default so runs stay comparable)

const DEFAULT_MODEL = "deepseek/deepseek-v4-flash";
// Default hard abort for the whole run. A full 8-case run on a flash-class
// model is a few cents; hitting this cap means something is wrong (looping,
// expensive model by mistake), not that the suite is expensive. Frontier
// models legitimately cost more: raise per run with --cost-cap.
const DEFAULT_COST_CAP_USD = 0.5;

interface CaseRunResult {
  caseId: string;
  hard: boolean;
  score: CaseScore;
  metrics: RunMetrics;
  /** Model's final visible reply (truncated). The main clue when a case fails. */
  finalText?: string;
  finishReason?: string;
  /** The turn did not complete (no output, timeout, worker down). */
  error?: string;
  /** Error parts the turn streamed but recovered from; the case is still scored on its outcome. */
  streamErrors?: string[];
}

function parseArgs(argv: string[]) {
  const args = {
    models: [] as string[],
    caseId: null as string | null,
    record: false,
    replayWorker: false,
    webSearch: false,
    costCap: DEFAULT_COST_CAP_USD,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--model") args.models.push(argv[++i]);
    else if (a === "--case") args.caseId = argv[++i];
    else if (a === "--record") args.record = true;
    else if (a === "--web-search") args.webSearch = true;
    else if (a === "--replay-worker") args.replayWorker = true;
    else if (a === "--cost-cap") {
      args.costCap = Number(argv[++i]);
      if (!Number.isFinite(args.costCap) || args.costCap <= 0) {
        console.error("--cost-cap requires a positive number (USD)");
        process.exit(1);
      }
    }
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(1);
    }
  }
  if (args.models.length === 0) args.models = [DEFAULT_MODEL];
  return args;
}

/** Sum a field over completed steps; null when no step reported it. */
function sumReported(steps: readonly StepUsage[], key: keyof StepUsage): number | null {
  return steps.reduce<number | null>((sum, s) => (s[key] === null ? sum : (sum ?? 0) + (s[key] as number)), null);
}

async function runCase(
  evalCase: EvalCase,
  model: string,
  apiKey: string,
  record: boolean,
  webSearch: boolean,
): Promise<{ result: CaseRunResult; cost: CostDecision }> {
  const requestId = `eval-${evalCase.id}-${Date.now()}`;
  const workerCalls: WorkerCallFixture[] = [];
  let lastRender: { bbox: BoundingBox; warnings: string[] } | null = null;

  // The live worker, recording every call for the fixture.
  const worker: AgentWorker = {
    ping: liveCadWorker.ping,
    render: async (code, rid, options) => {
      try {
        const response = await liveCadWorker.render(code, rid, options);
        workerCalls.push({ ok: true, code, response: stripStl(response) });
        return response;
      } catch (e) {
        workerCalls.push({ ok: false, code, error: e instanceof Error ? e.message : String(e) });
        throw e;
      }
    },
  };

  const started = Date.now();
  let error: string | undefined;
  interface StepLike {
    text: string;
    toolCalls: ReadonlyArray<{ toolCallId: string; toolName: string; input: unknown }>;
    finishReason: string;
    usage?: unknown;
  }
  let steps: ReadonlyArray<StepLike> = [];
  // Usage per completed model step, read from finish-step parts while
  // draining, so it survives a turn that fails or times out later.
  const stepUsages: StepUsage[] = [];
  let finalText = "";
  let finishReason = "";
  const streamErrors: string[] = [];

  try {
    const turn = await runAgentTurn({
      model: openRouterModel(model, apiKey),
      prompt: evalCase.prompt,
      worker,
      requestId,
      webSearch,
      onRender: ({ bbox, warnings }) => {
        lastRender = { bbox, warnings };
      },
    });
    if (!turn.ok) throw new Error("cad-worker is not reachable");
    // Drain the stream: the turn only progresses while it is read. Error parts
    // do not end a turn (the model can recover), so they are recorded and the
    // case is scored on the final outcome. An abort (turn timeout) is a harness
    // error, and a turn with no output rejects `steps` below.
    let aborted: string | undefined;
    for await (const part of turn.stream.fullStream) {
      if (part.type === "error") {
        streamErrors.push(part.error instanceof Error ? part.error.message : String(part.error));
      }
      if (part.type === "finish-step") stepUsages.push(stepUsage(part.usage));
      if (part.type === "abort") aborted = `turn aborted: ${part.reason ?? "timeout"}`;
    }
    if (aborted) throw new Error(aborted);
    steps = (await turn.stream.steps) as ReadonlyArray<StepLike>;
    finalText = await turn.stream.text;
    finishReason = await turn.stream.finishReason;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  const durationMs = Date.now() - started;
  const render = lastRender as { bbox: BoundingBox; warnings: string[] } | null;
  const score = scoreCase(evalCase.expect, {
    rendered: render !== null,
    bbox: render?.bbox ?? null,
    warnings: render?.warnings ?? [],
  });
  const metrics: RunMetrics = {
    stepsUsed: stepUsages.length,
    inputTokens: sumReported(stepUsages, "inputTokens"),
    outputTokens: sumReported(stepUsages, "outputTokens"),
    costUsd: sumReported(stepUsages, "costUsd"),
    durationMs,
  };

  if (record && !error) {
    const fixture: Fixture = {
      version: 1,
      caseId: evalCase.id,
      model,
      systemPromptSha256: systemPromptSha256(),
      recordedAt: new Date().toISOString(),
      llmSteps: steps.map((step) => ({
        text: step.text,
        toolCalls: step.toolCalls.map((tc) => ({
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          input: tc.input as { code: string },
        })),
        finishReason: step.finishReason,
      })),
      workerCalls,
      score,
      metrics,
    };
    saveFixture(fixture);
  }

  const result: CaseRunResult = {
    caseId: evalCase.id,
    hard: evalCase.hard ?? false,
    score,
    metrics,
    finalText: finalText.slice(0, 500),
    finishReason,
    error,
    ...(streamErrors.length ? { streamErrors } : {}),
  };
  return { result, cost: caseCostDecision(stepUsages) };
}

function printReport(model: string, results: CaseRunResult[]) {
  const fmtCost = (c: number | null) => (c === null ? "n/a" : `$${c.toFixed(4)}`);
  console.log(`\n## ${model}\n`);
  console.log("| case | pass | rendered | watertight | bbox | warnings | steps | tokens in/out | cost | time |");
  console.log("|---|---|---|---|---|---|---|---|---|---|");
  for (const r of results) {
    const m = r.metrics;
    const mark = (b: boolean) => (b ? "✅" : "❌");
    console.log(
      `| ${r.caseId}${r.hard ? " (hard)" : ""} | ${mark(r.score.pass)} | ${mark(r.score.rendered)} | ` +
        `${mark(r.score.watertight)} | ${mark(r.score.bboxOk)} | ${r.score.warningsCount} | ${m.stepsUsed} | ` +
        `${m.inputTokens ?? "?"}/${m.outputTokens ?? "?"} | ${fmtCost(m.costUsd)} | ${(m.durationMs / 1000).toFixed(1)}s |` +
        (r.error ? ` <!-- error: ${r.error.slice(0, 120)} -->` : ""),
    );
    for (const e of r.streamErrors ?? []) console.log(`  stream error (turn continued): ${e.slice(0, 200)}`);
    if (r.error) console.log(`  error: ${r.error.slice(0, 200)}`);
    else if (!r.score.pass) {
      console.log(`  finish: ${r.finishReason || "?"} · text: ${(r.finalText || "<empty>").slice(0, 200).replace(/\n/g, " ")}`);
    }
  }
  const passed = results.filter((r) => r.score.pass).length;
  const totalCost = results.reduce((s, r) => s + (r.metrics.costUsd ?? 0), 0);
  console.log(`\n**${passed}/${results.length} passed** · total reported cost $${totalCost.toFixed(4)}`);
}

async function replayWorker(caseFilter: string | null) {
  const fixtures = loadFixtures().filter((f) => !caseFilter || f.caseId === caseFilter);
  if (fixtures.length === 0) {
    console.error("No fixtures found. Run with --record first.");
    process.exit(1);
  }
  console.log("Replaying recorded CadQuery scripts against the LIVE worker (no LLM cost):\n");
  console.log("| case | model | call | recorded | live | live warnings/error |");
  console.log("|---|---|---|---|---|---|");
  for (const f of fixtures) {
    for (let i = 0; i < f.workerCalls.length; i++) {
      const call = f.workerCalls[i];
      let live: string;
      let detail: string;
      try {
        const r = await callCadWorker(call.code, `replay-${f.caseId}-${i}`);
        live = "ok";
        detail = (r.warnings ?? []).join("; ") || "none";
      } catch (e) {
        live = "error";
        detail = (e instanceof Error ? e.message : String(e)).slice(0, 160);
      }
      const recorded = call.ok ? `ok (${(call.response.warnings ?? []).length} warn)` : "error";
      console.log(`| ${f.caseId} | ${modelSlug(f.model)} | ${i + 1} | ${recorded} | ${live} | ${detail.slice(0, 160)} |`);
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!(await pingCadWorker())) {
    console.error("cad-worker is not reachable. Start it first (docker compose up, or uvicorn in cad-worker/).");
    process.exit(1);
  }

  if (args.replayWorker) {
    await replayWorker(args.caseId);
    return;
  }

  if (!process.env.OPENROUTER_API_KEY) {
    console.error("OPENROUTER_API_KEY is not set (checked env and ./.env).");
    process.exit(1);
  }
  const apiKey = process.env.OPENROUTER_API_KEY;

  const cases = EVAL_CASES.filter((c) => !args.caseId || c.id === args.caseId);
  if (cases.length === 0) {
    console.error(`Unknown case: ${args.caseId}. Known: ${EVAL_CASES.map((c) => c.id).join(", ")}`);
    process.exit(1);
  }

  let spentUsd = 0;
  let costUnknown = false;
  const allResults: Record<string, CaseRunResult[]> = {};
  // Effective search per model: --web-search only applies where MODELS enables it.
  const webSearchByModel: Record<string, boolean> = {};
  for (const model of args.models) {
    const results: CaseRunResult[] = [];
    allResults[model] = results;
    webSearchByModel[model] = args.webSearch && webSearchProviderOptions(model) !== undefined;
    if (args.webSearch && !webSearchByModel[model]) {
      console.warn(`--web-search ignored for ${model}: web search is not enabled for it in MODELS.`);
    }
    for (const c of cases) {
      if (costUnknown) break;
      if (spentUsd > args.costCap) {
        console.error(`\nCost cap $${args.costCap} exceeded (spent ~$${spentUsd.toFixed(2)}); aborting remaining cases.`);
        process.exitCode = 1;
        break;
      }
      process.stdout.write(`[${model}] ${c.id} ... `);
      const { result: r, cost } = await runCase(c, model, apiKey, args.record, webSearchByModel[model]);
      results.push(r);
      console.log(r.error ? `harness error` : r.score.pass ? "pass" : "FAIL");
      if (cost.action === "stop") {
        // A model step completed without usage: counting it as free would let
        // the cost cap pass silently, so stop instead of guessing.
        console.error(
          `\nNo usage or cost reported for ${c.id} on ${model}; the cost cap cannot be enforced. Aborting remaining cases.`,
        );
        process.exitCode = 1;
        costUnknown = true;
        break;
      }
      spentUsd += cost.costUsd;
    }
    printReport(model, results);
    if (costUnknown) break;
  }

  mkdirSync(RESULTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outFile = path.join(RESULTS_DIR, `${stamp}.json`);
  writeFileSync(
    outFile,
    JSON.stringify(
      {
        recordedAt: new Date().toISOString(),
        systemPromptSha256: systemPromptSha256(),
        webSearch: webSearchByModel,
        results: allResults,
      },
      null,
      2,
    ),
  );
  console.log(`\nResults written to ${path.relative(process.cwd(), outFile)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
