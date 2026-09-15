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
export const MAX_AGENT_STEPS = 5;
