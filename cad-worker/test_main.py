"""Tests for the cad-worker sandbox and helpers.

Run with: see the Tests section of CONTRIBUTING.md (test deps are installed
into the container tmpfs at run time; WORKER_SECRET must be unset).
Or locally in the cadquery conda env: `pytest cad-worker/test_main.py`
"""
import os
import subprocess
import sys
import threading
import time

import pytest
from fastapi.testclient import TestClient
from main import (
    exec_user_code,
    validate_mesh,
    export_to_bytes,
    sanitize_error,
    SAFE_BUILTINS,
    _safe_import,
    MAX_ERROR_DETAIL_CHARS,
    app,
)

client = TestClient(app)


# --- Sandbox: blocked operations ---

@pytest.mark.parametrize("blocked_code", [
    "import os",
    "import sys",
    "import subprocess",
    "import socket",
    "from os import system",
    "from subprocess import Popen",
])
def test_sandbox_blocks_dangerous_imports(blocked_code):
    with pytest.raises(ImportError):
        exec_user_code(blocked_code + "\nresult = None")


def test_sandbox_blocks_exec_and_eval():
    assert "exec" not in SAFE_BUILTINS
    assert "eval" not in SAFE_BUILTINS
    assert "compile" not in SAFE_BUILTINS
    assert "open" not in SAFE_BUILTINS


def test_sandbox_blocks_attribute_traversal_via_getattr():
    # getattr and setattr were removed from builtins
    assert "getattr" not in SAFE_BUILTINS
    assert "setattr" not in SAFE_BUILTINS


def test_sandbox_allows_name_main_guard():
    # `__name__` is the one dunder user code may use: the canonical
    # `if __name__ == "__main__":` guard must not be rejected (SAFE_BUILTINS
    # provides it as the inert string "__main__").
    result, _ = exec_user_code(
        "import cadquery as cq\n"
        "if __name__ == '__main__':\n"
        "    result = cq.Workplane('XY').box(2, 2, 2)\n"
    )
    assert result is not None


def test_sandbox_blocks_builtins_access_entirely():
    # `__builtins__` is a dunder, so reading or mutating it is rejected at parse
    # time; the poisoning can't even run. The shared template stays intact and
    # a subsequent normal call still works.
    with pytest.raises(ValueError):
        exec_user_code("__builtins__.clear()\nresult = None")
    with pytest.raises(ValueError):
        exec_user_code("__builtins__['injected'] = 42\nresult = None")
    assert "len" in SAFE_BUILTINS
    result, _ = exec_user_code("result = len([1, 2, 3])")
    assert result == 3


# --- Sandbox: introspection escape-attempt resistance (security-critical) ---
# main.py removes `type`/`object`/`super` to break the classic CPython escape
# chain that walks subclasses to reach subprocess.Popen / os. These tests assert
# that behavior as runtime behavior, not just dict membership.

@pytest.mark.parametrize("escape_code", [
    "result = ().__class__.__bases__[0].__subclasses__()",  # tuple -> object -> walk
    "result = (1).__class__.__base__.__subclasses__()",
    "result = type(result).__mro__",
    "result = type('X', (), {})",        # 3-arg type() to synthesize a class
    "result = object.__subclasses__()",
    "result = super",
    "result = type",
    "result = object",
    "f = lambda: 0\nresult = f.__globals__['__builtins__']['open']",  # reach real open
])
def test_sandbox_blocks_introspection_escapes(escape_code):
    # Each is the head of a known sandbox-escape chain. It must raise (NameError
    # for removed builtins, AttributeError/TypeError/KeyError when the walk dead-
    # ends), never return a live os/subprocess reference.
    with pytest.raises((ValueError, NameError, AttributeError, TypeError, KeyError)):
        exec_user_code(escape_code)


@pytest.mark.parametrize("smuggle", [
    "import os.path",                  # submodule of a blocked top-level
    "__import__('os')",
    "__import__('subprocess')",
    "import cadquery.occ_impl\nimport os",  # an allowed import does not unlock os
])
def test_sandbox_blocks_import_smuggling(smuggle):
    # `import os.path` dead-ends in the import hook (ImportError); `__import__(...)`
    # is a dunder name rejected at parse time (ValueError). Both must be blocked.
    with pytest.raises((ImportError, ValueError)):
        exec_user_code(smuggle + "\nresult = None")


