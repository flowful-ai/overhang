from fastapi import FastAPI, HTTPException, Request, Header
from pydantic import BaseModel, field_validator
from fastapi.middleware.cors import CORSMiddleware
from typing import Optional
import ast
import builtins
import cadquery as cq
import trimesh
import numpy as np
import math
import tempfile
import os
import base64
import secrets
import io
import logging
import re
import hashlib
import traceback
import asyncio
import ctypes
import threading
from collections import OrderedDict
from contextlib import contextmanager

# Ensure module-level logger output is visible (uvicorn's default config does
# not propagate application loggers by default).
logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logger = logging.getLogger(__name__)

app = FastAPI()

# CORS configuration - restrict in production by setting ALLOWED_ORIGINS env var
# Example: ALLOWED_ORIGINS=https://myapp.com,https://www.myapp.com
allowed_origins_str = os.environ.get("ALLOWED_ORIGINS", "*")
if allowed_origins_str == "*":
    allowed_origins = ["*"]
else:
    allowed_origins = [origin.strip() for origin in allowed_origins_str.split(",")]

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=False,
    allow_methods=["POST"],
    allow_headers=["Content-Type"],
)

# Execution timeout (in seconds)
EXEC_TIMEOUT = int(os.environ.get("EXEC_TIMEOUT", "30"))

# Shared secret with the Next.js frontend. Required on every /render and
# /export-3mf request so that nothing else on the docker network (including a
# sandbox-escaped Python process) can drive arbitrary CadQuery execution.
# CORS is browser-only and doesn't help against curl-from-inside-the-network.
WORKER_SECRET = os.environ.get("WORKER_SECRET", "")


def require_worker_secret(provided: Optional[str]) -> None:
    """Constant-time check of the X-Worker-Secret header. Raises 401 on mismatch."""
    if not WORKER_SECRET:
        # No secret configured: fall through (local dev, tests). docker-compose.yml
        # refuses to start without WORKER_SECRET, so Compose installs always set it.
        return
    if not provided or not secrets.compare_digest(provided, WORKER_SECRET):
        raise HTTPException(status_code=401, detail="Unauthorized")

# --- Sandboxed exec() environment ---
# Allowlisted modules that LLM-generated code may import.
# Dangerous modules (os, subprocess, socket, sys, etc.) are blocked.
ALLOWED_MODULES = {
    "math": math,
    "cadquery": cq,
    "numpy": np,
    "itertools": __import__("itertools"),
    "functools": __import__("functools"),
    "collections": __import__("collections"),
}

_REAL_IMPORT = __import__


def _safe_import(name, globals=None, locals=None, fromlist=(), level=0):
    if level != 0:
        raise ImportError("Relative imports are not allowed")
    # Allow submodules of allowed top-level modules (numpy.array() internally
    # loads numpy.core._methods, cadquery loads cadquery.occ_impl.*, etc.)
    top = name.partition(".")[0]
    if top not in ALLOWED_MODULES:
        raise ImportError(
            f"Import of '{name}' is not allowed. "
            f"Available: {', '.join(sorted(ALLOWED_MODULES))}"
        )
    if "." not in name:
        return ALLOWED_MODULES[name]
    return _REAL_IMPORT(name, globals, locals, fromlist, level)


# Note on sandbox depth: removing `type`, `object`, `super`, `property`,
# `staticmethod`, `classmethod`, and `id` prevents the classic
# `type.__subclasses__()` / `object.__subclasses__()` walk that reaches
# `subprocess.Popen` through loaded modules. The real trust boundary
# remains the Docker container (non-root, cap_drop, no-new-privileges).
SAFE_BUILTINS = {
    # Types and constructors
    "int": int, "float": float, "str": str, "bool": bool,
    "list": list, "dict": dict, "tuple": tuple, "set": set,
    "frozenset": frozenset, "bytes": bytes, "bytearray": bytearray,
    "complex": complex,
    "slice": slice, "range": range,
    # Numeric
    "abs": abs, "round": round, "min": min, "max": max,
    "sum": sum, "pow": pow, "divmod": divmod,
    "hex": hex, "oct": oct, "bin": bin,
    # Iteration
    "len": len, "enumerate": enumerate, "zip": zip,
    "map": map, "filter": filter, "sorted": sorted, "reversed": reversed,
    "iter": iter, "next": next, "all": all, "any": any,
    # String / repr
    "repr": repr, "format": format, "chr": chr, "ord": ord,
    "print": print, "hash": hash,
    # Type checking
    "isinstance": isinstance, "issubclass": issubclass,
    "callable": callable, "hasattr": hasattr,
    # Exceptions
    "Exception": Exception, "ValueError": ValueError,
    "TypeError": TypeError, "RuntimeError": RuntimeError,
    "StopIteration": StopIteration, "IndexError": IndexError,
    "KeyError": KeyError, "AttributeError": AttributeError,
    "ZeroDivisionError": ZeroDivisionError, "OverflowError": OverflowError,
    "ImportError": ImportError, "NotImplementedError": NotImplementedError,
    "ArithmeticError": ArithmeticError,
    # Controlled import
    "__import__": _safe_import,
    # Required for class definitions inside exec()
    "__build_class__": builtins.__build_class__,
    "__name__": "__main__",
}

