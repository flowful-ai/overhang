import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import type { LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { MAX_AGENT_STEPS } from "@/components/chat/constants";
import { openRouterModel, runAgentTurn, type AgentWorker } from "@/lib/agent-turn";
import {
  WEB_SEARCH_MAX_RESULTS,
  webSearchEnabledOnServer,
  webSearchEnvWarning,
  webSearchProviderOptions,
} from "@/lib/web-search";
import { MODELS, modelSupportsWebSearch } from "@/lib/utils";
import { SYSTEM_PROMPT, WEB_SEARCH_OFF_NOTE, WEB_SEARCH_ON_NOTE, systemPromptForTurn } from "@/lib/cad-agent";
import { createGenerateCadPost } from "@/app/api/generate-cad/handler";
import {
  WEB_SEARCH_STORAGE_KEY,
  loadWebSearchPreference,
  saveWebSearchPreference,
  webSearchToggleState,
} from "@/components/chat/web-search-preference";

// Web search: the server switch, the per-model setting, first-step-only
// options in the agent turn (checked on the HTTP body OpenRouter receives), the
// request flag in the handler, and the user's stored preference.

const LUNA = "openai/gpt-5.6-luna";
const CUBE = "import cadquery as cq\nresult = cq.Workplane().box(10,10,10)";
const NATIVE_SEARCH = {
  plugins: [{ id: "web", engine: "native", max_results: WEB_SEARCH_MAX_RESULTS }],
  web_search_options: { search_context_size: "low" },
};

const worker: AgentWorker = {
  ping: async () => true,
  render: async () => ({
    stl_base64: "STL",
    warnings: [],
    console_output: null,
    metrics: { bbox: { x: 10, y: 10, z: 10 }, volume: 1000 },
  }),
};

// --- OpenRouter over a stubbed fetch -------------------------------------

type Body = Record<string, unknown>;

/** A streamed chat completion that calls runCadquery once. */
function toolCallSse(): Response {
  const chunk = (payload: object) => `data: ${JSON.stringify({ id: "gen", object: "chat.completion.chunk", created: 1, model: LUNA, ...payload })}\n\n`;
  const sse =
    chunk({
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              { index: 0, id: `call-${Math.random()}`, type: "function", function: { name: "runCadquery", arguments: JSON.stringify({ code: CUBE }) } },
            ],
          },
          finish_reason: null,
        },
      ],
    }) +
    chunk({
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }) +
    "data: [DONE]\n\n";
  return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** Stubs global fetch; every request body OpenRouter would receive is recorded. */
function stubOpenRouter(respond: () => Response = toolCallSse) {
  const bodies: Body[] = [];
  const fetchStub = vi.fn(async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return respond();
  });
  vi.stubGlobal("fetch", fetchStub);
  return { bodies, fetchStub };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function drainTurn(modelId: string, webSearch: boolean, onSettled?: () => void) {
  const turn = await runAgentTurn({
    model: openRouterModel(modelId, "test-key"),
    prompt: "Multiboard holder",
    worker,
    requestId: "web-search-http",
    webSearch,
    onSettled,
  });
  if (!turn.ok) throw new Error("turn refused");
  const errors: unknown[] = [];
  for await (const part of turn.stream.fullStream) if (part.type === "error") errors.push(part.error);
  return errors;
}

describe("webSearchEnabledOnServer", () => {
  it.each([undefined, "", "on", "1", "true", "ON", " True "])("is on for WEB_SEARCH=%s", (value) => {
    expect(webSearchEnabledOnServer({ WEB_SEARCH: value })).toBe(true);
    expect(webSearchEnvWarning({ WEB_SEARCH: value })).toBeNull();
  });

  it.each(["off", "0", "false", "OFF"])("is off, without a warning, for WEB_SEARCH=%s", (value) => {
    expect(webSearchEnabledOnServer({ WEB_SEARCH: value })).toBe(false);
    expect(webSearchEnvWarning({ WEB_SEARCH: value })).toBeNull();
  });

  it.each(["no", "disabled", "yes", "enabled", "2"])("fails closed and warns for unrecognised WEB_SEARCH=%s", (value) => {
    expect(webSearchEnabledOnServer({ WEB_SEARCH: value })).toBe(false);
    expect(webSearchEnvWarning({ WEB_SEARCH: value })).toContain("is not recognised");
  });
});

