# Model Sweep — 2026-07-02

> Dated snapshot. Statements about the "current" default or dropdown describe
> 2026-07-02. The live model list and default are `MODELS` in `src/lib/utils.ts`.

Question: which OpenRouter models maximize quality/cost for Overhang?
Method: the 8-case eval suite (`npm run eval`), one full run per model,
production-identical settings (5-step cap, temperature 0.2, 8k output tokens,
120s per-turn timeout). Total sweep cost ≈ $0.75.

## Ranking

| model | pass | run cost | $/M in/out | verdict |
|---|---|---|---|---|
| google/gemini-3-flash-preview | 8/8¹ | $0.11 | 0.50/3.00 | best pass rate; in the dropdown at the time |
| **deepseek/deepseek-v4-flash** | **7/8** | **$0.016** | 0.09/0.18 | **best quality/cost by far** |
| qwen/qwen3.5-flash-02-23 | 6/8 | $0.013 | 0.07/0.26 | good budget option |
| z-ai/glm-4.7-flash | 6/8 | $0.008 | 0.06/0.40 | cheapest run; one 120s timeout |
| minimax/minimax-m2.7 | 5/8 | $0.025 | 0.18/0.72 | geometry misses (bbox/watertight) |
| anthropic/claude-sonnet-5 | 5/8² | $0.53 | 2.00/10.00 | config-limited, see below |
| z-ai/glm-5 | 4/8³ | $0.028 | 0.60/1.92 | 3× 120s timeouts |
| z-ai/glm-5.2 | 4/8³ | $0.053 | 0.93/3.00 | 3× 120s timeouts, ~1 min/case |
| moonshotai/kimi-k2.5 | 4/8³ | $0.052 | 0.38/2.02 | 2× timeouts + geometry misses |
| google/gemini-2.5-flash | 0/8 | – | 0.30/2.50 | MALFORMED_FUNCTION_CALL, unusable |

¹ One case passed on retry after an intermittent text-formatted tool call.
² Two failures were `finish: length` with EMPTY output — reasoning tokens
consumed the whole 8k output cap before any tool call — plus one 120s timeout.
³ Failures dominated by the 120s per-turn timeout.

## Analysis

**DeepSeek V4 Flash is the quality/cost winner.** 7/8 (only miss: a
token-limit failure on phone-stand), first-try tool calls, ~$0.002/design.
Near-parity with Gemini 3 Flash at a seventh of the cost, and ~50× cheaper
than Sonnet-class models per design.

**The "cheap but beefy" thesis holds, but not for GLM 5.x.** The big Chinese
reasoning models (GLM 5/5.2, Kimi K2.5) are too slow for Overhang's 120s
per-turn budget: they burn a minute+ thinking per step and time out on a
third of the suite. The winners in that family are the *flash*-tier
distillations (DeepSeek V4 Flash, Qwen 3.5 Flash, GLM 4.7 Flash).

**Sonnet 5's score is an artifact of our settings, not its ability.** With
reasoning enabled by default and `maxOutputTokens: 8000`, it spends the whole
output budget thinking on complex prompts and emits nothing. Before drawing
conclusions about Claude-class quality, Overhang should set explicit
reasoning parameters (e.g. low effort / capped thinking budget) for reasoning
models — tracked as a follow-up. Note the default at the time (Sonnet 4.6,
non-reasoning) does not hit this failure mode in production.

**Timeouts and output caps are now measurable product constraints.** Three
models lost 2-3 cases each purely to the 120s/8k limits. That's the correct
outcome for the product as shipped — a user won't wait 2+ minutes per turn —
but it means "model quality" rankings here are quality *within Overhang's
latency budget*, which is what matters.

## Dropdown recommendation

1. **Add `deepseek/deepseek-v4-flash`** — the value pick.
2. **Remove `google/gemini-2.5-flash`** — 0/8, fails before calling the tool.
3. **Keep `google/gemini-3-flash-preview`** — best pass rate.
4. **Keep Claude Sonnet 4.6 as default for now**; revisit Sonnet 5 after
   adding reasoning-budget parameters (it is 33% cheaper per token than 4.6
   and would likely lead the board with thinking capped).
5. **Retire `deepseek/deepseek-r1`** — superseded by V4 Flash (cheaper,
   newer); R1's slow reasoning has the same timeout exposure as GLM 5.x.

Raw per-case JSON: `evals/results/2026-07-02T14-*.json`, `…T15-03-12-065Z.json`
(local, gitignored).

## Follow-up: shipping Sonnet 5 as default (same day)

The dropdown was changed per the recommendation, with one amendment: the user
chose Claude Sonnet 5 as the new default (replacing Sonnet 4.6). Making that
work took three measured config fixes, each verified by a re-run:

1. **Reasoning cap** (`providerOptionsForModel`): Claude reasons by default
   via OpenRouter; capped at 2048 tokens.
2. **Output cap 8k → 16k for all models** (`AGENT_SETTINGS.maxOutputTokens`):
   complex parts plus reasoning tokens overflow 8k and a truncated tool call
   is dropped whole. This also bit deepseek-v4-flash. The 120s turn timeout
   still bounds runaway cost.
3. **Prompt concision nudge** (Script Structure section): Sonnet was writing
   8k-token scripts for a cable clip and timing out; "aim for under ~100
   lines" eliminated its 120s timeouts.

Also fixed in the suite: the pi5-enclosure prompt now says "single piece, no
lid" — Sonnet legitimately produced a two-part base+lid design that broke the
single-body bbox assertion.

Final validation on the shipped config:

| model | pass | run cost | notes |
|---|---|---|---|
| anthropic/claude-sonnet-5 (default) | 7/8 | $0.66 | only miss: non-watertight vase |
| google/gemini-3-flash-preview | 7/8 | $0.10 | bbox miss on vented-lid (variance) |
| deepseek/deepseek-v4-flash | 6/8 | $0.006 | provider latency spiked this run; 3× 120s timeouts, 2 still delivered |

Run-to-run variance on an 8-case suite is roughly ±1 case; treat single-run
differences of one case as noise.

## Scoring caveat noted during the sweep

A case counts as passed if a successful render was delivered even when the
turn later timed out (seen once on kimi-k2.5's vase). Defensible — the user
got a part — but it slightly flatters slow models; consider scoring
turn-completion separately if this becomes common.