def test_safe_import_blocks_relative_imports():
    # Relative imports (level != 0) are rejected outright.
    with pytest.raises(ImportError):
        _safe_import("foo", level=1)


def test_sandbox_dangerous_callables_are_unreachable_by_name():
    # eval/exec/open/compile were never placed in the per-call builtins, so user
    # code can't name them even before any poisoning attempt.
    for name in ("eval", "exec", "open", "compile", "getattr", "setattr"):
        with pytest.raises(NameError):
            exec_user_code(f"result = {name}")


# --- Process isolation: timeouts, limits, state (render child processes) ---

@pytest.fixture
def short_timeout(monkeypatch):
    import main as worker_main
    monkeypatch.setattr(worker_main, "EXEC_TIMEOUT", 2)


def assert_timed_out(r):
    assert r.status_code == 400
    detail = r.json()["detail"]
    # The frontend and the LLM rely on this exact prefix.
    assert detail.startswith("Code execution timed out.")
    assert "2 seconds" in detail


def test_render_times_out_on_infinite_loop(short_timeout):
    assert_timed_out(client.post("/render", json={"code": "while True:\n    pass\nresult = None"}))


def test_timeout_kills_loop_that_catches_exception(short_timeout):
    # The old in-thread timeout raised an exception into the loop, which this
    # `except Exception` could swallow. A SIGKILL can't be caught.
    code = (
        "while True:\n"
        "    try:\n"
        "        x = sum(range(1000))\n"
        "    except Exception:\n"
        "        pass\n"
        "result = None\n"
    )
    assert_timed_out(client.post("/render", json={"code": code}))


def test_timeout_kills_busy_loop_that_swallows_everything(short_timeout):
    code = "n = 0\nwhile True:\n    try:\n        n += 1\n    except:\n        continue\nresult = None\n"
    assert_timed_out(client.post("/export-3mf", json={"code": code}))


def test_slot_freed_after_kill_and_capacity_enforced(short_timeout, monkeypatch):
    import main as worker_main
    monkeypatch.setattr(worker_main, "MAX_CONCURRENT_RENDERS", 1)
    hung = {}
    t = threading.Thread(target=lambda: hung.setdefault(
        "r", client.post("/render", json={"code": "while True:\n    pass\nresult = None"})))
    t.start()
    time.sleep(0.5)
    # The event loop stays responsive while the render hogs a CPU, /health
    # reports the occupied slot, and a second render is shed with 503.
    started = time.monotonic()
    h = client.get("/health")
    assert time.monotonic() - started < 1.5
    assert h.status_code == 200 and h.json()["inflight"] == 1
    box = 'result = cq.Workplane("XY").box(6, 6, 6)'
    assert client.post("/render", json={"code": box}).status_code == 503
    t.join()
    assert_timed_out(hung["r"])
    # The killed child released its slot.
    assert worker_main._inflight == 0
    assert client.post("/render", json={"code": box}).status_code == 200


def test_module_state_does_not_leak_between_requests():
    # Module objects are shared within a process; every request gets a fresh
    # process, so tampering dies with the request that did it.
    tamper = (
        "import math\n"
        "math.pi = 3\n"
        "cq.Workplane.box = None\n"
        "result = cq.Workplane('XY').circle(1).extrude(1)\n"
    )
    assert client.post("/render", json={"code": tamper}).status_code == 200
    r = client.post("/render", json={"code": "result = cq.Workplane('XY').box(math.pi, 1, 1)"})
    assert r.status_code == 200
    assert r.json()["metrics"]["bbox"]["x"] == 3.14


def test_memory_bomb_is_contained(monkeypatch):
    import main as worker_main
    monkeypatch.setattr(worker_main, "RENDER_MEMORY_MB", 256)
    r = client.post("/render", json={"code": "x = bytearray(2 * 1024 ** 3)\nresult = None"})
    assert r.status_code == 400
    assert "MemoryError" in r.json()["detail"]