describe("webSearchProviderOptions", () => {
  it("enables native search only for the models verified live", () => {
    const enabled = MODELS.filter((m) => webSearchProviderOptions(m.id) !== undefined).map((m) => m.id);
    expect(enabled).toEqual([LUNA]);
    expect(webSearchProviderOptions(LUNA)).toEqual({ openrouter: NATIVE_SEARCH });
  });

  it("leaves search off for a model that is not listed", () => {
    expect(webSearchProviderOptions("some/eval-candidate")).toBeUndefined();
  });

  it("keeps max_results low", () => {
    expect(WEB_SEARCH_MAX_RESULTS).toBeLessThanOrEqual(5);
  });
});

describe("runAgentTurn web search, on the HTTP body", () => {
  it("sends the web plugin on the first request only, never on later steps or the text-only last step", async () => {
    const { bodies } = stubOpenRouter();
    expect(await drainTurn(LUNA, true)).toEqual([]);

    expect(bodies).toHaveLength(MAX_AGENT_STEPS);
    expect(bodies[0]).toMatchObject(NATIVE_SEARCH);
    for (const body of bodies.slice(1)) {
      expect(body).not.toHaveProperty("plugins");
      expect(body).not.toHaveProperty("web_search_options");
    }
    expect(bodies[0].tool_choice).toBe("auto");
    expect(bodies[MAX_AGENT_STEPS - 1].tool_choice).toBe("none");
  });

  it("sends no search options when the turn has web search off", async () => {
    const { bodies } = stubOpenRouter();
    await drainTurn(LUNA, false);
    for (const body of bodies) expect(body).not.toHaveProperty("plugins");
  });

  it.each(MODELS.filter((m) => m.id !== LUNA).map((m) => m.id))(
    "sends no search options for %s, where search is off",
    async (modelId) => {
      const { bodies } = stubOpenRouter();
      await drainTurn(modelId, true);
      expect(bodies.length).toBeGreaterThan(0);
      for (const body of bodies) expect(body).not.toHaveProperty("plugins");
    },
  );

  it("fails the turn cleanly when the first, search-enabled request is rejected", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { bodies, fetchStub } = stubOpenRouter(
      () =>
        new Response(JSON.stringify({ error: { message: "web plugin rejected", code: 400 } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
    );
    const onSettled = vi.fn();
    const errors = await drainTurn(LUNA, true, onSettled);

    expect(fetchStub).toHaveBeenCalledOnce();
    expect(bodies[0]).toMatchObject(NATIVE_SEARCH);
    expect(errors).toHaveLength(1);
    expect(onSettled).toHaveBeenCalledOnce();
    errorSpy.mockRestore();
  });
});

describe("generate-cad web search switches, on the HTTP body", () => {
  const postWith = (webSearchAvailable?: () => boolean) =>
    createGenerateCadPost({
      model: () => openRouterModel(LUNA, "test-key"),
      worker,
      ...(webSearchAvailable ? { webSearchAvailable } : {}),
    });

  async function send(post: ReturnType<typeof postWith>, extra: object) {
    const res = await post(
      new Request("http://localhost/api/generate-cad", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": `5.5.5.${Math.floor(Math.random() * 254) + 1}`,
        },
        body: JSON.stringify({
          messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "Multiboard holder" }] }],
          ...extra,
        }),
      }),
    );
    const text = res.body ? await new Response(res.body).text() : "";
    return { status: res.status, text };
  }

  beforeEach(() => vi.stubEnv("TRUST_PROXY", "1"));

  // The production wiring (route.ts) reads the env on every request.
  const fromEnv = () => webSearchEnabledOnServer();

  it("searches when the server allows it and the request asks for it", async () => {
    const { bodies } = stubOpenRouter();
    expect((await send(postWith(fromEnv), { webSearch: true })).status).toBe(200);
    expect(bodies[0]).toMatchObject(NATIVE_SEARCH);
    expect(bodies[1]).not.toHaveProperty("plugins");
  });

  it("treats an omitted flag as on", async () => {
    const { bodies } = stubOpenRouter();
    await send(postWith(fromEnv), {});
    expect(bodies[0]).toMatchObject(NATIVE_SEARCH);
  });

  it("does not search when the request turns it off", async () => {
    const { bodies } = stubOpenRouter();
    await send(postWith(fromEnv), { webSearch: false });
    for (const body of bodies) expect(body).not.toHaveProperty("plugins");
  });

  it.each(["off", "no"])("does not search when WEB_SEARCH=%s, whatever the request says", async (value) => {
    vi.stubEnv("WEB_SEARCH", value);
    const { bodies } = stubOpenRouter();
    await send(postWith(fromEnv), { webSearch: true });
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) expect(body).not.toHaveProperty("plugins");
  });

  it("does not search when no server switch is wired", async () => {
    const { bodies } = stubOpenRouter();
    await send(postWith(), { webSearch: true });
    for (const body of bodies) expect(body).not.toHaveProperty("plugins");
  });

  it.each(["yes", 1, null])("rejects a non-boolean webSearch (%s) with 400 before any model call", async (value) => {
    const { fetchStub } = stubOpenRouter();
    expect((await send(postWith(fromEnv), { webSearch: value })).status).toBe(400);
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("streams a sanitized error when the search-enabled first request fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    stubOpenRouter(
      () =>
        new Response(JSON.stringify({ error: { message: "plugin failed at /opt/app/search/engine.py", code: 400 } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
    );
    const { status, text } = await send(postWith(fromEnv), { webSearch: true });
    expect(status).toBe(200);
    expect(text).toContain('"type":"error"');
    expect(text).toContain("<path>");
    expect(text).not.toContain("/opt/app");
    errorSpy.mockRestore();
  });
});

describe("runAgentTurn web search step options (mock model)", () => {
  type DoStream = (options: LanguageModelV3CallOptions) => Promise<{ stream: ReadableStream<LanguageModelV3StreamPart> }>;
  const USAGE = {
    inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 1, text: 1, reasoning: undefined },
  } as const;

  it("adds search to step 0 only and leaves the other steps' options alone", async () => {
    let i = 0;
    const doStream = vi.fn<DoStream>(async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "stream-start", warnings: [] },
          { type: "tool-call", toolCallId: `c${i++}`, toolName: "runCadquery", input: JSON.stringify({ code: CUBE }) },
          { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage: USAGE },
        ],
      }),
    }));
    const turn = await runAgentTurn({
      model: new MockLanguageModelV3({ modelId: LUNA, doStream }),
      prompt: "make a cube",
      worker,
      requestId: "mock",
      webSearch: true,
    });
    if (!turn.ok) throw new Error("turn refused");
    await turn.stream.consumeStream();
    const options = doStream.mock.calls.map(([o]) => o.providerOptions);
    expect(options[0]).toEqual({ openrouter: NATIVE_SEARCH });
    expect(options.slice(1)).toEqual(Array(MAX_AGENT_STEPS - 1).fill(undefined));
  });
});

