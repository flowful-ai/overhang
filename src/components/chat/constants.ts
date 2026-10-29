// The AI-SDK tool name the agent route exposes. Must match the key in
// `tools: { runCadquery }` in src/lib/agent-turn.ts. Both the UI
// (to find the latest tool call in the thread) and the persistence layer
// (to strip large STL payloads before write) key off this string.
export const TOOL_NAME = "runCadquery";

// localStorage key for the chat thread + selected model.
export const STORAGE_KEY = "overhang-chat-state";

// Tool-call budget for one agent turn. The single source of truth shared by
// the server agent turn (the step cap in src/lib/agent-turn.ts) and
// the client progress label (deriveAgentProgress). Lives in this client-safe
// module so the browser bundle never pulls in the server prompt to read it.
//
// 8: the agent plans, renders, checks the result against its plan (geometry
// report and preview images) and fixes mismatches, so a turn that verifies
// needs ~2 more steps than one that stops at the first successful render. The
// last step has tools off, so up to 7 renders. Each step re-sends the
// conversation, so the extra steps cost input tokens only when the model uses
// them; AGENT_TURN_TIMEOUT_MS (agent-turn.ts) is sized for this cap.
export const MAX_AGENT_STEPS = 8;