def test_memory_bomb_that_swallows_memoryerror_is_killed(short_timeout, monkeypatch):
    import main as worker_main
    monkeypatch.setattr(worker_main, "RENDER_MEMORY_MB", 256)
    code = (
        "chunks = []\n"
        "while True:\n"
        "    try:\n"
        "        chunks.append(bytearray(32 * 1024 ** 2))\n"
        "    except Exception:\n"
        "        pass\n"
        "result = None\n"
    )
    assert_timed_out(client.post("/render", json={"code": code}))
    assert worker_main._inflight == 0


def test_threaded_native_code_works_under_memory_cap():
    # OCC booleans run on a thread per host core and numpy's BLAS is OpenMP:
    # without MALLOC_ARENA_MAX / *_NUM_THREADS in the forkserver environment,
    # per-thread reservations blow RLIMIT_AS and the child segfaults or aborts.
    code = (
        "a = np.ones((300, 300))\n"
        "assert float((a @ a).sum()) == 300.0 ** 3\n"
        "s = cq.Workplane('XY').box(60, 60, 5)\n"
        "for i in range(50):\n"
        "    s = s.cut(cq.Workplane('XY').center((i % 10) * 5 - 22, (i // 10) * 5 - 10).circle(1).extrude(5))\n"
        "result = s\n"
    )
    r = client.post("/render", json={"code": code})
    assert r.status_code == 200, r.json()


# Runs in the render child. numpy can read files, so this is what a curious
# script would try: its own environment, then the parent's.
_ENV_PROBE = (
    "import numpy as np\n"
    "def probe(path):\n"
    "    try:\n"
    "        data = np.loadtxt(path, dtype=bytes, delimiter='\\x01', comments=None)\n"
    "    except Exception:\n"
    "        return 'unreadable'\n"
    "    return 'LEAK' if b'SENTINEL' in data.tobytes() else 'clean'\n"
    "raise ValueError('self=' + probe('/proc/self/environ') + ' parent=' + probe('/proc/PARENT/environ'))\n"
)


def test_render_child_cannot_read_worker_secret():
    # A fresh interpreter, because the secret must be in the environment when
    # main is imported (the suite itself runs without one).
    script = (
        "import os, main\n"
        "from fastapi.testclient import TestClient\n"
        f"code = {_ENV_PROBE!r}.replace('PARENT', str(os.getpid()))\n"
        "r = TestClient(main.app).post('/render', json={'code': code},"
        " headers={'X-Worker-Secret': 'SENTINEL-secret'})\n"
        "print(r.json()['detail'])\n"
    )
    out = subprocess.run(
        [sys.executable, "-c", script],
        env={**os.environ, "WORKER_SECRET": "SENTINEL-secret"},
        cwd=os.path.dirname(os.path.abspath(__file__)),
        capture_output=True, text=True, timeout=120,
    )
    assert out.returncode == 0, out.stderr
    # The child's own environment is scrubbed (as root it is readable; as the
    # image's non-root user, non-dumpable /proc files aren't readable at all).
    # The parent's, which still holds the secret, is never readable.
    assert "self=clean" in out.stdout or "self=unreadable" in out.stdout, out.stdout
    assert "parent=unreadable" in out.stdout, out.stdout
    assert "LEAK" not in out.stdout


# --- Sandbox: allowed operations ---

def test_math_import_works():
    result, _ = exec_user_code("import math\nresult = math.pi")
    assert abs(result - 3.14159) < 0.001


def test_numpy_import_works():
    code = """
import numpy as np
result = float(np.array([1, 2, 3]).sum())
"""
    result, _ = exec_user_code(code)
    assert result == 6.0


def test_cadquery_import_and_box():
    code = """
import cadquery as cq
result = cq.Workplane("XY").box(10, 10, 10)
"""
    result, _ = exec_user_code(code)
    # Should be a Workplane with at least one solid
    assert result is not None


def test_cq_preloaded_in_globals():
    # `cq` should work without an explicit import
    code = 'result = cq.Workplane("XY").box(5, 5, 5)'
    result, _ = exec_user_code(code)
    assert result is not None


def test_missing_result_raises():
    with pytest.raises(ValueError, match="result"):
        exec_user_code("x = 42")