describe("per-turn system prompt", () => {
  type DoStream = (options: LanguageModelV3CallOptions) => Promise<{ stream: ReadableStream<LanguageModelV3StreamPart> }>;

  async function systemFor(modelId: string, webSearch: boolean) {
    const doStream = vi.fn<DoStream>(async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "stream-start", warnings: [] },
          {
            type: "finish",
            finishReason: { unified: "stop", raw: undefined },
            usage: {
              inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
              outputTokens: { total: 1, text: 1, reasoning: undefined },
            },
          },
        ] as LanguageModelV3StreamPart[],
      }),
    }));
    const turn = await runAgentTurn({
      model: new MockLanguageModelV3({ modelId, doStream }),
      prompt: "make a cube",
      worker,
      requestId: "system",
      webSearch,
    });
    if (!turn.ok) throw new Error("turn refused");
    await turn.stream.consumeStream();
    const system = doStream.mock.calls[0][0].prompt.find((m) => m.role === "system");
    return system?.content as string;
  }

  it("tells the model search is available when the turn has it", async () => {
    const system = await systemFor(LUNA, true);
    expect(system.startsWith(SYSTEM_PROMPT)).toBe(true);
    expect(system).toContain(WEB_SEARCH_ON_NOTE);
    expect(system).not.toContain(WEB_SEARCH_OFF_NOTE);
  });

  it.each([
    ["the request has search off", LUNA, false],
    ["the model has no search", "anthropic/claude-sonnet-5", true],
  ])("tells the model not to cite unretrieved sources when %s", async (_label, modelId, webSearch) => {
    const system = await systemFor(modelId, webSearch);
    expect(system.startsWith(SYSTEM_PROMPT)).toBe(true);
    expect(system).toContain(WEB_SEARCH_OFF_NOTE);
    expect(system).not.toContain(WEB_SEARCH_ON_NOTE);
    expect(WEB_SEARCH_OFF_NOTE).toMatch(/never cite/i);
  });

  it("scopes both notes to parts that must fit a real product, standard or mounting system", () => {
    for (const note of [WEB_SEARCH_ON_NOTE, WEB_SEARCH_OFF_NOTE]) {
      expect(note).toContain("must fit a real product, standard or mounting system");
    }
    expect(WEB_SEARCH_ON_NOTE).toMatch(/do not search for generic parts/i);
  });

  it("keeps SYSTEM_PROMPT itself free of the per-turn note", () => {
    expect(SYSTEM_PROMPT).not.toContain(WEB_SEARCH_ON_NOTE);
    expect(SYSTEM_PROMPT).not.toContain(WEB_SEARCH_OFF_NOTE);
    expect(systemPromptForTurn(true)).not.toBe(systemPromptForTurn(false));
  });
});