# Non-builtins globals shared with every exec. `__builtins__` is added per
# call from a fresh copy of SAFE_BUILTINS so user code that mutates it (e.g.
# `__builtins__.clear()`) can only poison its own request, not later ones.
EXEC_BASE_GLOBALS = {
    "cq": cq,
    "cadquery": cq,
    "math": math,
    "np": np,
    "numpy": np,
}


def make_exec_globals() -> dict:
    return {"__builtins__": dict(SAFE_BUILTINS), **EXEC_BASE_GLOBALS}


class ExecTimeoutError(Exception):
    pass


def _async_raise(thread_id: int, exc_type: Optional[type]) -> None:
    """Asynchronously raise `exc_type` in the thread with the given id (or, if
    None, clear any pending async exception on it). Uses CPython's
    PyThreadState_SetAsyncExc; the exception is delivered at the next bytecode
    boundary in that thread, so it interrupts pure-Python loops but not a
    blocking C call already in progress (the previous SIGALRM timeout had the
    same limitation)."""
    arg = ctypes.py_object(exc_type) if exc_type is not None else None
    res = ctypes.pythonapi.PyThreadState_SetAsyncExc(ctypes.c_long(thread_id), arg)
    if res > 1:
        # Affected more than one thread state — undo to avoid corrupting others.
        ctypes.pythonapi.PyThreadState_SetAsyncExc(ctypes.c_long(thread_id), None)


@contextmanager
def timeout(seconds: int):
    """Interrupt the calling thread if the wrapped block runs longer than
    `seconds`. Unlike the previous SIGALRM implementation this works on any
    thread, so the request handlers can offload exec() onto a worker thread
    (via asyncio.to_thread) and keep the event loop responsive.
    """
    target_tid = threading.get_ident()
    lock = threading.Lock()
    finished = False

    def fire():
        with lock:
            if not finished:
                _async_raise(target_tid, ExecTimeoutError)

    timer = threading.Timer(seconds, fire)
    timer.start()
    try:
        yield
    except ExecTimeoutError:
        raise ExecTimeoutError(f"Code execution timed out after {seconds} seconds")
    finally:
        # Take the lock FIRST and clear before anything else: if fire() already
        # scheduled an async exception (under the lock) but it hasn't landed, the
        # lock.acquire() here blocks in C (not interruptible by the async exc),
        # and clearing as the first statement minimizes the window in which a
        # stray ExecTimeoutError could surface in unrelated later code on this
        # (pooled) worker thread.
        with lock:
            finished = True
            _async_raise(target_tid, None)
        timer.cancel()

MAX_CODE_LENGTH = 50_000

class RenderRequest(BaseModel):
    code: str

    @field_validator("code")
    @classmethod
    def validate_code_length(cls, v: str) -> str:
        if len(v) > MAX_CODE_LENGTH:
            raise ValueError(f"Code exceeds maximum length of {MAX_CODE_LENGTH} characters")
        return v


# Wire-format response models. Kept in sync with WorkerRenderResult and
# WorkerThreeMFResult in src/lib/cad-worker-protocol.ts. FastAPI's
# response_model validates outgoing payloads against these shapes, so the
# Python side fails loudly if the dict drifts, and the TS side fails loudly
# at the seam (Zod parse). Two enforcement points, one contract.
class BBox(BaseModel):
    x: float
    y: float
    z: float


class WorkerMetricsModel(BaseModel):
    bbox: BBox
    volume: float