def test_comprehension_can_read_top_level_names():
    # exec() must use ONE namespace for globals and locals: with separate
    # dicts, comprehension bodies compile reads as global lookups and can't
    # see top-level parameters (`NameError: name 'size' is not defined`).
    # Parametric scripts pattern hole positions with exactly this shape.
    code = (
        "n = 3\n"
        "size = 10.0\n"
        "result = [size * i for i in range(n)]\n"
    )
    result, _ = exec_user_code(code)
    assert result == [0.0, 10.0, 20.0]


def test_function_can_read_top_level_names():
    # Same single-namespace requirement for helper functions.
    code = (
        "width = 20.0\n"
        "def half():\n"
        "    return width / 2\n"
        "result = half()\n"
    )
    result, _ = exec_user_code(code)
    assert result == 10.0


def test_stdout_is_captured():
    _, console = exec_user_code("print('hello')\nresult = None")
    assert "hello" in console


def test_user_print_does_not_touch_global_stdout(capsys):
    # Output is captured into the per-call buffer, never the process-global
    # sys.stdout (a redirect_stdout swap would corrupt that under concurrency).
    _, console = exec_user_code("print('isolated')\nresult = None")
    assert "isolated" in console
    assert "isolated" not in capsys.readouterr().out


def test_concurrent_stdout_does_not_cross_contaminate():
    # exec now runs on worker threads (asyncio.to_thread), so two requests can
    # exec concurrently. Output capture must be per-call, not via a process-global
    # sys.stdout swap, or one user's print() can leak into another's response.
    # A tiny switch interval forces the threads to interleave deterministically;
    # the old redirect_stdout approach would fail this (buffers cross-fill).
    import concurrent.futures
    import sys

    tags = [f"tag{i}" for i in range(4)]
    reps = 200

    def run(tag):
        code = f"for _ in range({reps}):\n    print('{tag}')\nresult = None"
        return tag, exec_user_code(code)[1]

    old_interval = sys.getswitchinterval()
    sys.setswitchinterval(1e-5)
    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=len(tags)) as pool:
            results = list(pool.map(run, tags))
    finally:
        sys.setswitchinterval(old_interval)

    for tag, console in results:
        # Each console contains exactly its own tag, none of the others.
        assert console.count(tag) == reps
        for other in tags:
            if other != tag:
                assert other not in console


# --- Export ---

def test_stl_export_produces_bytes():
    import cadquery as cq
    result = cq.Workplane("XY").box(10, 10, 10)
    data = export_to_bytes(result, "STL", ".stl")
    assert len(data) > 0
    # Binary STL starts with an 80-byte header; ASCII STL starts with "solid"
    assert data[:5] == b"solid" or len(data) >= 84


def test_3mf_export_produces_bytes():
    import cadquery as cq
    result = cq.Workplane("XY").box(10, 10, 10)
    data = export_to_bytes(result, "3MF", ".3mf")
    # 3MF is a ZIP archive, so starts with "PK"
    assert len(data) > 0
    assert data[:2] == b"PK"


# --- Mesh validation ---

def test_validate_mesh_clean_cylinder_no_thin_wall_warning():
    import cadquery as cq
    # A solid cylinder has no face pointing straight down (only the flat top
    # and bottom plus curved sides), and plenty of wall thickness.
    result = cq.Workplane("XY").circle(10).extrude(20)
    stl = export_to_bytes(result, "STL", ".stl")
    warnings = validate_mesh(stl)
    assert not any("thin" in w.lower() for w in warnings)
    # Must be watertight
    assert not any("watertight" in w.lower() for w in warnings)


def test_validate_mesh_flags_very_thin_geometry():
    import cadquery as cq
    # 10mm x 10mm x 0.5mm plate — below the 1.2mm threshold
    result = cq.Workplane("XY").box(10, 10, 0.5)
    stl = export_to_bytes(result, "STL", ".stl")
    warnings = validate_mesh(stl)
    assert any("thin" in w.lower() for w in warnings)


def test_validate_mesh_no_overhang_warning_for_flat_bottomed_box():
    import cadquery as cq
    # The bottom of a flat-bottomed part rests on the build plate: it must not
    # count as an overhang (it used to — 2 of a cube's 12 faces point straight
    # down, blowing the 5% threshold on every boxy part).
    result = cq.Workplane("XY").box(10, 10, 10)
    stl = export_to_bytes(result, "STL", ".stl")
    warnings = validate_mesh(stl)
    assert not any("overhang" in w.lower() for w in warnings)


