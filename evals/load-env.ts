import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

// Minimal .env loader, imported FIRST (for its side effect) by the eval CLI.
// It must run before src/lib/cad-worker.ts is evaluated: that module reads
// WORKER_SECRET and CAD_WORKER_URL into top-level consts at import time.
// Values already present in the shell environment win.

const envFile = path.join(process.cwd(), ".env");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}