class RenderResponse(BaseModel):
    stl_base64: str
    metrics: WorkerMetricsModel
    warnings: Optional[list[str]] = None
    console_output: Optional[str] = None


class ThreeMFResponse(BaseModel):
    threemf_base64: str
    console_output: Optional[str] = None

def _solids_of(result) -> Optional[list]:
    """All solids in a result, or None when the type isn't measurable.
    Assembly solids are measured as placed (toCompound applies Locations)."""
    if isinstance(result, cq.Workplane):
        return result.solids().vals()
    if isinstance(result, cq.Assembly):
        return result.toCompound().Solids()
    if hasattr(result, "Solids"):
        # cq.Solid / cq.Compound / cq.Shape (e.g. from a .val() call).
        return result.Solids()
    return None


def compute_metrics(result) -> tuple[dict, Optional[float]]:
    """Bounding box and total solid volume (mm3, unrounded) of a result.

    Volume is None when it couldn't be measured confidently: an unknown result
    type, or a geometry call that raised. That is deliberate — the degenerate
    check in _render_pipeline must only ADD a rejection for a provably-empty
    body, never reject a result that would otherwise export fine, so it needs
    to distinguish "measured 0.0" from "couldn't measure".
    """
    bbox = {"x": 0, "y": 0, "z": 0}
    try:
        solids = _solids_of(result)
        if solids is None:
            return bbox, None
        volume = sum(s.Volume() for s in solids)
        if solids:
            boxes = [s.BoundingBox() for s in solids]
            combined = boxes[0]
            for b in boxes[1:]:
                # BoundBox.add returns the expanded box; it does not mutate.
                combined = combined.add(b)
            bbox = {
                "x": round(combined.xlen, 2),
                "y": round(combined.ylen, 2),
                "z": round(combined.zlen, 2)
            }
        return bbox, volume
    except Exception:
        return bbox, None


# Faces whose vertices all sit within this height of the mesh's lowest point
# count as resting on the build plate for the overhang check.
PLATE_CONTACT_EPSILON_MM = 0.05

# Overhang warning triggers. Faces are "problem" faces beyond
# OVERHANG_MAX_ANGLE_DEG from vertical. The percentage catches broadly
# overhung designs. The patch rule catches a small genuine overhang on a large
# part (e.g. a 15x10mm shelf on a 100x100 plate is <1% of the surface but
# still fails mid-air): a connected overhang patch is flagged when it is both
# large AND wide. Width (~2*area/perimeter, an inradius estimate) is the
# discriminator that keeps narrow printable ledges quiet: a snap-bead groove
# ceiling is a >100mm2 ring but only ~0.8mm across, and prints fine.
OVERHANG_MAX_ANGLE_DEG = 45.0
OVERHANG_PCT_THRESHOLD = 5.0
OVERHANG_PATCH_MIN_AREA_MM2 = 100.0
OVERHANG_PATCH_MIN_WIDTH_MM = 2.0


def _component_labels(edges: "np.ndarray", nodes: "np.ndarray") -> "np.ndarray":
    """Label each node with its connected-component id (0..C-1), aligned with
    `nodes`. Union-find rather than trimesh.graph.connected_components: that
    call needs an optional graph engine (scipy or networkx) and raises
    ImportError when neither is installed — which validate_mesh's best-effort
    except would silently swallow, disabling the overhang patch rule in
    engine-less deployments (CI caught exactly this)."""
    parent = {int(n): int(n) for n in nodes}

    def find(a: int) -> int:
        while parent[a] != a:
            parent[a] = parent[parent[a]]  # path halving
            a = parent[a]
        return a

    for a, b in edges:
        ra, rb = find(int(a)), find(int(b))
        if ra != rb:
            parent[ra] = rb

    dense: dict = {}
    labels = np.empty(len(nodes), dtype=np.int64)
    for i, n in enumerate(nodes):
        root = find(int(n))
        labels[i] = dense.setdefault(root, len(dense))
    return labels


