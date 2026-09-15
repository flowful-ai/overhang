# Eval Results After Generation Fixes — 2026-07-02

Same 8-case suite as the [baseline](2026-07-02-baseline.md), run after the
generation fixes landed. Fixes applied between the runs:

1. `toModelOutput` on the shared `runCadquery` tool — the base64 STL no longer
   enters the model context on self-correction steps.
2. Worker: degenerate-body check (volume ~0 fails with an actionable error).
3. Worker: build-plate overflow (>256mm X/Y) as a structured warning.
4. Worker: error details carry the failing script line ("Line 39 of your
   script: StdFail_NotDone…") and are capped at 1500 chars; SyntaxErrors
   report their line too.
5. Worker: `cq.Assembly` exports to STL/3MF (was `AttributeError`); assembly
   metrics fixed (bbox/volume were always 0).
6. Prompt: two validated few-shot examples (snap-fit box + lid, polar
   bolt-circle flange).

## google/gemini-3-flash-preview — 8/8 (one case needed a retry)

| case | pass | warnings | steps | tokens in/out | cost | time |
|---|---|---|---|---|---|---|
| pi5-enclosure | ✅ | 1 | 2 | 10,651/1,018 | $0.0084 | 11.7s |
| l-bracket | ✅ | 1 | 5 | 32,209/1,899 | $0.0182 | 20.5s |
| phone-stand | ✅* | 0 | 3 | 18,028/1,590 | $0.0138 | 13.2s |
| cable-clip | ✅ | 1 | 5 | 38,008/3,596 | $0.0244 | 26.0s |
| vented-lid | ✅ | 1 | 5 | 30,082/1,876 | $0.0189 | 19.9s |
| vase | ✅ | 0 | 2 | 10,329/801 | $0.0076 | 7.5s |
| snap-fit-box (hard) | ✅ | 1 | 2 | 11,327/1,356 | $0.0097 | 10.3s |
| polar-flange (hard) | ✅ | 1 | 3 | 15,398/726 | $0.0099 | 9.3s |

Full suite: **~$0.11, ~2 minutes**. (The first phone-stand attempt in the full
run died to a local network drop; on re-run it first hit an intermittent
Gemini quirk — the tool call emitted as literal text
`call:default_api:runCadquery{…}` with `finish_reason: other` — then passed.
Same family of failure as gemini-2.5-flash's MALFORMED_FUNCTION_CALL, but
intermittent rather than total.)

## Baseline vs post-fix

| metric | baseline | post-fix |
|---|---|---|
| pi5-enclosure input tokens | 975,532 | 10,651 (**92× less**) |
| pi5-enclosure cost | $0.4910 | $0.0084 (**58× cheaper**) |
| full-suite run | aborted at 2 cases ($0.51, cost cap) | 8 cases, $0.11 |
| snap-fit-box (hard) | fail (Assembly couldn't export at all) | pass, 2 steps |
| polar-flange (hard) | n/a (run aborted) | pass, 3 steps |

Fix-by-fix honesty check:

- **STL out of context**: clearly the biggest win (the whole run now costs a
  fifth of what a single case cost before, and the model no longer wades
  through a megabyte of base64).
- **Assembly export + metrics**: snap-fit-box cannot pass without it; the
  system prompt recommends Assembly for multi-part and that path was simply
  broken.
- **Line numbers in errors**: visible in worker-only replay (the l-bracket
  baseline recording's three `StdFail_NotDone` failures now say "Line 39/40/43
  of your script"). Not isolated in the pass-rate delta.
- **Few-shot examples**: both hard cases pass, but they were not re-tested
  without the examples, so their individual contribution is unproven.
- **Degenerate-body check & build-plate warning**: neither fired in this run
  (no case triggers them); they're covered by pytest instead. They exist for
  failure modes seen in the wild, not in this suite.

## google/gemini-2.5-flash — still 0/8

MALFORMED_FUNCTION_CALL on every case, unchanged. Prompt-side fixes cannot
cure this; the model fails before reading the tool result. Recommendation
stands: remove it from the dropdown or find a tool-schema workaround.

## Fixtures

All 16 fixtures re-recorded post-fix (`evals/fixtures/`, prompt sha
`3bafd9d4…` — the baseline recordings were stale after the prompt change) and
replayed in CI: 129 vitest tests green.
