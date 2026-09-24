import { describe, it, expect } from "vitest";
import { sanitizeError, toSanitizedMessage } from "@/lib/sanitize-error";

describe("sanitizeError", () => {
  it("strips conda env absolute paths from CadQuery/OCC errors", () => {
    const raw =
      "BRep_API: command not done at /opt/conda/envs/cadquery/lib/python3.10/site-packages/OCP.py";
    const out = sanitizeError(raw);
    expect(out).not.toContain("/opt/conda");
    expect(out).toContain("<path>");
    expect(out).toContain("BRep_API");
  });

  it("strips paths without file extension", () => {
    const out = sanitizeError("error in /usr/local/lib/python3.10/foo");
    expect(out).toContain("<path>");
    expect(out).not.toContain("/usr/local/lib");
  });

  it("keeps division in the model's code intact", () => {
    const raw = "ValueError at line 4: box(width/2, (a + b)/2, h /2, pts[0]/2, 1.5/2)";
    expect(sanitizeError(raw)).toBe(raw);
  });

  it("strips quoted traceback paths", () => {
    expect(sanitizeError('File "/srv/app/worker.py", line 5')).toBe('File "<path>", line 5');
  });

  it("is a no-op on messages without paths", () => {
    expect(sanitizeError("ValueError: result must be defined")).toBe(
      "ValueError: result must be defined",
    );
  });
});

describe("toSanitizedMessage", () => {
  it("extracts and sanitizes Error.message", () => {
    const err = new Error("BRep failed at /opt/conda/lib/foo.py");
    const out = toSanitizedMessage(err);
    expect(out).toContain("BRep failed");
    expect(out).not.toContain("/opt/conda");
  });

  it("falls back to String() on non-Error values", () => {
    expect(toSanitizedMessage("plain string")).toBe("plain string");
    expect(toSanitizedMessage(42)).toBe("42");
    expect(toSanitizedMessage(null)).toBe("null");
  });

  it("sanitizes the stringified form of unknown values containing paths", () => {
    const obj = { toString: () => "fail at /home/user/secret.py" };
    expect(toSanitizedMessage(obj)).not.toContain("/home/user/secret.py");
  });
});
