# Audit: correctness, CAD and 3D-printing practices (2026-08-01)

Scope: the CAD pipeline end to end — `cad-worker/main.py`, the agent system
prompt (`src/lib/cad-agent.ts`), render/export plumbing (`src/lib/`,
`src/app/api/`), the viewer (`src/components/ThreeDViewer.tsx`), the
parameters panel, the design-session state machinery, and the eval harness.

Method: code review plus **empirical verification** — every system-prompt
example and every suspected geometry/mesh-check defect below was executed
against real CadQuery + trimesh in a scratch venv, and the eval fixtures in
`evals/fixtures/` were used as production evidence. Claims marked *verified*
were reproduced, not inferred.

---

## High severity

### H1. The overhang warning fires on essentially every model (verified)

`validate_mesh` (`cad-worker/main.py:317-327`) counts every face whose normal
is within 45° of straight down — **including the bottom faces resting on the
build plate**. A plain 10 mm cube scores 16.7 % "problem" faces (verified),
well over the 5 % threshold, so the flat-bottomed parts the system prompt
itself recommends ("Design with flat bottom for printing") are flagged.

Production evidence: 17 of 24 recorded eval fixtures carry an overhang
warning, including `vented-lid` — a flat 3 mm plate with zero real overhangs
("Overhang warning: 14–25 % of faces…").

Impact is not cosmetic: the agent is instructed to fix warnings "when severe",
so it burns its 5-step tool budget chasing phantom overhangs, and users learn
to ignore the design review entirely — which then also buries the genuine
warnings (non-watertight, thin walls).

Secondary defect: the metric is triangle-*count*-weighted, so it is biased by
tessellation density — a curved body dilutes the same physical overhang into
thousands of small triangles while a boxy part concentrates it into a few.

**Fix (verified):** exclude faces whose vertices all sit within an epsilon of
`z_min` (they rest on the plate), and weight by face *area*, not count. With
that change a cube scores 0 % and a genuine mushroom-shaped overhang scores
27 %. Consider also reporting the worst overhang angle so the agent knows how
bad it is.

### H2. Two system-prompt examples drill holes that are silently absent (verified)

`Workplane.hole()` bores along the workplane's **negative** normal. Both the
"Hollow enclosure" example (`src/lib/cad-agent.ts:200-208`) and the "Polar
flange" example (`cad-agent.ts:339-348`) drill from
`.faces("<Z").workplane(invert=True)` — a bottom workplane with the normal
flipped to +Z — so the bore goes *downward, away from the part*, and cuts
nothing.

Verified by executing both examples: solid volume before vs. after the
`.hole()` calls is **identical (0 mm³ removed)** in both cases. The enclosure
example produces bosses with no screw holes; the flange example produces a
flange with no bolt holes. Both render "successfully", pass the watertight
check, and report plausible bounding boxes — exactly the class of silent
geometric error nothing downstream can catch.

This matters doubly because in-context examples are the strongest signal the
model gets, and `polar-flange` is one of the two "hard" eval cases.

**Fix (verified):** drill from the *non-inverted* bottom workplane (normal
−Z, bore +Z, upward through the part):

```python
.faces("<Z").workplane().pushPoints(boss_positions).hole(screw_d + clearance)
.faces("<Z").workplane().polarArray(bolt_circle_d / 2, 0, 360, bolt_count).hole(bolt_hole_d)
```

Verified to remove exactly the expected material (690 mm³ / 523 mm³).
Keep `workplane(invert=True)` for the boss *extrusion* (extrude follows
+normal); only the `.hole()` calls must not use it.

### H3. The ventilation-grid example crashes outright (verified)

`cad-agent.ts:245-264`: `slot_l = 15` with `spacing = 5` places slots at a
5 mm pitch that is 3× shorter than the slot length, so slots overlap and the
outermost slots reach exactly the plate edge (positions span 45 mm + 15 mm
slot length = 60 mm = full plate width). Executing the example verbatim fails
in OCC with `Standard_ConstructionError: gp_Dir2d() - input vector has zero
norm` — it never renders. Even if the pitch collision were survived, the
merged full-width slits would sever the plate into disconnected strips, and
the trailing `.edges("|Z").fillet(2)` exceeds the viable radius on the 3 mm
webs.

**Fix:** make the x-pitch exceed the slot length plus a web (e.g. slots
15 mm long on a 20 mm x-pitch, 5 mm y-pitch), keep the pattern envelope
inside `width - 2*margin`, and fillet before cutting per the prompt's own
Pitfall #2.

### H4. The viewer's build plate is drawn as a vertical wall (ThreeDViewer.tsx:113)

