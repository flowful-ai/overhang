// Pull `code` out of a partial JSON tool-input string while it streams. The
// payload looks like `{"code":"import cadq` until streaming completes. Sync
// only — runs per render during streaming.
export function extractStreamingCode(argsText: string): string {
  if (!argsText) return "";
  const start = argsText.indexOf('"code":"');
  if (start === -1) return "";
  const valueStart = start + 8;
  // Walk forward looking for the unescaped closing quote.
  let i = valueStart;
  while (i < argsText.length) {
    const ch = argsText.charCodeAt(i);
    if (ch === 0x5c /* \ */) { i += 2; continue; }
    if (ch === 0x22 /* " */) break;
    i++;
  }
  const raw = argsText.slice(valueStart, i);
  try {
    return JSON.parse(`"${raw}"`);
  } catch {
    return raw;
  }
}
