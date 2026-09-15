# Overhang

Chat-driven parametric CAD: the user describes a part, an LLM agent writes CadQuery code and calls a Python worker to render it, and the user can hand-edit the result. This file names the concepts that recur across the chat/design code so they stay consistent.

## Language

### The design

**Design Session**:
The module that owns "the design the user is currently looking at" across one chat thread — the current design, the working copy, and the basis for the next turn. Lives behind one interface (a hook + context) so the panes read it instead of the orchestrator threading state.
_Avoid_: design store, editor state, design manager.

**Current design**:
The CadQuery code and STL derived from the latest successful `runCadquery` tool call in the thread. Purely derived from the message stream; never stored.
_Avoid_: agent output, last render, latest code.

**Working copy**:
The user's editable code and its preview STL, layered on top of the current design. Empty until the user edits a parameter or the code; reset to the current design whenever the agent emits new code.
_Avoid_: draft, override, edited code, `stlOverride`.

**Basis**:
The code the next turn builds on: the working copy when it is modified, otherwise the current design. Projected into the outgoing request by `forNextTurn` so the agent builds on the user's edits instead of silently discarding them.
_Avoid_: context code, prompt code, request code.

**Re-render**:
Running the working copy through `/api/render-cad` to get a preview STL, without involving the agent. Distinct from an agent turn, which produces a new current design.
_Avoid_: refresh, manual render, preview.

### The agent

**Agent turn**:
One user message answered by the CAD agent: the model runs up to `MAX_AGENT_STEPS` steps calling `runCadquery` (each call renders on the CAD worker), and the turn ends with a text reply. Built only by `runAgentTurn` (`src/lib/agent-turn.ts`), which owns the system prompt, step cap, text-only final step, per-model provider options, first-step web search, output cap, turn timeout, the worker liveness check, and the abort that reaches the worker. Callers pass the model and worker adapters and one `onSettled` callback; the route streams the turn, the eval runner and fixture replay drain the same stream.
_Avoid_: generation, agent loop, agent run, request.

### Flagged ambiguities

- **"Modified"** means the working copy differs from the current design (`isModified`). It does not mean "saved" — there is no save; a modified working copy simply becomes the basis for the next turn.
- **Displayed STL** is the working copy's STL when present, else the current design's STL. It is a derivation, not a fourth piece of state.

## Example dialogue

> **Dev:** After the agent renders a bracket, the user drags the wall-thickness slider and hits re-render. What are they looking at now?
> **Domain:** The **working copy** — same **current design** underneath, but their edited code and its preview STL sit on top. The **displayed STL** is the working copy's.
> **Dev:** Then they type "make it taller". What does the agent get?
> **Domain:** The **basis** — since the working copy is modified, `forNextTurn` patches the outgoing messages so the agent builds on the edited code. The agent's reply is a fresh **current design**, and the working copy resets to it.
> **Dev:** And if they hadn't touched anything?
> **Domain:** The working copy is empty, so the basis is just the current design. Nothing to carry forward.