def _has_wide_overhang_patch(tm, problem: "np.ndarray", areas: "np.ndarray") -> bool:
    """True when some connected patch of `problem` faces is both larger than
    OVERHANG_PATCH_MIN_AREA_MM2 and effectively wider than
    OVERHANG_PATCH_MIN_WIDTH_MM (width ~ 2*area/perimeter).

    Every patch is measured in one pass: label the faces by component, then
    accumulate per-component sums with bincount. A patch's perimeter is its
    faces' total edge length minus twice the length of the edges interior to
    it (each interior edge is shared by two of its faces).
    """
    idx = np.flatnonzero(problem)
    if len(idx) == 0:
        return False
    adj = tm.face_adjacency  # (E, 2) face-index pairs sharing an edge
    both = problem[adj[:, 0]] & problem[adj[:, 1]]
    labels = _component_labels(adj[both], idx)
    n_comps = int(labels.max()) + 1

    comp_area = np.bincount(labels, weights=areas[idx], minlength=n_comps)

    tri = tm.triangles[idx]
    face_perimeter = np.linalg.norm(tri - np.roll(tri, -1, axis=1), axis=2).sum(axis=1)
    comp_edge_total = np.bincount(labels, weights=face_perimeter, minlength=n_comps)

    # Interior edges: both endpoints are problem faces, so both are in `idx`
    # and (by construction) in the same component. Label them via the first
    # face of each pair, using a face -> position-in-idx lookup.
    pos_in_idx = np.zeros(len(tm.faces), dtype=np.int64)
    pos_in_idx[idx] = np.arange(len(idx))
    interior_faces = adj[both][:, 0]
    if len(interior_faces):
        fae = tm.face_adjacency_edges[both]  # (Ei, 2) vertex indices per shared edge
        verts = tm.vertices
        interior_len = np.linalg.norm(verts[fae[:, 0]] - verts[fae[:, 1]], axis=1)
        comp_interior = np.bincount(
            labels[pos_in_idx[interior_faces]], weights=interior_len, minlength=n_comps
        )
    else:
        comp_interior = np.zeros(n_comps)

    perimeter = comp_edge_total - 2.0 * comp_interior
    # A patch with no measurable perimeter (a closed shell) counts as wide.
    measurable = perimeter > 1e-9
    width = np.where(measurable, 2.0 * comp_area / np.where(measurable, perimeter, 1.0), np.inf)
    return bool(np.any((comp_area > OVERHANG_PATCH_MIN_AREA_MM2) & (width > OVERHANG_PATCH_MIN_WIDTH_MM)))


def validate_mesh(stl_bytes: bytes) -> list[str]:
    """Validate STL mesh and return printability warnings."""
    warnings = []
    try:
        tm = trimesh.load(io.BytesIO(stl_bytes), file_type="stl", force="mesh")

        if not hasattr(tm, 'vertices') or len(tm.vertices) == 0:
            warnings.append("Empty geometry: STL contains no vertices")
            return warnings

        if not np.isfinite(tm.vertices).all():
            warnings.append("Invalid geometry: mesh contains NaN or infinite coordinates")
            return warnings

        if not tm.is_watertight:
            warnings.append("Non-watertight mesh: may cause slicing issues. Check for unclosed shells or boolean artifacts.")

        # Overhang analysis: surface area of down-facing faces steeper than 45
        # degrees. Faces resting on the build plate (all vertices at z ~ z_min)
        # are supported by the bed and excluded — otherwise every flat-bottomed
        # part warns (the bottom of a plain cube is 2 of 12 faces = 17%).
        # Area-weighted, not face-count-weighted: triangle counts scale with
        # tessellation density, so a curved body would dilute the same physical
        # overhang that a boxy body concentrates into a few triangles.
        normals = tm.face_normals
        areas = tm.area_faces
        total_area = float(areas.sum())
        if total_area > 0:
            z_min = float(tm.bounds[0][2])
            tri_max_z = tm.triangles[:, :, 2].max(axis=1)
            on_plate = tri_max_z < z_min + PLATE_CONTACT_EPSILON_MM
            angles_from_down = np.degrees(np.arccos(np.clip(-normals[:, 2], -1, 1)))
            # 0 = straight down (worst overhang), 90 = vertical (safe)
            problem = (normals[:, 2] < 0) & (angles_from_down < 90 - OVERHANG_MAX_ANGLE_DEG) & ~on_plate
            problem_area = float(areas[problem].sum())
            problem_pct = problem_area / total_area * 100
            # Total problem area bounds any single patch's area, so the O(1)
            # comparison skips the face-adjacency build for clean meshes —
            # the common case, since this runs on every render.
            if problem_pct > OVERHANG_PCT_THRESHOLD or (
                problem_area > OVERHANG_PATCH_MIN_AREA_MM2
                and _has_wide_overhang_patch(tm, problem, areas)
            ):
                warnings.append(
                    f"Overhang warning: {problem_pct:.0f}% of the surface "
                    f"({problem_area:.0f} mm2) overhangs more than "
                    f"{OVERHANG_MAX_ANGLE_DEG:.0f} degrees and may need supports."
                )

        # Thin geometry detection
        bb = tm.bounding_box.extents  # [x, y, z] in mm
        min_dim = float(min(bb))
        if min_dim < 1.2:
            warnings.append(
                f"Very thin geometry: smallest dimension is {min_dim:.1f}mm. "
                f"Minimum recommended for printing: 1.2mm."
            )

        # Wall thickness estimate for watertight meshes using surface-to-volume ratio
        # For thin shells: avg_wall ~ 2 * volume / surface_area
        if tm.is_watertight and tm.area > 0 and tm.volume > 0:
            estimated_wall = 2.0 * tm.volume / tm.area
            if estimated_wall < 1.2:
                warnings.append(
                    f"Thin walls detected (estimated avg: {estimated_wall:.1f}mm). "
                    f"Minimum recommended: 1.2mm."
                )

    except Exception as e:
        logger.warning("Mesh validation failed: %s", e)

    return warnings