The scene is Z-up (`camera.up = [0,0,1]`, STL used in CAD coordinates).
`planeGeometry` natively lies in the XY plane facing +Z — already correct for
a Z-up floor — but the plate mesh applies `rotation={[-Math.PI/2, 0, 0]}`,
which tips it into the XZ plane: a vertical white wall through the model,
facing +Y. The two `gridHelper`s *do* need their `Math.PI/2` X-rotation
(gridHelper is XZ-native, Y-up convention); the plane does not. It has gone
unnoticed because `#f5f5f5` against the `#f9fafb` page background is nearly
invisible — which also means the plate never renders under the part and
`receiveShadow` does nothing.

**Fix:** remove the rotation on the plate mesh (leave the gridHelpers as-is).

---

## Medium severity

### M1. Snap-fit example: bead misses the groove by 0.6 mm (verified arithmetic)

`cad-agent.ts:266-324`. With the lid flipped and seated on the rim, the bead
occupies z ∈ [17.0, 18.6] while the groove is z ∈ [16.4, 18.0] — the bead's
top 0.6 mm lands in solid wall (0.65 mm interference per side), so the lid
sits proud or crushes. The bead height should be positioned as
`bead_z = lid_t + groove_below_rim` (= 4.5), not
`lid_t + lip_h - groove_below_rim - bead_h` (= 3.9). The current formula only
coincides with the correct one when `lip_h == 2*groove_below_rim + bead_h`.
Snap-fit is the other "hard" eval case; the worked example should model the
joint correctly.

### M2. Phone-stand example: geometry extends 33 mm below the base (verified)

`cad-agent.ts:210-230`. The back/lip rects are centered at local
y = `thickness/2` on XZ workplanes, so the ~71 mm back panel spans global
z ∈ [−33.2, +38.2] while the base bottom is at z = −2.5 (verified bbox).
Nothing in the result realizes the advertised 70° angle either — `angle` only
inflates `back_height`. The example renders watertight and passes eval-style
bbox ranges, i.e. it is another silently-wrong worked example.

### M3. `compute_metrics` reports a 0×0×0 bounding box for `cq.Solid`/`cq.Compound` results

`cad-worker/main.py:252-297` only measures `Workplane` and `Assembly`. A
script ending in `.val()` (explicitly supported — see
`test_render_endpoint_accepts_solid_result_from_val`) renders fine but the
agent is told "Bounding box: 0.0x0.0x0.0mm", which corrupts its iterative
reasoning, and the build-plate overflow warning is skipped entirely.
`_total_solid_volume` already has the `hasattr(result, "Solids")` branch;
`compute_metrics` should mirror it.

### M4. Build-volume check ignores Z

Both the worker warning (`main.py:570-575`) and the prompt's hard constraint
check X/Y against 256 mm only. The Bambu envelope is 256³; a 300 mm-tall part
passes silently. Add the Z bound in both places.

### M5. "Download 3MF" can export geometry the user has never seen

`ViewerPane.tsx:41-60`: STL download uses `displayedStl` (last rendered), but
3MF export posts `workingCode` — with a dirty working copy (slider moved, not
re-rendered) the 3MF is built from *unrendered* code, so the printed part can
differ from the on-screen model. Gate 3MF on a clean working copy, or
re-render first (and surface that), so the two exports and the viewer agree.

### M6. Print exports use CadQuery's coarse default tessellation (0.1 mm)

`export_to_bytes` (`main.py:475`) calls `cq.exporters.export()` with default
`tolerance=0.1, angularTolerance=0.1`. At 0.1 mm chordal deviation a Ø5 mm
hole becomes a visibly faceted polygon and prints undersized beyond the
intended 0.2–0.3 mm clearance budget. Slicer-bound meshes are conventionally
exported at 0.01–0.02 mm. Recommend `tolerance=0.01` for the STL/3MF export
path (preview can stay coarse for speed if size matters — but note the same
STL feeds the viewer today).

### M7. Basis patching leaves stale metrics/summary attached to the edited code