describe("web search toggle state", () => {
  it("follows the stored preference when the server and model allow search", () => {
    expect(webSearchToggleState({ serverAvailable: true, modelSupported: true, preference: true })).toEqual({
      checked: true,
      disabled: false,
      hint: "Looks up real product dimensions",
    });
    expect(webSearchToggleState({ serverAvailable: true, modelSupported: true, preference: false }).checked).toBe(false);
  });

  it.each([true, false])("shows disabled and off for a model without search (preference %s)", (preference) => {
    expect(webSearchToggleState({ serverAvailable: true, modelSupported: false, preference })).toEqual({
      checked: false,
      disabled: true,
      hint: "Not available for this model",
    });
  });

  it("gives the server switch precedence over the model", () => {
    expect(webSearchToggleState({ serverAvailable: false, modelSupported: false, preference: true })).toEqual({
      checked: false,
      disabled: true,
      hint: "Disabled on this server",
    });
  });

  it("matches MODELS: only models with search enable the switch", () => {
    for (const m of MODELS) {
      expect(modelSupportsWebSearch(m.id)).toBe(webSearchProviderOptions(m.id) !== undefined);
    }
    expect(modelSupportsWebSearch("some/eval-candidate")).toBe(false);
  });
});

describe("web search preference", () => {
  function memoryStorage(initial: Record<string, string> = {}) {
    const data = new Map(Object.entries(initial));
    return {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      data,
    };
  }

  it("defaults to on", () => {
    expect(loadWebSearchPreference(() => memoryStorage())).toBe(true);
  });

  it("round-trips off and on", () => {
    const storage = memoryStorage();
    saveWebSearchPreference(false, () => storage);
    expect(storage.data.get(WEB_SEARCH_STORAGE_KEY)).toBe("off");
    expect(loadWebSearchPreference(() => storage)).toBe(false);
    saveWebSearchPreference(true, () => storage);
    expect(loadWebSearchPreference(() => storage)).toBe(true);
  });

  it("falls back to on and does not throw when storage is unavailable", () => {
    const blocked = () => {
      throw new Error("SecurityError");
    };
    expect(loadWebSearchPreference(blocked)).toBe(true);
    expect(() => saveWebSearchPreference(false, blocked)).not.toThrow();
  });
});