# Strip internal filesystem paths from error messages before returning them to
# the client. OCC/CadQuery tracebacks frequently include the conda env path.
# Keep in sync with `sanitizeError` in src/lib/sanitize-error.ts
# Absolute paths only (not after a word char, `.`, `)` or `]`; 2+ segments), so
# arithmetic like `width/2` in a traceback line survives.
_PATH_RE = re.compile(r"(?<![\w.)\]])(?:/[\w.\-]+){2,}(?:\.py|\.so|\.cpp|\.h)?")

def sanitize_error(msg: str) -> str:
    return _PATH_RE.sub("<path>", msg)


# LRU cache of recent render results, keyed by sha256(code). Slider drags on
# the frontend replay the same base code many times; caching avoids re-execing
# CadQuery for values we've already computed.
_RENDER_CACHE_SIZE = 16
_render_cache: "OrderedDict[str, dict]" = OrderedDict()
# Guards the OrderedDict: pipelines run on concurrent worker threads
# (asyncio.to_thread), so cache reads/writes can interleave. Unsynchronized
# move_to_end/popitem can raise "OrderedDict mutated during iteration" or
# corrupt the LRU order.
_cache_lock = threading.Lock()


def _cache_key(code: str, kind: str) -> str:
    return f"{kind}:{hashlib.sha256(code.encode('utf-8')).hexdigest()}"


def _cache_get(key: str):
    with _cache_lock:
        if key not in _render_cache:
            return None
        _render_cache.move_to_end(key)
        return _render_cache[key]


def _cache_put(key: str, value: dict):
    with _cache_lock:
        _render_cache[key] = value
        _render_cache.move_to_end(key)
        while len(_render_cache) > _RENDER_CACHE_SIZE:
            _render_cache.popitem(last=False)


# Dunder attribute/name access is the gateway to every Python sandbox escape.
# `().__class__.__bases__[0].__subclasses__()` walks to subprocess.Popen without
# ever naming `object`, so removing `type`/`object`/`super` from builtins does
# NOT block it. Parametric CadQuery scripts never legitimately touch dunders
# (except the `if __name__` guard, allowlisted below), so we reject any dunder
# attribute or name at parse time. This is defense-in-depth layered on top of
# the container boundary (still the real trust boundary), and it closes the
# introspection walk plus direct `__import__`/`__builtins__` access.
_DUNDER_RE = re.compile(r"^__.*__$")

# `__name__` is provided to user code (SAFE_BUILTINS sets it to "__main__"), so
# the standard `if __name__ == "__main__":` guard must be allowed. It is an
# inert string, not an escape vector.
_ALLOWED_DUNDERS = frozenset({"__name__"})


