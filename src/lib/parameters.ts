/**
 * Parse top-level numeric parameters from CadQuery code and modify them.
 *
 * Convention: the LLM's system prompt asks for a `# PARAMETERS` block at the
 * top of the file with `name = value  # unit` assignments. We detect any
 * top-level `name = <numeric>` assignment that comes before the first
 * non-trivial statement (ignoring imports, comments, blanks).
 */

export interface Parameter {
  name: string;
  value: number;
  /** 0-indexed source line */
  line: number;
  /** Trailing comment without the leading `#`, trimmed. e.g. "mm" or "mm - M3 clearance" */
  comment: string;
  /** First token of the comment when it looks like a unit ("mm", "deg", ...), else "" */
  unit: string;
  /** Comment with the leading unit/separator stripped, e.g. "M3 clearance" */
  description: string;
  isInteger: boolean;
  min: number;
  max: number;
  step: number;
}

// Matches: `name = 12.5  # comment`, `name = -3  # mm`, `name = 1e-4  # mm`
// Captures: (indent)(name)(value)(comment). Value supports decimals and exponent form.
const ASSIGN_RE = /^(\s*)([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(-?\d+\.?\d*(?:[eE][+-]?\d+)?)\s*(#.*)?$/;

const UNIT_TOKENS = /^(mm|cm|m|in|deg|rad|°)$/i;

function splitComment(comment: string): { unit: string; description: string } {
  if (!comment) return { unit: "", description: "" };
  const first = comment.split(/[\s,-]/)[0];
  if (UNIT_TOKENS.test(first)) {
    const description = comment.replace(/^(mm|cm|m|in|deg|rad|°)\s*[-:,]?\s*/i, "").trim();
    return { unit: first, description };
  }
  return { unit: "", description: comment };
}

// A "trivial" line that doesn't terminate the parameters region.
const IMPORT_RE = /^\s*(import|from)\s+/;
const BLANK_OR_COMMENT_RE = /^\s*(#.*)?$/;

function inferRange(name: string, value: number): Pick<Parameter, "min" | "max" | "step" | "isInteger"> {
  const lower = name.toLowerCase();

  // Angles: 0-360 degrees
  if (/(^|_)(angle|deg|rot|rotation|tilt)($|_)/.test(lower) || lower.endsWith("_deg")) {
    return { min: 0, max: 360, step: 1, isInteger: true };
  }

  // Integer counts
  if (/(^|_)(count|num|n|sides|teeth|segments|steps|rows|cols)($|_)/.test(lower)) {
    return { min: 1, max: Math.max(50, Math.ceil(value * 3)), step: 1, isInteger: true };
  }

  const absVal = Math.abs(value);

  // Small values (<1): typically clearances, tolerances
  if (absVal < 1 && absVal > 0) {
    return { min: 0, max: Math.max(1, absVal * 2), step: 0.01, isInteger: false };
  }

  // Zero default: give a sensible range to drag into
  if (value === 0) {
    return { min: 0, max: 10, step: 0.1, isInteger: false };
  }

  // Negative generic: range extends below zero so the current value is in-range
  if (value < 0) {
    const rawStep = absVal / 100;
    const step = roundStep(Math.max(rawStep, 0.01));
    return { min: Math.min(value * 2, value - 10), max: 0, step, isInteger: false };
  }

  // Positive generic: 0 to 2x (or value + 10, whichever is larger)
  const max = Math.max(value * 2, value + 10);
  const rawStep = value / 100;
  const step = roundStep(Math.max(rawStep, 0.01));
  return { min: 0, max, step, isInteger: false };
}

/** Round step to a clean 1/2/5 value at its order of magnitude. */
function roundStep(raw: number): number {
  if (raw >= 1) return Math.round(raw);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  if (norm < 1.5) return 1 * mag;
  if (norm < 3.5) return 2 * mag;
  if (norm < 7.5) return 5 * mag;
  return 10 * mag;
}

/**
 * Parse parameters from the top of a CadQuery script.
 * Stops at the first non-trivial statement.
 */
export function parseParameters(code: string): Parameter[] {
  const lines = code.split("\n");
  const params: Parameter[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Skip blanks and pure-comment lines
    if (BLANK_OR_COMMENT_RE.test(line)) continue;
    // Skip imports
    if (IMPORT_RE.test(line)) continue;

    const match = line.match(ASSIGN_RE);
    if (!match) {
      // First non-trivial, non-parameter statement: stop.
      break;
    }

    const [, , name, valueStr, rawComment] = match;
    const value = parseFloat(valueStr);
    if (!Number.isFinite(value)) continue;

    const comment = rawComment ? rawComment.replace(/^#\s*/, "").trim() : "";
    const { unit, description } = splitComment(comment);
    const range = inferRange(name, value);

    params.push({
      name,
      value,
      line: i,
      comment,
      unit,
      description,
      ...range,
    });
  }

  return params;
}

/**
 * Replace a parameter's value in the source code. Preserves all surrounding
 * whitespace and comment by swapping the number literal in place.
 * Returns the original code unchanged if the parameter isn't found.
 */
export function setParameter(code: string, name: string, newValue: number): string {
  const lines = code.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = ASSIGN_RE.exec(line);
    if (match && match[2] === name) {
      // The value literal is capture group 3. Its start position in the line
      // equals the combined length of groups 1 (indent) + 2 (name) + the `=` +
      // any whitespace between `=` and the value. Rather than recompute that,
      // use indexOf starting past the name to find the value literal.
      const valueLiteral = match[3];
      const searchFrom = match[1].length + match[2].length;
      const valueStart = line.indexOf(valueLiteral, searchFrom);
      lines[i] = line.slice(0, valueStart) + formatValue(newValue) + line.slice(valueStart + valueLiteral.length);
      return lines.join("\n");
    }
  }
  return code;
}

function formatValue(value: number): string {
  if (Number.isInteger(value)) return value.toString();
  // Trim trailing zeros after 2-3 significant decimals
  return Number(value.toFixed(3)).toString();
}
