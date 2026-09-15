import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { WorkerRenderResult } from "../src/lib/cad-worker-protocol";
import { SYSTEM_PROMPT } from "../src/lib/cad-agent";
import { CaseScore } from "./scoring";

// Fixture record/load for eval runs. A fixture captures everything needed to
// replay one case hermetically: the LLM's steps (text + tool calls) and every
// cad-worker request/response. STL payloads are stripped (they are large and
// scoring never reads them).
//
// systemPromptSha256 ties a fixture to the prompt it was recorded against:
// after a prompt change, fixtures are stale for *behavior* (the model would
// answer differently now) but still valid for testing the harness itself.

const EVALS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES_DIR = path.join(EVALS_DIR, "fixtures");
export const RESULTS_DIR = path.join(EVALS_DIR, "results");

export const LlmStepFixture = z.object({
  text: z.string(),
  toolCalls: z.array(
    z.object({
      toolCallId: z.string(),
      toolName: z.string(),
      // The tool input object (parsed, not the wire JSON string).
      input: z.object({ code: z.string() }),
    }),
  ),
  finishReason: z.string(),
});
export type LlmStepFixture = z.infer<typeof LlmStepFixture>;

export const WorkerCallFixture = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), code: z.string(), response: WorkerRenderResult }),
  z.object({ ok: z.literal(false), code: z.string(), error: z.string() }),
]);
export type WorkerCallFixture = z.infer<typeof WorkerCallFixture>;

export const RunMetrics = z.object({
  stepsUsed: z.number(),
  inputTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
  costUsd: z.number().nullable(),
  durationMs: z.number(),
});
export type RunMetrics = z.infer<typeof RunMetrics>;

export const Fixture = z
  .object({
    version: z.literal(1),
    caseId: z.string(),
    model: z.string(),
    systemPromptSha256: z.string(),
    recordedAt: z.string(),
    llmSteps: z.array(LlmStepFixture),
    workerCalls: z.array(WorkerCallFixture),
    score: CaseScore,
    metrics: RunMetrics,
  })
  .strict();
export type Fixture = z.infer<typeof Fixture>;

export function systemPromptSha256(): string {
  return createHash("sha256").update(SYSTEM_PROMPT).digest("hex");
}

/** Drop the STL payload: fixtures stay small and scoring never reads it. */
export function stripStl(response: WorkerRenderResult): WorkerRenderResult {
  return { ...response, stl_base64: "" };
}

export function modelSlug(model: string): string {
  return model.replace(/[^a-zA-Z0-9.-]+/g, "_");
}

export function fixturePath(caseId: string, model: string): string {
  return path.join(FIXTURES_DIR, `${caseId}.${modelSlug(model)}.json`);
}

export function saveFixture(fixture: Fixture): string {
  Fixture.parse(fixture); // refuse to write an invalid fixture
  mkdirSync(FIXTURES_DIR, { recursive: true });
  const file = fixturePath(fixture.caseId, fixture.model);
  writeFileSync(file, JSON.stringify(fixture, null, 2) + "\n");
  return file;
}

/** Load and schema-validate all committed fixtures. Throws on a stale/corrupt file. */
export function loadFixtures(): Fixture[] {
  let files: string[];
  try {
    files = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  return files.map((f) => {
    const raw = JSON.parse(readFileSync(path.join(FIXTURES_DIR, f), "utf8"));
    const parsed = Fixture.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`Invalid fixture ${f}: ${parsed.error.issues[0]?.message ?? "unknown"}`);
    }
    return parsed.data;
  });
}