def assert_no_dunder_access(code: str) -> None:
    """Raise ValueError if user code reads or writes any dunder name/attribute.

    Parsing happens before exec so an escape attempt never runs. getattr/setattr
    are already removed from builtins, so dunders can't be reached by string
    name either; this AST check closes the remaining literal-syntax path.
    """
    # filename must match exec()'s "<string>" so _user_code_line can report
    # the failing line for SyntaxErrors raised here.
    tree = ast.parse(code, filename="<string>")
    for node in ast.walk(tree):
        if isinstance(node, ast.Attribute) and _DUNDER_RE.match(node.attr) and node.attr not in _ALLOWED_DUNDERS:
            raise ValueError(f"Access to '{node.attr}' is not allowed in the sandbox.")
        if isinstance(node, ast.Name) and _DUNDER_RE.match(node.id) and node.id not in _ALLOWED_DUNDERS:
            raise ValueError(f"Access to '{node.id}' is not allowed in the sandbox.")


def exec_user_code(code: str) -> tuple[object, str]:
    """Execute sandboxed CadQuery code. Returns (result, console_output).

    Raises on failure. Used by both /render and /export-3mf.

    User print() output is captured by injecting a buffer-bound `print` into
    this call's sandbox builtins, NOT via contextlib.redirect_stdout. Redirect
    swaps the *process-global* sys.stdout, which is unsafe now that execs run
    concurrently on worker threads (asyncio.to_thread): two requests would
    cross-contaminate each other's console output and race the restore. A
    per-call print keeps each request's output isolated. Sandboxed code has no
    access to `sys`, so replacing `print` captures everything it can emit.
    """
    console_buf = io.StringIO()

    def _capturing_print(*args, **kwargs):
        kwargs.setdefault("file", console_buf)
        print(*args, **kwargs)

    exec_globals = make_exec_globals()
    exec_globals["__builtins__"]["print"] = _capturing_print

    # Reject dunder access before running anything, so an introspection escape
    # never executes (see assert_no_dunder_access).
    assert_no_dunder_access(code)

    # One namespace for globals AND locals, exactly like a real module. With a
    # separate locals dict, top-level assignments land in locals while
    # comprehension bodies and function bodies compile their reads as GLOBAL
    # lookups, so `[w * i for i in range(n)]` or a helper function reading a
    # top-level parameter dies with NameError. The dict is per-call, so user
    # code still can't poison later requests.
    with timeout(EXEC_TIMEOUT):
        exec(code, exec_globals)

    if "result" not in exec_globals:
        raise ValueError("The code must define a 'result' variable containing the CadQuery object.")

    return exec_globals["result"], console_buf.getvalue()


# Max chordal deviation of the export tessellation (mm), for both the preview
# STL and the printable STL/3MF (they are the same bytes: the STL download
# ships the render result). CadQuery's default of 0.1 leaves visible facets on
# curved features and prints holes undersized beyond their intended clearance;
# 0.02 is in the conventional range for slicer-bound meshes. Measured cost is
# small — the 0.1 rad angular tolerance bounds curved-surface refinement
# (vase STL 214 -> 295 KiB, export 24 -> 27 ms).
EXPORT_TOLERANCE_MM = 0.02


def export_to_bytes(result: object, export_type: str, suffix: str) -> bytes:
    """Export a CadQuery result to bytes in the given format."""
    # cq.exporters.export() does not accept cq.Assembly, but the system prompt
    # tells the model to use Assembly for multi-part models. Flatten to a
    # compound so multi-part results export as one mesh with parts positioned
    # as placed.
    if isinstance(result, cq.Assembly):
        result = cq.Workplane(obj=result.toCompound())
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp_path = tmp.name
    try:
        cq.exporters.export(result, tmp_path, exportType=export_type, tolerance=EXPORT_TOLERANCE_MM)
        with open(tmp_path, "rb") as f:
            return f.read()
    finally:
        os.unlink(tmp_path)


# exec() + tessellation + export are CPU-bound and synchronous. Running them
# inline in an async handler would block the uvicorn event loop for the whole
# render, so /health and any concurrent request would hang behind it. We offload
# the whole pipeline to a worker thread (to_thread) and bound the wait with
# wait_for, which keeps the loop responsive and gives a hard ceiling even when
# the in-thread timeout can't interrupt a long-running C call.
WAIT_TIMEOUT = EXEC_TIMEOUT + 10