def test_validate_mesh_flags_genuine_overhang():
    import cadquery as cq
    # Mushroom: narrow post with a wide flat cap. The cap's underside is a
    # large horizontal down-facing surface well above the plate.
    result = (
        cq.Workplane("XY").circle(5).extrude(20)
        .faces(">Z").workplane().circle(15).extrude(3)
    )
    stl = export_to_bytes(result, "STL", ".stl")
    warnings = validate_mesh(stl)
    assert any("overhang" in w.lower() for w in warnings)


def test_validate_mesh_flags_small_overhang_on_large_part():
    import cadquery as cq
    # A 15x10mm floating shelf on a 100x100 plate is <1% of the total surface
    # area, so the percentage threshold alone would dilute it away — the
    # absolute-area floor must still flag it (it fails mid-air regardless of
    # how big the rest of the part is).
    result = (
        cq.Workplane("XY").box(100, 100, 3, centered=(True, True, False))
        .union(cq.Workplane("XY").circle(4).extrude(20))
        .union(
            cq.Workplane("XY").workplane(offset=17)
            .center(10, 0).box(15, 10, 3, centered=(True, True, False))
        )
    )
    stl = export_to_bytes(result, "STL", ".stl")
    warnings = validate_mesh(stl)
    assert any("overhang" in w.lower() for w in warnings)


def test_validate_mesh_ignores_narrow_ring_ledge():
    import cadquery as cq
    # A snap-groove ceiling: a large-area but only 0.8mm-wide ring ledge inside
    # a box cavity. Narrow ledges bridge fine; the patch rule's width
    # discriminator must keep this quiet (its raw area exceeds the 100mm2
    # patch floor).
    outer = cq.Workplane("XY").box(50, 30, 20, centered=(True, True, False))
    inner = (cq.Workplane("XY").workplane(offset=2)
             .box(46, 26, 20, centered=(True, True, False)))
    ring_outer = (cq.Workplane("XY").workplane(offset=16)
                  .box(47.6, 27.6, 1.6, centered=(True, True, False)))
    ring_inner = (cq.Workplane("XY").workplane(offset=16)
                  .box(46, 26, 1.6, centered=(True, True, False)))
    result = outer.cut(inner).cut(ring_outer.cut(ring_inner))
    stl = export_to_bytes(result, "STL", ".stl")
    warnings = validate_mesh(stl)
    assert not any("overhang" in w.lower() for w in warnings)


# --- Error sanitization ---

def test_sanitize_error_strips_absolute_paths():
    msg = "BRep_API: command not done at /opt/conda/envs/cadquery/lib/python3.10/site-packages/OCP.py"
    assert "/opt/conda" not in sanitize_error(msg)
    assert "<path>" in sanitize_error(msg)


# --- FastAPI endpoints ---

def test_health_endpoint():
    r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["inflight"] == 0 and body["capacity"] >= 1


def test_render_requires_worker_secret_when_configured(monkeypatch):
    # Patch the module-level secret + the function that reads it.
    import main as worker_main
    monkeypatch.setattr(worker_main, "WORKER_SECRET", "expected-secret")
    code = 'import cadquery as cq\nresult = cq.Workplane("XY").box(5, 5, 5)'

    # No header -> 401
    r = client.post("/render", json={"code": code})
    assert r.status_code == 401

    # Wrong header -> 401
    r = client.post("/render", json={"code": code}, headers={"X-Worker-Secret": "wrong"})
    assert r.status_code == 401

    # Correct header -> 200 (real render)
    r = client.post("/render", json={"code": code}, headers={"X-Worker-Secret": "expected-secret"})
    assert r.status_code == 200


def test_render_no_secret_configured_allows_anonymous():
    # Local dev path: WORKER_SECRET unset -> requests pass through.
    # This is the default state in the test suite (no env var).
    import main as worker_main
    assert worker_main.WORKER_SECRET == ""
    code = 'import cadquery as cq\nresult = cq.Workplane("XY").box(4, 4, 4)'
    r = client.post("/render", json={"code": code})
    assert r.status_code == 200


