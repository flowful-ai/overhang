"""Every worked example in the agent's system prompt must render and build
what it claims. In-context examples are the strongest signal the model gets:
two of them once drilled holes that were silently absent and one crashed
(docs/audit-2026-08-01-cad-correctness.md, H2 and H3).

The examples are read from SYSTEM_PROMPT in src/lib/cad-agent.ts (the
"## Examples" section, one "### <title>" per example), run through
_render_pipeline, and checked against EXPECTED below. Adding, renaming or
removing an example fails test_every_example_has_expectations until EXPECTED
is updated.

Needs the repo checkout (the TS source). The Docker test run in
CONTRIBUTING.md only mounts cad-worker/, so the tests skip there unless CI is
set, where a missing file is a failure.
"""
import os
import re
from pathlib import Path

import pytest

from main import _render_pipeline

AGENT_TS = Path(__file__).resolve().parent.parent / "src" / "lib" / "cad-agent.ts"


def _examples() -> dict[str, str]:
    if not AGENT_TS.exists():
        if os.environ.get("CI"):
            pytest.fail(f"{AGENT_TS} not found")
        pytest.skip("src/lib/cad-agent.ts is not available (worker-only checkout)")
    src = AGENT_TS.read_text()
    prompt = src[src.index("export const SYSTEM_PROMPT = `"):]
    prompt = prompt[: prompt.index("\n`;")]
    section = prompt[prompt.index("\n## Examples\n"):]
    parts = re.split(r"^### (.+)$", section, flags=re.M)[1:]
    examples = {}
    for title, body in zip(parts[::2], parts[1::2]):
        assert "${" not in body, f"example {title!r} interpolates a template value"
        # Undo template-literal escapes.
        examples[title.strip()] = body.replace("\\`", "`").replace("\\\\", "\\")
    return examples


def _solid_box_volume(bbox: dict) -> float:
    return bbox["x"] * bbox["y"] * bbox["z"]


# Per example: what its geometry must show. "max_fill" bounds volume /
# bounding-box volume, i.e. that the cuts and hollowing really removed
# material (a hole drilled into nothing leaves the block full).
EXPECTED = {
    "Box with mounting holes": {
        "solids": 1, "holes": {(3.5, True): 4}, "bbox": (60, 40, 5), "on_bed": True, "max_fill": 0.99,
    },
    "Hollow enclosure (boolean subtraction, preferred pattern)": {
        "solids": 1, "holes": {(2.8, True): 4}, "bbox": (80, 50, 30), "on_bed": True, "max_fill": 0.25,
    },
    "Phone stand with angle": {
        "solids": 1, "holes": {}, "on_bed": True,
    },
    "Revolved vase": {
        "solids": 1, "holes": {}, "min_wall": 3.0,
    },
    "Ventilation grid pattern": {
        "solids": 1, "holes": {}, "bbox": (60, 40, 3), "on_bed": True, "max_fill": 0.9,
    },
    "Snap-fit box with lid (two parts, printed side by side)": {
        "solids": 2, "holes": {}, "on_bed": True,
    },
    "Polar pattern: flange with bolt circle": {
        "solids": 1, "holes": {(4.3, True): 6, (10.0, True): 1}, "on_bed": True,
    },
}


def test_every_example_has_expectations():
    assert sorted(_examples()) == sorted(EXPECTED)


@pytest.mark.parametrize("title", sorted(EXPECTED))
def test_prompt_example_builds_what_it_claims(title):
    code = _examples()[title]
    expect = EXPECTED[title]
    out = _render_pipeline(code)
    geometry = out["geometry"]
    issues = out["issues"] or []

    assert not [i for i in issues if i["severity"] == "blocking"], issues
    assert geometry["valid"] is True
    assert geometry["solid_count"] == expect["solids"]

    holes: dict = {}
    for h in geometry["holes"]:
        key = (h["diameter"], h["through"])
        holes[key] = holes.get(key, 0) + h["count"]
    assert holes == expect["holes"]

    bbox = out["metrics"]["bbox"]
    if "bbox" in expect:
        assert (bbox["x"], bbox["y"], bbox["z"]) == pytest.approx(expect["bbox"], abs=0.05)
    if expect.get("on_bed"):
        assert abs(geometry["z_min"]) <= 0.1
    if "max_fill" in expect:
        assert out["metrics"]["volume"] / _solid_box_volume(bbox) <= expect["max_fill"]
    if "min_wall" in expect:
        assert geometry["min_wall_mm"] >= expect["min_wall"]