`next-turn.ts:35` replaces only `output.code` on the newest successful tool
result. The same output still carries `summary` ("Render OK. Bounding box:
…"), `metrics`, and `warnings` from the *pre-edit* render, so the agent
reasons about dimensions that no longer describe the basis. Neutralize or
drop those fields when the code is patched (e.g. summary → "user-edited code,
not yet rendered").

### M8. Re-render race can attach a stale preview STL to newer working code

`design-session.tsx:95-121`: `rerender()` guards against the *agent* moving on
(`codeAtStart = currentCodeRef.current`) but not against the *working copy*
changing while the request is in flight. Sliders stay enabled during a
re-render (`ParametersPanel` disables only the button), so drag → rerender →
drag again lands the pre-drag STL as the preview for the post-drag code.
Snapshot `workingCode` at start and discard the response if it changed.

### M9. Thin-wall estimate misfires on small solid parts

`main.py:340-346`: `2·V/A` is a shell heuristic; for a solid cube it evaluates
to `side/3`, so any solid part under ~3.6 mm across gets a spurious "Thin
walls detected (~1.0mm)" (while the separate min-bbox check correctly stays
quiet above 1.2 mm). Conversely one thin wall among thick ones averages out
(false negative). Worth either scoping the check to shell-like parts
(A·t ≈ 2V only holds there) or labeling it explicitly as an estimate for
hollow parts.

---

## Low severity / polish

- **L1** `design-session.tsx:72` — working-copy reset is keyed on the code
  *value*: if a new successful render emits byte-identical code (agent reverts
  the user's edit), the user's stale working copy is never reset.
  `latestToolMessageId` is the correct reset key.
- **L2** `design-session.tsx:91` — `workingStl` is not dropped when the user
  edits back to exactly `currentCode`: `isModified` goes false but the viewer
  keeps showing the edited model's STL.
- **L3** `use-current-design.ts:40` / `MessageList.tsx` — the "live" editor is
  identified by message id, but a multi-step turn puts several `runCadquery`
  parts in one assistant message; two successful renders in one turn produce
  two editors both bound to `workingCode`. Track the part index too.
- **L4** `render-cad/route.ts` returns **500** for user code errors (a typo in
  the editor is a client error, not a server fault). Return 400/422 so
  monitoring stays meaningful.
- **L5** `evals/replay.test.ts:76` — the `expect(code).toBe(recorded.code)`
  inside `callWorker` is swallowed: `renderCad` catches all worker throws and
  converts them to `{success:false}`, so a plumbing mismatch can replay green.
  Record the mismatch and assert after `generateText` returns.
- **L6** `evals/run.ts:72-75` — `--model`/`--case` with a missing value push
  `undefined` (then `openrouter(undefined)` / "run every case");
  `run.ts:304-308` — the cost-cap `break` exits only the case loop, so every
  remaining model prints a misleading `0/0 passed` report.
- **L7** `rate-limit.ts:17-18` — the "HMR guard" is dead code: the flag is
  module-scoped, so each re-evaluation registers another 5-minute interval.
  Park the flag on `globalThis` (dev-only leak).
- **L8** `streaming-code.ts:18-22` — when a stream chunk ends mid-escape
  (trailing lone `\` or partial `\u00…`), `JSON.parse` fails and the raw
  slice renders with literal `\n`/`\"` for one frame. Truncate to the last
  complete escape before parsing.
- **L9** `cad-worker/Dockerfile` — `conda install cadquery` is unpinned while
  every pip dependency is pinned. The geometry kernel is the one dependency
  whose behavior (booleans, fillets, tessellation) silently drifts across
  versions; pin `cadquery=X.Y` (and rebuild fixtures when bumping).
- **L10** The "Box with mounting holes" example (`cad-agent.ts:154-168`)
  drills holes and *then* runs `.edges("|Z").fillet(3)`, contradicting the
  prompt's own Pitfall #2 (fillet before cut). It happens to succeed today
  (verified), but the canonical example should model the order the rules
  demand.
- **L11** `parameters.ts` — anything matching `angle|rot|tilt` is forced to
  integer steps (a 22.5° taper can't be dialed back in), and typed values are
  silently clamped to the inferred max (e.g. width 60 → cap 130). Consider
  allowing typed values to widen the range.

## Recommended (cross-cutting)

**Render the system-prompt examples in CI.** Three of the eight worked
examples are broken in ways the pipeline cannot catch (H2 silently missing
holes, H3 crash, M1/M2 wrong geometry). A tiny pytest that executes each
example through `exec_user_code` + `_render_pipeline` and asserts
render-success plus a coarse expected bbox/volume delta (e.g. "flange with
holes has less volume than without") would have caught all of them, and will
keep future prompt edits honest. The eval fixtures validate what the *model*
writes; nothing currently validates what the *prompt* teaches.

---

## Addendum: found while fixing (same day)

Two additional defects surfaced while verifying the fixes for the findings
above:

- **H5. Sandbox exec breaks Python scoping for comprehensions and helper
  functions (verified).** `exec_user_code` ran `exec(code, exec_globals,
  local_env)` with *separate* globals and locals. Top-level assignments land
  in locals, but comprehension bodies and function bodies compile their reads
  as global lookups — so `[size * i for i in range(n)]` or a helper function
  reading a top-level parameter dies with `NameError`, even though the same
  script is valid as a module. Parametric scripts pattern hole positions with
  exactly this shape (the prompt's own ventilation-grid example does), so the
  agent has been silently burning self-correction steps on phantom NameErrors.
  Fix: execute with a single per-call namespace (`exec(code, exec_globals)`),
  which restores real module semantics without weakening per-request isolation.

- **M10. Hollow-enclosure example: bosses tangent to the cavity walls
  tessellate non-watertight (verified).** With `boss_positions` at
  `width/2 - 5` and `boss_od = 6`, each boss is exactly tangent to two wall
  faces; the knife-edge seam makes the exported STL non-watertight at any
  tessellation tolerance. Insetting the bosses 1 mm clear of the walls
  produces a clean watertight mesh.

### Status

The follow-up commits on this branch fix H1–H5, M1–M8, M10, L4, and L10, with
regression tests (worker: overhang false-positive/true-positive, `.val()`
metrics, Z-height overflow, comprehension/function scoping; frontend:
basis-patch neutralization). Every system-prompt example was re-executed
against real CadQuery after the edits: all render warning-free with the
expected geometry (holes present, vent slots cut, snap-fit bead landing
exactly in its groove). Still open: M9 (thin-wall heuristic scoping), L1–L3
and L5–L11, and the "render the prompt examples in CI" recommendation.

### Code-review round (same day)

An adversarial review of the fix commit surfaced and this branch now also
fixes:

- The area-weighted overhang metric could dilute away a small genuine
  overhang on a large part (a 15×10mm shelf on a 100×100 plate is 0.7% of the
  surface — verified silent). Added a connected-patch rule: warn when a patch
  exceeds 100mm² AND ~2mm effective width (2·area/perimeter), which still
  keeps narrow printable ledges (snap-groove ceilings) quiet.
- The `render-cad` 500→400 change had blanketed *worker outages and 503
  load-shedding* as client errors; the route now classifies by the worker's
  status (worker 4xx → 400, 503 → 503, unreachable/timeout/5xx → 502).
- The 3MF dirty-export gate toasted "your code didn't render" for benign
  skips (render already in flight) and duplicated the real error toast; it
  now distinguishes the cases and lets `rerender()`'s own toast stand.
- `rerender()` silently discarded a response when the working copy changed
  mid-flight, ending the spinner with a stale preview; it now loops and
  renders the newest working copy, and the staleness refs are written
  synchronously (the effect-mirror lag left a race window).
- The rewritten phone-stand example pivoted the lean angle at the lip top
  instead of the base floor, overshooting 70° as ~72.4°; formula corrected
  (and re-verified).
- Unifying the metrics/volume type dispatch (`_solids_of`) exposed a latent
  pre-existing bug: `BoundBox.add()` returns a new box (doesn't mutate), so
  multi-solid results reported only the first solid's bbox. Fixed with a
  regression test.
- The edited-basis summary string moved next to `CadqueryToolResult`
  (`EDITED_BASIS_SUMMARY`) with the outgoing-projection contract documented.

Reviewed and measured, no change: the 0.02mm export tolerance's claimed
5–11× payload/CPU blowup does not materialize (vase STL 214→295 KiB, export
24→27 ms; the 0.1 rad angular tolerance bounds curved-surface refinement).

## What's in good shape

- **Sandbox layering** (`cad-worker/main.py`): AST-level dunder rejection +
  builtins allowlist + import hook + non-root container is a thoughtful
  defense-in-depth stack, with honest comments about where the real trust
  boundary is, and strong test coverage of escape chains.
- **Degenerate-volume rejection** (`DEGENERATE_VOLUME_MM3`) — failing a
  zero-volume "success" so the LLM self-corrects instead of shipping an empty
  STL is exactly right, and `_total_solid_volume`'s None-vs-0.0 discipline is
  carefully reasoned.
- **Protocol validation at both seams** (pydantic `response_model` + Zod
  parse) prevents silent drift between worker and app.
- **Z-up viewer convention** matches CAD/printing convention (camera up,
  gizmo, grid — modulo H4), and STL bytes are kept out of the model context
  (`toModelOutput` + `strip-stl.ts`) with the cost rationale documented.
- **The single render pipeline** (`cad-render.ts`) fixing the
  normalize-on-one-path-only bug, and punctuation normalization for
  LLM-typographic output, are good hard-won lessons kept.
- **Eval design**: recorded fixtures + hermetic replay in CI, sorted-bbox
  orientation-robust assertions, and honest "hard case" labeling are a
  genuinely good harness. (The scoring's `watertight` regex correctly targets
  only solidity warnings, which conveniently insulates it from H1's noise.)
- **Prompt engineering practice**: parameters-block convention (which powers
  the slider panel), fillet-order and shell-fragility pitfalls, material
  shrinkage/clearance table, and print-orientation comments are solid,
  current 3D-printing guidance.