# Bound on concurrent pipeline executions. The in-thread timeout cannot
# interrupt a blocking C call (OCC tessellation/boolean), so on the wait_for
# path the worker thread is abandoned but keeps running until that C call
# returns -- a leaked thread. We count a slot as occupied from submit until the
# thread *actually* finishes (not until wait_for gives up), so a handful of hung
# renders can't exhaust an unbounded pool: once MAX_CONCURRENT_RENDERS slots are
# taken the worker sheds load with 503 and stays responsive instead of silently
# queueing forever. The complete fix (hard-killing a hung render) needs process
# isolation; this bounds and surfaces the blast radius in the meantime.
MAX_CONCURRENT_RENDERS = int(os.environ.get("CAD_MAX_CONCURRENT_RENDERS", "4"))
_inflight_lock = threading.Lock()
_inflight = 0


class PipelineError(Exception):
    """Carries console output captured before the failure so the handler can
    surface it alongside the error."""

    def __init__(self, original: Exception, console_output: str):
        super().__init__(str(original))
        self.original = original
        self.console_output = console_output


# A "successful" script whose result has (near-)zero volume is a silent
# failure: a .cut() or .intersect() that removed the whole body, or `result`
# holding a 2D sketch. Fail it so the LLM self-corrects instead of shipping
# an empty STL.
DEGENERATE_VOLUME_MM3 = 0.001

# Target printer build volume (Bambu default, mm, cubic). Kept in sync with
# BUILD_VOLUME_MM in src/lib/utils.ts (interpolated into the system prompt and
# drawn as the viewer's build plate).
BUILD_VOLUME_MM = 256


def _render_pipeline(code: str) -> dict:
    result, console_output = exec_user_code(code)
    try:
        # volume is None when the result type couldn't be measured; the
        # degenerate check must only reject a provably-empty body.
        bbox, volume = compute_metrics(result)
        if volume is not None and volume <= DEGENERATE_VOLUME_MM3:
            # NB: no "/" in this message. sanitize_error strips path-like
            # substrings and would mangle ".cut()/.intersect()".
            raise ValueError(
                "Result is empty or degenerate (volume ~0 mm3). A boolean operation "
                "such as .cut() or .intersect() likely removed the whole body, or "
                "`result` holds a 2D sketch instead of a solid. Rebuild so `result` "
                "contains at least one solid with positive volume."
            )
        stl_data = export_to_bytes(result, "STL", ".stl")
        stl_base64 = base64.b64encode(stl_data).decode("utf-8")
        warnings = validate_mesh(stl_data)
        if bbox["x"] > BUILD_VOLUME_MM or bbox["y"] > BUILD_VOLUME_MM:
            warnings.append(
                f"Build plate overflow: {bbox['x']:.0f} x {bbox['y']:.0f} mm footprint exceeds "
                f"the {BUILD_VOLUME_MM} x {BUILD_VOLUME_MM} mm bed on X/Y. "
                "Scale the design down or split it into printable parts."
            )
        if bbox["z"] > BUILD_VOLUME_MM:
            warnings.append(
                f"Build height overflow: {bbox['z']:.0f} mm tall exceeds the "
                f"{BUILD_VOLUME_MM} mm build height on Z. "
                "Scale the design down, reorient it, or split it into printable parts."
            )
    except Exception as e:
        raise PipelineError(e, console_output) from e
    return {
        "stl_base64": stl_base64,
        "metrics": {"bbox": bbox, "volume": round(volume, 2) if volume is not None else 0.0},
        "warnings": warnings if warnings else None,
        "console_output": console_output if console_output else None,
    }


def _threemf_pipeline(code: str) -> dict:
    result, console_output = exec_user_code(code)
    try:
        data = export_to_bytes(result, "3MF", ".3mf")
    except Exception as e:
        raise PipelineError(e, console_output) from e
    return {
        "threemf_base64": base64.b64encode(data).decode("utf-8"),
        "console_output": console_output if console_output else None,
    }


# Keep tool errors short: the LLM has a 5-step budget and long errors bury the
# actionable line. OCC/CadQuery messages can run to thousands of characters.
MAX_ERROR_DETAIL_CHARS = 1500


def _user_code_line(e: Exception) -> Optional[int]:
    """Deepest line number inside the user's script (exec'd as '<string>'),
    or None when the failure never touched user code."""
    if isinstance(e, SyntaxError) and e.filename == "<string>":
        return e.lineno
    line = None
    tb = e.__traceback__
    while tb is not None:
        if tb.tb_frame.f_code.co_filename == "<string>":
            line = tb.tb_lineno
        tb = tb.tb_next
    return line


