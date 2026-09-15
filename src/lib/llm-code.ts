// Typographic punctuation that LLMs occasionally emit and that Python's
// tokenizer rejects as SyntaxError (em-dash, en-dash, smart quotes, etc.).
//
// Only non-ASCII characters belong here. A plain ASCII character (the backtick,
// for instance) can legitimately appear inside a Python string literal, and
// rewriting it would silently change the user's text.
const PUNCTUATION_MAP: Record<string, string> = {
  "‐": "-", "‑": "-", "‒": "-",
  "–": "-", "—": "-", "−": "-",
  "“": '"', "”": '"',
  "´": "'", "‘": "'", "’": "'",
  "…": "...",
  " ": " ",
};
const PUNCTUATION_RE = new RegExp(`[${Object.keys(PUNCTUATION_MAP).join("")}]`, "g");

export function normalizePunctuation(s: string): string {
  return s.replace(PUNCTUATION_RE, ch => PUNCTUATION_MAP[ch]);
}