def test_render_endpoint_success():
    code = 'import cadquery as cq\nresult = cq.Workplane("XY").box(10, 10, 10)'
    r = client.post("/render", json={"code": code})
    assert r.status_code == 200
    body = r.json()
    assert isinstance(body["stl_base64"], str) and len(body["stl_base64"]) > 100
    assert body["metrics"]["bbox"] == {"x": 10.0, "y": 10.0, "z": 10.0}


def test_render_endpoint_missing_result_variable():
    r = client.post("/render", json={"code": "x = 1"})
    assert r.status_code == 400
    assert "result" in r.json()["detail"].lower()


def test_render_endpoint_blocked_import_reports_error():
    code = "import os\nresult = None"
    r = client.post("/render", json={"code": code})
    assert r.status_code == 400
    assert "not allowed" in r.json()["detail"].lower()


def test_render_endpoint_code_too_long():
    r = client.post("/render", json={"code": "x" * 60_000})
    # Pydantic validation returns 422
    assert r.status_code in (400, 422)


def test_export_3mf_endpoint_success():
    code = 'import cadquery as cq\nresult = cq.Workplane("XY").box(5, 5, 5)'
    r = client.post("/export-3mf", json={"code": code})
    assert r.status_code == 200
    import base64
    data = base64.b64decode(r.json()["threemf_base64"])
    assert data[:2] == b"PK"


def test_render_cache_returns_same_result():
    code = 'import cadquery as cq\nresult = cq.Workplane("XY").box(7, 7, 7)'
    r1 = client.post("/render", json={"code": code})
    r2 = client.post("/render", json={"code": code})
    assert r1.status_code == 200 and r2.status_code == 200
    assert r1.json()["stl_base64"] == r2.json()["stl_base64"]


def test_render_passes_request_id_through():
    code = 'import cadquery as cq\nresult = cq.Workplane("XY").box(3, 3, 3)'
    r = client.post("/render", json={"code": code}, headers={"X-Request-Id": "abc123"})
    assert r.status_code == 200


# --- Degenerate result detection (DEGENERATE_VOLUME_MM3) ---

def test_render_endpoint_rejects_fully_cut_body():
    # A boolean cut that removes the entire body leaves zero solids -> ~0
    # volume. This must fail instead of shipping an empty STL.
    code = """
import cadquery as cq
box = cq.Workplane("XY").box(10, 10, 10)
cutter = cq.Workplane("XY").box(50, 50, 50)
result = box.cut(cutter)
"""
    r = client.post("/render", json={"code": code})
    assert r.status_code == 400
    assert "empty or degenerate" in r.json()["detail"]


def test_render_endpoint_rejects_2d_sketch_result():
    # A bare Workplane sketch (no extrude) has no solids -> ~0 volume, same
    # degenerate-result error as a fully-cut body.
    code = 'import cadquery as cq\nresult = cq.Workplane("XY").rect(10, 10)'
    r = client.post("/render", json={"code": code})
    assert r.status_code == 400
    assert "empty or degenerate" in r.json()["detail"]


def test_render_endpoint_accepts_solid_result_from_val():
    # `result` set to a cq.Solid (via .val()) is a valid, exportable body.
    # It must render AND report real metrics: a 0x0x0 bbox would mislead the
    # agent and silently skip the build-plate overflow check.
    code = 'import cadquery as cq\nresult = cq.Workplane("XY").box(10, 10, 10).val()'
    r = client.post("/render", json={"code": code})
    assert r.status_code == 200
    body = r.json()
    assert body["stl_base64"]
    assert body["metrics"]["bbox"] == {"x": 10.0, "y": 10.0, "z": 10.0}
    assert abs(body["metrics"]["volume"] - 1000.0) < 1.0


def test_render_endpoint_multi_solid_workplane_bbox_spans_all_solids():
    # Two disjoint solids on one Workplane stack. BoundBox.add returns a new
    # box (it does not mutate); the old un-assigned .add() call meant the
    # combined bbox silently collapsed to the first solid's.
    code = (
        "import cadquery as cq\n"
        "a = cq.Workplane('XY').box(10, 10, 5)\n"
        "result = a.add(cq.Workplane('XY').center(20, 0).box(10, 10, 5))\n"
    )
    r = client.post("/render", json={"code": code})
    assert r.status_code == 200
    assert abs(r.json()["metrics"]["bbox"]["x"] - 30.0) < 0.1