def _error_detail(e: Exception) -> str:
    console_output = e.console_output if isinstance(e, PipelineError) else ""
    underlying = e.original if isinstance(e, PipelineError) else e
    error_msg = sanitize_error(f"{type(underlying).__name__}: {underlying}")
    line = _user_code_line(underlying)
    if line is not None:
        error_msg = f"Line {line} of your script: {error_msg}"
    if console_output:
        error_msg = f"{error_msg}\n\nConsole output:\n{sanitize_error(console_output)}"
    if len(error_msg) > MAX_ERROR_DETAIL_CHARS:
        error_msg = error_msg[:MAX_ERROR_DETAIL_CHARS] + " ... [truncated]"
    return error_msg


async def _execute_pipeline(pipeline, code: str, req_id: str, label: str) -> dict:
    """Run a render/export pipeline on a worker thread with bounded concurrency
    and a hard wall-clock ceiling. Raises HTTPException(400/503) on failure;
    returns the pipeline's payload dict on success.

    Shared by /render and /export-3mf so the concurrency bound, timeout mapping,
    and error formatting live in one place.
    """
    global _inflight
    with _inflight_lock:
        if _inflight >= MAX_CONCURRENT_RENDERS:
            logger.warning("[%s] %s rejected: worker at capacity (%d in flight)", req_id, label, _inflight)
            raise HTTPException(status_code=503, detail="Worker is busy. Please retry shortly.")
        _inflight += 1

    future = asyncio.ensure_future(asyncio.to_thread(pipeline, code))

    def _release(_):
        # Decrement only when the thread truly finishes, even if wait_for has
        # already abandoned it, so a leaked (hung-C-call) thread keeps holding
        # its slot and counts toward the concurrency bound.
        global _inflight
        with _inflight_lock:
            _inflight -= 1

    future.add_done_callback(_release)

    try:
        # shield so a wait_for timeout cancels only our wait, not the underlying
        # thread future (a thread can't be cancelled mid-run anyway).
        return await asyncio.wait_for(asyncio.shield(future), timeout=WAIT_TIMEOUT)
    except (asyncio.TimeoutError, ExecTimeoutError):
        # asyncio.TimeoutError: wait_for ceiling hit (C call ignored the in-thread
        # timeout). ExecTimeoutError: the in-thread timeout interrupted a pure-Python
        # loop. Both are timeouts -> the same clean message.
        logger.error("[%s] %s timed out after %ds", req_id, label, WAIT_TIMEOUT)
        raise HTTPException(status_code=400, detail="Code execution timed out.")
    except Exception as e:
        logger.error("[%s] %s failed: %s", req_id, label, traceback.format_exc())
        raise HTTPException(status_code=400, detail=_error_detail(e))


@app.post("/render", response_model=RenderResponse)
async def render(
    request: RenderRequest,
    http_req: Request,
    x_worker_secret: Optional[str] = Header(default=None, alias="X-Worker-Secret"),
):
    require_worker_secret(x_worker_secret)
    req_id = http_req.headers.get("x-request-id", "-")
    cache_key = _cache_key(request.code, "stl")
    cached = _cache_get(cache_key)
    if cached is not None:
        logger.info("[%s] render cache hit", req_id)
        return cached

    logger.info("[%s] render start (code=%d chars)", req_id, len(request.code))
    payload = await _execute_pipeline(_render_pipeline, request.code, req_id, "render")
    _cache_put(cache_key, payload)
    logger.info("[%s] render ok", req_id)
    return payload


@app.post("/export-3mf", response_model=ThreeMFResponse)
async def export_3mf(
    request: RenderRequest,
    http_req: Request,
    x_worker_secret: Optional[str] = Header(default=None, alias="X-Worker-Secret"),
):
    """Export CadQuery code to 3MF format. Called on-demand for downloads."""
    require_worker_secret(x_worker_secret)
    req_id = http_req.headers.get("x-request-id", "-")
    cache_key = _cache_key(request.code, "3mf")
    cached = _cache_get(cache_key)
    if cached is not None:
        logger.info("[%s] 3mf cache hit", req_id)
        return cached

    payload = await _execute_pipeline(_threemf_pipeline, request.code, req_id, "3mf export")
    _cache_put(cache_key, payload)
    logger.info("[%s] 3mf export ok", req_id)
    return payload


@app.get("/health")
def health():
    return {"status": "ok"}