# --- Build volume overflow warnings (BUILD_VOLUME_MM) ---

def test_render_endpoint_warns_on_build_plate_overflow():
    # 300 x 300mm footprint exceeds the 256 x 256mm bed -> renders fine
    # (200), but with a build-plate-overflow warning attached.
    code = 'import cadquery as cq\nresult = cq.Workplane("XY").box(300, 300, 2)'
    r = client.post("/render", json={"code": code})
    assert r.status_code == 200
    warnings = r.json()["warnings"] or []
    assert any("Build plate overflow" in w for w in warnings)


def test_render_endpoint_warns_on_build_height_overflow():
    # Fits the bed on X/Y but exceeds the 256mm build height on Z.
    code = 'import cadquery as cq\nresult = cq.Workplane("XY").box(10, 10, 300)'
    r = client.post("/render", json={"code": code})
    assert r.status_code == 200
    warnings = r.json()["warnings"] or []
    assert any("Build height overflow" in w for w in warnings)
    assert not any("Build plate overflow" in w for w in warnings)


def test_render_endpoint_no_overflow_warning_for_small_part():
    # A part well within the bed must not carry the overflow warning.
    # (Warnings may be null, or a non-empty list without this warning.)
    code = 'import cadquery as cq\nresult = cq.Workplane("XY").box(10, 10, 10)'
    r = client.post("/render", json={"code": code})
    assert r.status_code == 200
    warnings = r.json()["warnings"] or []
    assert not any("Build plate overflow" in w for w in warnings)


# --- Error line numbers + truncation (_user_code_line, MAX_ERROR_DETAIL_CHARS) ---

def test_render_endpoint_reports_line_number_for_nameerror():
    code = (
        'import cadquery as cq\n'
        'box = cq.Workplane("XY").box(1, 1, 1)\n'
        'result = undefined_variable_xyz\n'
    )
    r = client.post("/render", json={"code": code})
    assert r.status_code == 400
    assert "Line 3" in r.json()["detail"]


def test_render_endpoint_syntax_error_reported():
    # Malformed Python on line 3. The SyntaxError comes from ast.parse in
    # assert_no_dunder_access, which passes filename="<string>" so
    # _user_code_line can attribute it to the user's script.
    code = 'import cadquery as cq\nbox = cq.Workplane("XY")\n!!!\n'
    r = client.post("/render", json={"code": code})
    assert r.status_code == 400
    detail = r.json()["detail"]
    assert "SyntaxError" in detail
    assert "Line 3" in detail


def test_render_endpoint_exports_assembly_to_stl():
    # The system prompt tells the model to use cq.Assembly() for multi-part
    # models, but cq.exporters.export() can't take an Assembly directly;
    # export_to_bytes flattens it to a compound first.
    code = (
        "import cadquery as cq\n"
        "a = cq.Workplane('XY').box(10, 10, 5)\n"
        "b = cq.Workplane('XY').box(10, 10, 5)\n"
        "result = (cq.Assembly()\n"
        "    .add(a, loc=cq.Location((0, 0, 0)))\n"
        "    .add(b, loc=cq.Location((20, 0, 0))))\n"
    )
    r = client.post("/render", json={"code": code})
    assert r.status_code == 200
    data = r.json()
    assert data["stl_base64"]
    # Two 10mm boxes 20mm apart on X -> combined bbox spans 30mm.
    assert abs(data["metrics"]["bbox"]["x"] - 30.0) < 0.1


def test_render_endpoint_truncates_long_error_detail():
    # ValueError is in SAFE_BUILTINS, so it's directly raisable in the
    # sandbox. A 5000-char message must be truncated to MAX_ERROR_DETAIL_CHARS.
    code = 'raise ValueError("x" * 5000)\n'
    r = client.post("/render", json={"code": code})
    assert r.status_code == 400
    detail = r.json()["detail"]
    assert detail.endswith("... [truncated]")
    assert len(detail) <= MAX_ERROR_DETAIL_CHARS + 20
