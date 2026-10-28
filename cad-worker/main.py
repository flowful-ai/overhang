from fastapi import FastAPI, HTTPException, Request, Header
from pydantic import BaseModel, field_validator
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from typing import Literal, Optional
import ast
import builtins
import cadquery as cq
from OCP.BRep import BRep_Tool
from OCP.BRepMesh import BRepMesh_IncrementalMesh
from OCP.TopLoc import TopLoc_Location
import trimesh
from views import render_views
import numpy as np
import math
import tempfile
import os
import base64
import secrets
import signal
import io
import logging
import re
import hashlib
import traceback
import asyncio
import ctypes
import multiprocessing
import multiprocessing.forkserver
import resource
import threading
import time
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager

# Ensure module-level logger output is visible (uvicorn's default config does
# not propagate application loggers by default).
logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def _lifespan(_app):
    # Start the render forkserver (~1.3 s: it imports cadquery) at boot instead
    # of inside the first /health probe or render, which would otherwise pay
    # it against its deadline (the frontend's /health ping gives up after 2 s).
    # Runs in the API process only: the forkserver imports this module too,
    # but never runs the app's lifespan.
    try:
        await asyncio.to_thread(multiprocessing.forkserver.ensure_running)
    except Exception:
        logger.exception("render forkserver failed to start; /health will report it")
    yield


app = FastAPI(lifespan=_lifespan)

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

# Wall-clock limit (in seconds) for one render or export, exec + export
# included. Enforced by SIGKILLing the render's child process.
EXEC_TIMEOUT = int(os.environ.get("EXEC_TIMEOUT", "30"))

# Shared secret with the Next.js frontend. Required on every /render and
# /export-3mf request so that nothing else on the docker network (including a
# sandbox-escaped Python process) can drive arbitrary CadQuery execution.
# CORS is browser-only and doesn't help against curl-from-inside-the-network.
# Popped, not read: the render forkserver is exec'd with the environment left
# after this, so user code can't read the secret from /proc/self/environ.
WORKER_SECRET = os.environ.pop("WORKER_SECRET", "")

# Non-dumpable: /proc/<pid>/{environ,mem} of this process become root-owned,
# so a render child (same uid) can't read the secret from the parent either.
# Linux only; a no-op elsewhere.
try:
    ctypes.CDLL(None, use_errno=True).prctl(4, 0, 0, 0, 0)  # PR_SET_DUMPABLE
except (OSError, AttributeError):
    pass


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

# Non-builtins globals for every exec. `__builtins__` is added per call from a
# fresh copy of SAFE_BUILTINS. The module objects themselves are shared, so
# tampering (`math.pi = 3`) lasts for the rest of the process; that is safe
# only because every render runs in a fresh child process (see _run_in_child).
EXEC_BASE_GLOBALS = {
    "cq": cq,
    "cadquery": cq,
    "math": math,
    "np": np,
    "numpy": np,
}


def make_exec_globals() -> dict:
    return {"__builtins__": dict(SAFE_BUILTINS), **EXEC_BASE_GLOBALS}


MAX_CODE_LENGTH = 50_000

class RenderRequest(BaseModel):
    code: str
    # Also return shaded preview images (views.py) for the model's visual
    # self-check. Off by default: manual re-renders and models without image
    # input don't need them.
    views: bool = False

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


class IssueModel(BaseModel):
    severity: Literal["blocking", "advisory"]
    message: str


class HoleModel(BaseModel):
    diameter: float
    depth: float
    axis: str
    through: bool
    count: int


class OverhangModel(BaseModel):
    worst_deg: float  # from vertical; 90 = flat ceiling
    at: list[float]
    area_mm2: float


class SolidModel(BaseModel):
    volume: float
    bbox: BBox
    z_min: float


class GeometryModel(BaseModel):
    solid_count: int
    z_min: Optional[float] = None
    bounds_min: Optional[list[float]] = None
    bounds_max: Optional[list[float]] = None
    valid: Optional[bool] = None
    faces: dict[str, int] = {}
    holes: list[HoleModel] = []
    hole_count: Optional[int] = None  # None = not measured
    min_wall_mm: Optional[float] = None
    overhang: Optional[OverhangModel] = None
    solids: list[SolidModel] = []


class ViewModel(BaseModel):
    name: str
    png_base64: str


class RenderResponse(BaseModel):
    stl_base64: str
    metrics: WorkerMetricsModel
    # Messages of `issues`, in the same order (kept for older consumers).
    warnings: Optional[list[str]] = None
    issues: Optional[list[IssueModel]] = None
    geometry: Optional[GeometryModel] = None
    # Only when the request asked for them (RenderRequest.views).
    views: Optional[list[ViewModel]] = None
    console_output: Optional[str] = None


class ThreeMFResponse(BaseModel):
    threemf_base64: str
    console_output: Optional[str] = None

_RESULT_TYPES_HINT = "Assign `result` a cq.Workplane, a cq.Shape (e.g. from .val()) or a cq.Assembly."


def _leaf_shapes(shapes) -> list:
    """Expand (nested) Compounds into their non-compound members, so every
    body becomes its own member of the export compound. The 3MF writer emits
    one object per direct child of the compound; a nested Compound (e.g. the
    val of a union of two disjoint boxes) would merge those bodies into one
    object."""
    out = []
    for s in shapes:
        if isinstance(s, cq.Compound):
            out.extend(_leaf_shapes(list(s)))
        else:
            out.append(s)
    return out


def _compound_of(shapes) -> "cq.Shape":
    return cq.Compound.makeCompound(_leaf_shapes(shapes))


def as_export_shape(result) -> "cq.Shape":
    """Normalize a user `result` to the single cq.Shape that gets measured and
    exported, or raise a ValueError that tells the LLM how to fix it.

    Anything that isn't a Workplane, Shape, Assembly or list of Shapes is a
    hard error. Previously a cq.Sketch slipped through: it is iterable (its
    faces), so the exporter happily meshed it while the volume check could not
    measure it, and a flat 2D sketch "rendered OK" with volume 0.
    NB: no "/" in these messages; sanitize_error strips path-like substrings.
    """
    if isinstance(result, cq.Compound):
        return _compound_of([result])
    if isinstance(result, cq.Shape):
        return result
    if isinstance(result, cq.Assembly):
        # Solids measured and exported as placed (toCompound applies Locations).
        return _compound_of([result.toCompound()])
    if isinstance(result, cq.Workplane):
        return _compound_of([v for v in result.vals() if isinstance(v, cq.Shape)])
    if result is None:
        raise ValueError(
            "`result` is None. Check that the variable holds the final model (a "
            "function that forgets to `return` its Workplane yields None). " + _RESULT_TYPES_HINT
        )
    if isinstance(result, cq.Sketch):
        raise ValueError(
            "`result` is a cq.Sketch, which is 2D and has no volume. Extrude it "
            "(e.g. cq.Workplane('XY').placeSketch(s).extrude(h)) or assign a "
            "cq.Workplane, cq.Shape or cq.Assembly."
        )
    if isinstance(result, (list, tuple)):
        if result and all(isinstance(v, cq.Shape) for v in result):
            return _compound_of(result)
        raise ValueError(
            f"`result` is a {type(result).__name__} of "
            f"{', '.join(sorted({type(v).__name__ for v in result})) or 'nothing'}. "
            "Combine parts into one object: a.union(b) for a single body, or a "
            "cq.Assembly for separate parts."
        )
    raise ValueError(
        f"`result` is of type {type(result).__name__}, which can't be exported. " + _RESULT_TYPES_HINT
    )


def compute_metrics(shape: "cq.Shape") -> tuple[dict, Optional[float]]:
    """Bounding box and total solid volume (mm3, unrounded) of an export shape
    (the output of as_export_shape).

    Volume is None when a geometry call raised. That is deliberate — the
    degenerate check in _render_pipeline must only ADD a rejection for a
    provably-empty body, never reject a result that would otherwise export
    fine, so it needs to distinguish "measured 0.0" from "couldn't measure".
    """
    bbox = {"x": 0, "y": 0, "z": 0}
    try:
        solids = shape.Solids()
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


# Every printability finding is an issue with a severity:
# - "blocking": the file will not print as intended (not a closed solid,
#   off the build plate, walls or features below what a 0.4 mm nozzle can lay
#   down). The model must fix these before finishing.
# - "advisory": printable, but worth a look (supports needed, walls under the
#   recommended minimum, a part not resting on z = 0, an invalid BRep that
#   still meshed closed). The model fixes them when they conflict with the
#   request and otherwise mentions them.
BLOCKING = "blocking"
ADVISORY = "advisory"


def _issue(severity: str, message: str) -> dict:
    return {"severity": severity, "message": message}


# Recommended minimum wall (system prompt's design table) and the floor below
# which a 0.4 mm nozzle cannot lay down two perimeters: thinner walls or parts
# are blocking, thinner than recommended is advisory.
MIN_WALL_MM = 1.2
MIN_PRINTABLE_MM = 0.8

# Wall thickness by ray casting: THIN_WALL_SAMPLES points sampled on the
# surface (area-weighted, fixed seed), each shooting a ray inward along the
# surface normal against the exact BRep; the distance to where the ray leaves
# the material is the local thickness. Thin walls are flagged when at least
# THIN_WALL_MIN_SAMPLES samples covering THIN_WALL_MIN_AREA_MM2 read below
# MIN_WALL_MM, so a single wall is caught on any part while a sharp edge or a
# fillet seam (a sample or two) is not. The old 2 * volume / area estimate
# flagged every small solid part (a 3 mm cube reads 1.0 mm) and averaged a
# single thin wall away on a big one.
THIN_WALL_SAMPLES = 2000
THIN_WALL_MIN_SAMPLES = 3
# Fewer successful readings than this (deadline hit, odd geometry): no verdict.
THIN_WALL_MIN_MEASURED = 200
THIN_WALL_MIN_AREA_MM2 = 2.0
# A ray reading counts as a wall only when the exit face is within this
# angle of facing the entry face (see wall_thickness_samples).
THIN_WALL_MAX_EXIT_DEG = 45.0
# Measurement slack: a wall modeled at exactly MIN_WALL_MM reads a hair under.
THIN_WALL_SLACK_MM = 0.02

# A part counts as resting on the build plate when its lowest point is within
# this distance of z = 0.
BED_TOLERANCE_MM = 0.1

# Worst-overhang report: the steepest overhang angle reached by at least this
# much problem area, so a speck of fillet tessellation does not set it.
OVERHANG_WORST_MIN_AREA_MM2 = 1.0


def _fmt_point(p) -> str:
    return "(" + ", ".join(f"{float(v):.1f}" for v in p) + ")"


def load_mesh(stl_bytes: bytes):
    """Load an STL for inspection. An empty mesh or one with non-finite
    vertices is returned as loaded, for inspect_mesh to report."""
    tm = trimesh.load(io.BytesIO(stl_bytes), file_type="stl", force="mesh")
    if not hasattr(tm, "vertices") or len(tm.vertices) == 0:
        return tm
    if not np.isfinite(tm.vertices).all():
        return tm
    # OCC emits a few zero-area triangles where a face collapses to a point
    # (sphere poles, fillet corners, revolves touching the axis). Their
    # collapsed edges break trimesh's edge-pairing, so perfectly closed
    # solids read as non-watertight. trimesh.load(process=True) has already
    # welded coincident vertices, so a collapsed triangle repeats a vertex
    # index; drop exactly those. Collinear slivers with three distinct
    # vertices are kept: they still pair edges with their neighbours, and
    # dropping them could open a false hole. Genuine holes still leave
    # unpaired edges.
    f = tm.faces
    tm.update_faces((f[:, 0] != f[:, 1]) & (f[:, 1] != f[:, 2]) & (f[:, 0] != f[:, 2]))
    return tm


def _overhang_issue(tm) -> tuple[Optional[dict], Optional[dict]]:
    """Overhang analysis: surface area of down-facing faces steeper than 45
    degrees. Faces resting on the build plate (all vertices at z ~ z_min) are
    supported by the bed and excluded — otherwise every flat-bottomed part
    warns (the bottom of a plain cube is 2 of 12 faces = 17%). Area-weighted,
    not face-count-weighted: triangle counts scale with tessellation density,
    so a curved body would dilute the same physical overhang that a boxy body
    concentrates into a few triangles.

    Returns (issue or None, report or None). The report (worst angle from
    vertical, where, problem area) is returned whenever any face overhangs,
    even below the warning thresholds."""
    normals = tm.face_normals
    areas = tm.area_faces
    total_area = float(areas.sum())
    if total_area <= 0:
        return None, None
    z_min = float(tm.bounds[0][2])
    tri_max_z = tm.triangles[:, :, 2].max(axis=1)
    on_plate = tri_max_z < z_min + PLATE_CONTACT_EPSILON_MM
    angles_from_down = np.degrees(np.arccos(np.clip(-normals[:, 2], -1, 1)))
    # 0 = straight down (worst overhang), 90 = vertical (safe)
    problem = (normals[:, 2] < 0) & (angles_from_down < 90 - OVERHANG_MAX_ANGLE_DEG) & ~on_plate
    problem_area = float(areas[problem].sum())
    if problem_area <= 0:
        return None, None

    idx = np.flatnonzero(problem)
    order = idx[np.argsort(angles_from_down[idx])]
    reached = np.cumsum(areas[order]) >= min(OVERHANG_WORST_MIN_AREA_MM2, problem_area)
    worst_from_down = float(angles_from_down[order[int(np.argmax(reached))]])
    # Location: the largest triangle within 5 degrees of the worst angle, so
    # the point lies on a real overhang (a centroid of several patches may not).
    near = order[angles_from_down[order] <= worst_from_down + 5.0]
    at = tm.triangles_center[near[int(np.argmax(areas[near]))]]
    worst_deg = 90.0 - worst_from_down  # from vertical: 90 = flat ceiling
    report = {
        "worst_deg": round(worst_deg, 1),
        "at": [round(float(v), 1) for v in at],
        "area_mm2": round(problem_area, 1),
    }

    problem_pct = problem_area / total_area * 100
    # Total problem area bounds any single patch's area, so the O(1)
    # comparison skips the face-adjacency build for clean meshes —
    # the common case, since this runs on every render.
    if problem_pct > OVERHANG_PCT_THRESHOLD or (
        problem_area > OVERHANG_PATCH_MIN_AREA_MM2
        and _has_wide_overhang_patch(tm, problem, areas)
    ):
        return _issue(
            ADVISORY,
            f"Overhang warning: {problem_pct:.0f}% of the surface "
            f"({problem_area:.0f} mm2) overhangs more than "
            f"{OVERHANG_MAX_ANGLE_DEG:.0f} degrees and may need supports. "
            f"Worst: {worst_deg:.0f} degrees from vertical at {_fmt_point(at)}"
            f"{' (a flat ceiling: bridge it under 20 mm or chamfer it)' if worst_deg > 85 else ''}.",
        ), report
    return None, report


def wall_thickness_samples(shape: "cq.Shape", tm, samples: int = THIN_WALL_SAMPLES, deadline: float = math.inf):
    """Local wall thickness at `samples` surface points (see THIN_WALL_SAMPLES).
    Returns (thickness mm, points) arrays; NaN where the ray found no exit or
    left through a corner rather than the far side of a wall.

    Each ray starts just outside the surface (the mesh lies within the export
    tolerance of the BRep, on either side) and the thickness is the distance
    between its first two hits: entry, then exit. Near an edge whose faces
    meet at an acute angle (a vase rim, a chamfered lip) a ray leaves through
    the neighbouring face after a short distance although the wall itself is
    thick; a real wall's far face looks back at the ray (THIN_WALL_MAX_EXIT_DEG),
    so a reading is kept only then. Rays not cast by `deadline`
    (time.monotonic()) stay NaN."""
    from OCP.BRepGProp import BRepGProp_Face
    from OCP.IntCurvesFace import IntCurvesFace_ShapeIntersector
    from OCP.gp import gp_Dir, gp_Lin, gp_Pnt, gp_Vec

    points, face_idx = trimesh.sample.sample_surface(tm, samples, seed=0)
    normals = tm.face_normals[face_idx]
    offset = 0.05 + 3 * export_tolerance_mm(shape)
    cos_exit = math.cos(math.radians(THIN_WALL_MAX_EXIT_DEG))
    intersector = IntCurvesFace_ShapeIntersector()
    intersector.Load(shape.wrapped, 1e-4)
    out = np.full(len(points), np.nan)
    for i, (p, n) in enumerate(zip(points, normals)):
        if i % 100 == 0 and time.monotonic() > deadline:
            break
        o = p + n * offset
        intersector.Perform(gp_Lin(gp_Pnt(*o), gp_Dir(*(-n))), 0.0, 1e9)
        hits = sorted((intersector.WParameter(k), k) for k in range(1, intersector.NbPnt() + 1))
        if len(hits) < 2:
            continue
        k = hits[1][1]
        pnt, exit_n = gp_Pnt(), gp_Vec()
        BRepGProp_Face(intersector.Face(k)).Normal(intersector.UParameter(k), intersector.VParameter(k), pnt, exit_n)
        mag = exit_n.Magnitude()
        # Outward normals of the two sides of a wall point apart.
        if mag > 0 and (exit_n.X() * n[0] + exit_n.Y() * n[1] + exit_n.Z() * n[2]) / mag > -cos_exit:
            continue
        out[i] = hits[1][0] - hits[0][0]
    return out, points


def _thin_wall_issue(shape: "cq.Shape", tm, deadline: float = math.inf) -> tuple[Optional[dict], Optional[float]]:
    """(issue or None, robust minimum wall thickness in mm or None)."""
    thickness, points = wall_thickness_samples(shape, tm, deadline=deadline)
    ok = np.isfinite(thickness)
    if ok.sum() < THIN_WALL_MIN_MEASURED:
        return None, None
    # 2nd percentile: the thinnest wall that covers a real share of the part.
    min_wall = round(float(np.percentile(thickness[ok], 2)), 2)
    thin = ok & (thickness < MIN_WALL_MM - THIN_WALL_SLACK_MM)
    sample_area = float(tm.area) / len(thickness)
    thin_area = int(thin.sum()) * sample_area
    if thin.sum() < THIN_WALL_MIN_SAMPLES or thin_area < THIN_WALL_MIN_AREA_MM2:
        return None, min_wall
    thin_t = thickness[thin]
    typical = float(np.median(thin_t))
    at = points[thin][int(np.argmin(np.abs(thin_t - typical)))]
    severity = BLOCKING if typical < MIN_PRINTABLE_MM else ADVISORY
    return _issue(
        severity,
        f"Thin walls: about {thin_area:.0f} mm2 of the surface sits on walls under "
        f"{MIN_WALL_MM}mm (typically {typical:.2f}mm, e.g. near {_fmt_point(at)}). "
        f"Minimum recommended: {MIN_WALL_MM}mm"
        + (f"; under {MIN_PRINTABLE_MM}mm will not print reliably." if severity == BLOCKING else "."),
    ), min_wall


def inspect_mesh(tm, shape: Optional["cq.Shape"] = None, deadline: float = math.inf) -> tuple[list[dict], dict]:
    """Printability checks on the export mesh. Returns (issues, report) where
    report carries the overhang summary and the estimated minimum wall
    (min_wall_mm; needs the BRep `shape` for ray casting, None without it)."""
    issues: list[dict] = []
    report: dict = {"overhang": None, "min_wall_mm": None}
    try:
        if not hasattr(tm, "vertices") or len(tm.vertices) == 0:
            issues.append(_issue(BLOCKING, "Empty geometry: STL contains no vertices"))
            return issues, report

        if not np.isfinite(tm.vertices).all():
            issues.append(_issue(BLOCKING, "Invalid geometry: mesh contains NaN or infinite coordinates"))
            return issues, report

        if not tm.is_watertight:
            issues.append(_issue(
                BLOCKING,
                "Non-watertight mesh: may cause slicing issues. Check for unclosed shells or boolean artifacts.",
            ))

        overhang, report["overhang"] = _overhang_issue(tm)
        if overhang:
            issues.append(overhang)

        # Thin geometry detection: the whole part is thin along some axis.
        bb = tm.bounding_box.extents  # [x, y, z] in mm
        min_dim = float(min(bb))
        whole_part_thin = min_dim < MIN_WALL_MM
        if whole_part_thin:
            issues.append(_issue(
                BLOCKING if min_dim < MIN_PRINTABLE_MM else ADVISORY,
                f"Very thin geometry: smallest dimension is {min_dim:.1f}mm. "
                f"Minimum recommended for printing: {MIN_WALL_MM}mm.",
            ))

        # Local wall thickness (ray cast against the BRep). Skipped when the
        # whole part is already reported as thin: it would say the same.
        if shape is not None:
            thin, report["min_wall_mm"] = _thin_wall_issue(shape, tm, deadline)
            if thin and not whole_part_thin:
                issues.append(thin)

    except Exception as e:
        logger.warning("Mesh validation failed: %s", e)

    return issues, report


def validate_mesh(stl_bytes: bytes, shape: Optional["cq.Shape"] = None) -> list[str]:
    """Printability warnings (messages only) for an STL. Pass the BRep `shape`
    to include the ray-cast wall thickness check."""
    try:
        tm = load_mesh(stl_bytes)
    except Exception as e:
        logger.warning("Mesh validation failed: %s", e)
        return []
    issues, _ = inspect_mesh(tm, shape)
    return [i["message"] for i in issues]


# --- BRep inspection (geometry report for the model) ---

# Cap on the per-solid list in the report (an array of 200 pins stays short).
MAX_REPORTED_SOLIDS = 16
# The BRep validity check is skipped on faces with more wires than this (see
# geometry_report).
VALIDITY_MAX_WIRES_PER_FACE = 64


def _axis_name(d) -> str:
    for name, axis in (("X", (1, 0, 0)), ("Y", (0, 1, 0)), ("Z", (0, 0, 1))):
        if abs(float(np.dot(d, axis))) > 0.999:
            return name
    return "oblique"


class AnalysisTimeout(Exception):
    """An optional analysis ran past its share of the render deadline."""


def _check_deadline(deadline: float) -> None:
    if time.monotonic() > deadline:
        raise AnalysisTimeout()


def _cylindrical_holes(solid: "cq.Solid", deadline: float = math.inf) -> list[dict]:
    """Holes in one solid: concave cylindrical faces (material outside the
    radius) grouped by axis line. Coaxial faces whose axial ranges touch are
    one hole (a counterbore and its bore, a bore split into two half faces);
    a group is a hole only when its faces close the full circle at some
    radius, so concave fillets and slot ends are not counted. The diameter is
    the smallest full circle, the depth the axial extent, and the hole is
    through when the axis just past both ends is outside the material.
    Raises AnalysisTimeout past `deadline` (time.monotonic())."""
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    from OCP.BRepClass3d import BRepClass3d_SolidClassifier
    from OCP.BRepGProp import BRepGProp_Face
    from OCP.BRepTools import BRepTools
    from OCP.TopAbs import TopAbs_OUT
    from OCP.gp import gp_Pnt, gp_Vec

    # Concave cylinder faces bucketed by axis line (rounded direction + foot).
    lines: dict = {}
    for f in solid.Faces():
        if f.geomType() != "CYLINDER":
            continue
        _check_deadline(deadline)
        cyl = BRepAdaptor_Surface(f.wrapped).Cylinder()
        ax = cyl.Axis()
        own = np.array([ax.Direction().X(), ax.Direction().Y(), ax.Direction().Z()])
        # Canonical direction so opposite-facing axes of one line compare equal.
        d = -own if own[np.argmax(np.abs(own) > 1e-9)] < 0 else own
        loc = np.array([ax.Location().X(), ax.Location().Y(), ax.Location().Z()])
        u0, u1, v0, v1 = BRepTools.UVBounds_s(f.wrapped)
        pnt, nrm = gp_Pnt(), gp_Vec()
        BRepGProp_Face(f.wrapped).Normal((u0 + u1) / 2, (v0 + v1) / 2, pnt, nrm)
        p = np.array([pnt.X(), pnt.Y(), pnt.Z()])
        radial = (p - loc) - np.dot(p - loc, d) * d
        if np.dot(radial, [nrm.X(), nrm.Y(), nrm.Z()]) >= 0:
            continue  # convex: a boss or a rounded outside edge
        # Axial range in a frame shared by every face on this axis line: v
        # runs along the cylinder's own axis from its location.
        foot = loc - np.dot(loc, d) * d
        sign = 1.0 if np.dot(d, own) > 0 else -1.0
        base = float(np.dot(loc, d))
        t0, t1 = sorted((base + sign * v0, base + sign * v1))
        key = tuple(np.round(d, 3)) + tuple(np.round(foot, 2))
        line = lines.setdefault(key, {"dir": d, "foot": foot, "faces": []})
        line["faces"].append({"r": cyl.Radius(), "span": u1 - u0, "t0": t0, "t1": t1})

    classifier = BRepClass3d_SolidClassifier(solid.wrapped)

    def outside(q) -> bool:
        classifier.Perform(gp_Pnt(*q), 1e-6)
        return classifier.State() == TopAbs_OUT

    holes = []
    for line in lines.values():
        d, foot = line["dir"], line["foot"]
        # Faces whose axial ranges touch form one group (sweep in axial order).
        groups: list = []
        for f in sorted(line["faces"], key=lambda f: f["t0"]):
            if groups and f["t0"] <= groups[-1]["t1"] + 1e-2:
                groups[-1]["t1"] = max(groups[-1]["t1"], f["t1"])
                groups[-1]["faces"].append(f)
            else:
                groups.append({"t0": f["t0"], "t1": f["t1"], "faces": [f]})
        for g in groups:
            _check_deadline(deadline)
            spans: dict = {}
            for f in g["faces"]:
                spans[round(f["r"], 3)] = spans.get(round(f["r"], 3), 0.0) + f["span"]
            full = [r for r, s in spans.items() if s >= 2 * math.pi - 1e-3]
            if not full:
                continue
            holes.append({
                "diameter": round(2 * min(full), 2),
                "depth": round(g["t1"] - g["t0"], 2),
                "axis": _axis_name(d),
                "through": outside(foot + d * (g["t0"] - 0.1)) and outside(foot + d * (g["t1"] + 0.1)),
            })
    return holes


def _group_holes(holes: list[dict]) -> list[dict]:
    """Identical holes (diameter, depth, axis, through) as one entry with a count."""
    groups: "OrderedDict[tuple, dict]" = OrderedDict()
    for h in holes:
        key = (h["diameter"], h["depth"], h["axis"], h["through"])
        if key in groups:
            groups[key]["count"] += 1
        else:
            groups[key] = {**h, "count": 1}
    return list(groups.values())


_FACE_KINDS = {"PLANE": "plane", "CYLINDER": "cylinder", "CONE": "cone", "SPHERE": "sphere", "TORUS": "torus"}


def geometry_report(shape: "cq.Shape", is_assembly: bool, deadline: float = math.inf) -> tuple[dict, list[dict]]:
    """What the model needs to check the result against the request, from the
    exact BRep: solid count, placement on the bed, BRep validity, a face-type
    census and the holes. Returns (report, issues). The costly parts (holes,
    validity) are best-effort: one that raises or runs past `deadline`
    (time.monotonic()) is left out rather than failing the render."""
    issues: list[dict] = []
    solids = shape.Solids()
    report: dict = {"solid_count": len(solids), "holes": [], "solids": []}

    boxes = [s.BoundingBox() for s in solids]
    if boxes:
        combined = boxes[0]
        for b in boxes[1:]:
            combined = combined.add(b)
        report["bounds_min"] = [round(combined.xmin, 2), round(combined.ymin, 2), round(combined.zmin, 2)]
        report["bounds_max"] = [round(combined.xmax, 2), round(combined.ymax, 2), round(combined.zmax, 2)]
        z_min = combined.zmin
        report["z_min"] = round(z_min, 2)
        report["solids"] = [
            {
                "volume": round(s.Volume(), 2),
                "bbox": {"x": round(b.xlen, 2), "y": round(b.ylen, 2), "z": round(b.zlen, 2)},
                "z_min": round(b.zmin, 2),
            }
            for s, b in list(zip(solids, boxes))[:MAX_REPORTED_SOLIDS]
        ]
        if abs(z_min) > BED_TOLERANCE_MM:
            where = "above" if z_min > 0 else "below"
            issues.append(_issue(
                ADVISORY,
                f"Not on the build plate: the lowest point is at z={z_min:.2f}mm ({where} z=0). "
                "Slicers drop the part onto the bed, but the print orientation and the viewer "
                "assume z=0; build it bottom at z=0 (box(..., centered=(True, True, False))).",
            ))
        floating = [i for i, b in enumerate(boxes) if b.zmin > z_min + BED_TOLERANCE_MM]
        if floating:
            issues.append(_issue(
                ADVISORY,
                f"{len(floating)} of {len(solids)} separate solids do not reach the bed "
                f"(lowest z: {', '.join(f'{boxes[i].zmin:.1f}' for i in floating[:5])}mm) and would "
                "print in mid-air. Fine for an assembly shown assembled; otherwise lay each part flat at z=0.",
            ))
    if len(solids) > 1 and not is_assembly:
        issues.append(_issue(
            ADVISORY,
            f"The result has {len(solids)} disjoint solids. If it is meant to be one part, its bodies do "
            "not touch: make them overlap before .union(). Use a cq.Assembly for intentionally separate parts.",
        ))

    faces: dict = {}
    max_wires = 0
    for f in shape.Faces():
        kind = _FACE_KINDS.get(f.geomType(), "freeform")
        faces[kind] = faces.get(kind, 0) + 1
        max_wires = max(max_wires, len(f.innerWires()) + 1)
    report["faces"] = faces

    # None = not measured (timed out or failed), as opposed to 0 holes.
    report["hole_count"] = None
    try:
        holes = [h for s in solids for h in _cylindrical_holes(s, deadline)]
        report["holes"] = _group_holes(holes)
        report["hole_count"] = len(holes)
    except AnalysisTimeout:
        logger.info("Hole detection skipped: analysis deadline reached")
    except Exception as e:
        logger.warning("Hole detection failed: %s", e)

    # BRepCheck compares every pair of wires on a face, so a plate with
    # hundreds of holes takes seconds: skip it there (valid stays None).
    valid = None
    if max_wires <= VALIDITY_MAX_WIRES_PER_FACE and time.monotonic() < deadline:
        try:
            valid = bool(shape.isValid())
        except Exception:
            valid = None
    report["valid"] = valid
    if valid is False:
        issues.append(_issue(
            ADVISORY,
            "BRep check failed (isValid() is False): a boolean or fillet produced self-intersecting "
            "or degenerate faces. The mesh may still print; check the views, and rebuild that "
            "feature if it looks wrong.",
        ))

    return report, issues


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
    this call's sandbox builtins, NOT via contextlib.redirect_stdout, which
    swaps the process-global sys.stdout. A per-call print scopes the output to
    this exec without touching global state, wherever it runs (a render child,
    or in-process in the tests). Sandboxed code has no access to `sys`, so
    replacing `print` captures everything it can emit.
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
    # code still can't poison later requests. No timeout here: the parent
    # SIGKILLs the whole child process at the deadline.
    exec(code, exec_globals)

    if "result" not in exec_globals:
        raise ValueError("The code must define a 'result' variable containing the CadQuery object.")

    return exec_globals["result"], console_buf.getvalue()


# Max chordal deviation of the export tessellation, in absolute mm, for both
# the preview STL and the printable STL/3MF (they are the same bytes: the STL
# download ships the render result). CadQuery's default of 0.1 leaves visible
# facets on curved features and prints holes undersized beyond their intended
# clearance; 0.02 is in the conventional range for slicer-bound meshes.
#
# It must be applied as an ABSOLUTE deflection: cq.exporters.export() meshes
# with relative=True, where the value is a fraction of each edge's length, so
# with the angular limit dominating, 0.1, 0.02 and 0.005 produced
# byte-identical STLs. export_to_bytes therefore meshes the shape itself.
#
# This is the floor for small parts. A fixed 0.02 on a large curved part
# has no triangle budget (triangle count grows ~ size / deflection): a
# sphere(120) went to 60k triangles (2.9 MB, ~0.9 s) on every /render. So
# above a bounding-box diagonal of EXPORT_TOLERANCE_REF_DIAG_MM the deflection
# grows as (diag / ref) ** EXPORT_TOLERANCE_SIZE_EXPONENT (export_tolerance_mm).
# An exponent of 1 would hold the triangle count of a given shape constant as
# it scales up; 1.25 lets it fall slowly, so large parts stay at or below the
# old relative-meshing sizes (sphere(120): 391 KiB before this PR, 317 KiB
# now, deflection ~0.19 mm) while parts up to a 70 mm diagonal (sphere(20):
# 69 mm) keep the full 0.02 mm and the polar-flange eval fixture (85 mm)
# gets 0.026 mm.
EXPORT_TOLERANCE_MM = 0.02
EXPORT_TOLERANCE_REF_DIAG_MM = 70.0
EXPORT_TOLERANCE_SIZE_EXPONENT = 1.25

# Max angle (radians) between adjacent facets on curved surfaces. 0.2 rad
# (~11.5 deg, >= ~31 segments per full circle) keeps small holes and fillets
# round, while the chordal limit governs larger radii. The old 0.1 rad
# doubled the facets on every small curved feature below the chordal limit
# anyway. Binary STL sizes vs the old relative meshing: see the PR (#3).
EXPORT_ANGULAR_TOLERANCE_RAD = 0.2


def export_tolerance_mm(shape: "cq.Shape") -> float:
    """Absolute linear deflection for meshing `shape`: EXPORT_TOLERANCE_MM for
    small parts, growing with the bounding-box diagonal for large ones."""
    scale = max(1.0, shape.BoundingBox().DiagonalLength / EXPORT_TOLERANCE_REF_DIAG_MM)
    return EXPORT_TOLERANCE_MM * scale ** EXPORT_TOLERANCE_SIZE_EXPONENT


def _tessellate_absolute(shape: "cq.Shape", tolerance: float) -> None:
    """Mesh `shape` in place with an absolute `tolerance` deflection, and
    check that every face got a triangulation.

    Both the STL and the 3MF writer then serialize this triangulation as-is
    (see export_to_bytes for how the 3MF path is kept from re-meshing). A face
    left untriangulated would be silently dropped by the STL writer, and
    re-meshed with infinite deflection by the 3MF writer, so it is an error.
    """
    BRepMesh_IncrementalMesh(shape.wrapped, tolerance, False, EXPORT_ANGULAR_TOLERANCE_RAD, True)
    faces = shape.Faces()
    missing = sum(1 for f in faces if BRep_Tool.Triangulation_s(f.wrapped, TopLoc_Location()) is None)
    if missing:
        raise ValueError(
            f"Export failed: {missing} of {len(faces)} faces could not be meshed. "
            "The geometry is likely invalid (self-intersecting or degenerate faces); "
            "simplify the failing feature or check result.val().isValid()."
        )


def export_to_bytes(shape: "cq.Shape", export_type: str, suffix: str) -> bytes:
    """Export a normalized shape (from as_export_shape) to bytes in the given
    format ("STL" or "3MF")."""
    tolerance = export_tolerance_mm(shape)
    _tessellate_absolute(shape, tolerance)
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp_path = tmp.name
    try:
        if export_type == "STL":
            # Same parameters as _tessellate_absolute, so exportStl's own
            # BRepMesh pass finds the mesh already done and just writes it.
            if not shape.exportStl(
                tmp_path, tolerance, EXPORT_ANGULAR_TOLERANCE_RAD, ascii=False, relative=False
            ):
                raise ValueError("STL export failed: the shape has no tessellated faces.")
        else:
            # The 3MF writer tessellates via Shape.mesh(), which re-meshes
            # (relative, i.e. the bug above) unless every face already has a
            # triangulation whose recorded deflection is <= `tolerance`. OCC
            # records its surface-deflection estimate there, which can exceed
            # what was requested (0.041 for a 0.02 sphere mesh), so passing our
            # tolerance would silently discard our mesh. An infinite tolerance
            # means "reuse the existing triangulation", which is safe because
            # _tessellate_absolute verified every face has one.
            cq.exporters.export(
                shape, tmp_path, exportType=export_type,
                tolerance=math.inf, angularTolerance=EXPORT_ANGULAR_TOLERANCE_RAD,
            )
        with open(tmp_path, "rb") as f:
            return f.read()
    finally:
        os.unlink(tmp_path)


# --- Process isolation ---
# exec() + tessellation + export run in a child process per request, never in
# this one. OCC holds the GIL through long C++ calls (booleans, fillets,
# tessellation), so on a thread it froze the event loop, /health, and every
# timeout, and a hung render held its slot forever. A process can be SIGKILLed
# at the deadline whatever it is doing, and its slot is freed when it's reaped.
#
# Children come from a forkserver that preloads this module (cadquery, OCP,
# numpy already imported), so a request pays a fork, not a ~1s import. Each
# child runs exactly one pipeline and exits: the forkserver never runs user
# code, so nothing a script tampers with (math.pi, cq.Workplane methods,
# module caches) can reach the next request.
_mp = multiprocessing.get_context("forkserver")
# "__main__" too: otherwise every child re-runs the entry script (uvicorn's
# CLI) before it can unpickle its task.
_mp.set_forkserver_preload(["__main__", __name__])

# Environment for the forkserver, which is a fresh interpreter, so these apply
# there even though numpy and OCC are already loaded here. RLIMIT_AS counts
# reserved address space, and both runtimes reserve per thread they start:
# - glibc gives each allocating thread its own 64 MB malloc arena. OCC runs
#   booleans on a thread per host core, and 16 arenas blow a 1 GB cap within
#   a 50-cut loop (segfault). Two arenas are plenty for one render.
# - numpy's OpenMP BLAS starts a thread per host core on the first matrix op;
#   under the cap that fails and aborts the child. Renders already run in
#   parallel processes, so single-threaded BLAS also avoids oversubscription.
os.environ["MALLOC_ARENA_MAX"] = "2"
for _var in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ[_var] = "1"

# Bound on concurrent children. Over it the worker sheds load with 503 instead
# of queueing. A slot is held until its child has exited (or been killed).
MAX_CONCURRENT_RENDERS = int(os.environ.get("CAD_MAX_CONCURRENT_RENDERS", "4"))
_inflight_lock = threading.Lock()
_inflight = 0

# Extra address space (MB) a child may map beyond what the preloaded forkserver
# image already has. RLIMIT_AS counts virtual memory, and importing OCP alone
# maps ~2.7 GB (mostly untouched reservations, ~370 MB resident), so an
# absolute cap would be meaningless. The container memory limit still bounds
# the sum over concurrent children.
RENDER_MEMORY_MB = int(os.environ.get("CAD_RENDER_MEMORY_MB", "1024"))

# One thread per slot (+1 for the /health probe) waits on its child. These
# threads only block on a pipe, so they never hold the GIL for long.
_render_executor = ThreadPoolExecutor(
    max_workers=MAX_CONCURRENT_RENDERS + 1, thread_name_prefix="render-wait"
)


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

# Share of EXEC_TIMEOUT after which _render_pipeline skips the optional
# analyses (see there). Images are ~0.2-0.6 s, so they still fit after it.
ANALYSIS_DEADLINE_SHARE = 0.6


def _render_pipeline(code: str, views: bool = False) -> dict:
    started = time.monotonic()
    result, console_output = exec_user_code(code)
    try:
        # Normalize once, up front: an unexportable result type (None, a
        # cq.Sketch, a list of Workplanes, ...) fails here with a fix-it message.
        shape = as_export_shape(result)
        # volume is None when a geometry call failed; the degenerate check
        # must only reject a provably-empty body.
        bbox, volume = compute_metrics(shape)
        if volume is not None and volume <= DEGENERATE_VOLUME_MM3:
            # NB: no "/" in this message. sanitize_error strips path-like
            # substrings and would mangle ".cut()/.intersect()".
            raise ValueError(
                "Result is empty or degenerate (volume ~0 mm3). A boolean operation "
                "such as .cut() or .intersect() likely removed the whole body, or "
                "`result` holds a 2D sketch instead of a solid. Rebuild so `result` "
                "contains at least one solid with positive volume."
            )
        stl_data = export_to_bytes(shape, "STL", ".stl")
        stl_base64 = base64.b64encode(stl_data).decode("utf-8")
        tm = load_mesh(stl_data)
        # The optional analyses (wall thickness, holes, validity, images) get
        # a share of the render deadline and are skipped past it, so a heavy
        # model that exports in time is never failed by its own report.
        deadline = started + EXEC_TIMEOUT * ANALYSIS_DEADLINE_SHARE
        issues, mesh_report = inspect_mesh(tm, shape, deadline)
        if bbox["x"] > BUILD_VOLUME_MM or bbox["y"] > BUILD_VOLUME_MM:
            issues.append(_issue(
                BLOCKING,
                f"Build plate overflow: {bbox['x']:.0f} x {bbox['y']:.0f} mm footprint exceeds "
                f"the {BUILD_VOLUME_MM} x {BUILD_VOLUME_MM} mm bed on X/Y. "
                "Scale the design down or split it into printable parts.",
            ))
        if bbox["z"] > BUILD_VOLUME_MM:
            issues.append(_issue(
                BLOCKING,
                f"Build height overflow: {bbox['z']:.0f} mm tall exceeds the "
                f"{BUILD_VOLUME_MM} mm build height on Z. "
                "Scale the design down, reorient it, or split it into printable parts.",
            ))
        # Best-effort: a report or image that fails must not fail a render
        # that exported fine.
        geometry = None
        try:
            geometry, geometry_issues = geometry_report(shape, isinstance(result, cq.Assembly), deadline)
            geometry.update(mesh_report)
            issues.extend(geometry_issues)
        except Exception as e:
            logger.warning("Geometry report failed: %s", e)
        rendered_views = None
        if views and time.monotonic() < deadline:
            try:
                rendered_views = render_views(tm.vertices, tm.faces, tm.face_normals)
            except Exception as e:
                logger.warning("View rendering failed: %s", e)
    except Exception as e:
        raise PipelineError(e, console_output) from e
    return {
        "stl_base64": stl_base64,
        "metrics": {"bbox": bbox, "volume": round(volume, 2) if volume is not None else 0.0},
        "warnings": [i["message"] for i in issues] or None,
        "issues": issues or None,
        "geometry": geometry,
        "views": rendered_views,
        "console_output": console_output if console_output else None,
    }


def _render_pipeline_with_views(code: str) -> dict:
    """_render_pipeline plus the preview images (a module-level function, so
    it pickles by reference into the render child)."""
    return _render_pipeline(code, views=True)


def _threemf_pipeline(code: str) -> dict:
    result, console_output = exec_user_code(code)
    try:
        data = export_to_bytes(as_export_shape(result), "3MF", ".3mf")
    except Exception as e:
        raise PipelineError(e, console_output) from e
    return {
        "threemf_base64": base64.b64encode(data).decode("utf-8"),
        "console_output": console_output if console_output else None,
    }


# Keep tool errors short: the LLM has a small step budget and long errors bury the
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


def _apply_child_limits(memory_mb: int, cpu_seconds: int) -> None:
    """Resource caps for a render child. RLIMIT_AS is relative to what the
    preloaded image already maps (see RENDER_MEMORY_MB): past it, allocations
    fail with MemoryError (or std::bad_alloc in OCC). RLIMIT_CPU is a backstop
    for a child that outlives the parent's deadline kill (e.g. the parent
    died): SIGXCPU at the soft limit, SIGKILL one second later. CPU time
    sums over threads (OCC booleans are multi-threaded), hence the core
    multiplier.

    Linux only for the memory cap: without /proc (macOS dev runs) or where
    RLIMIT_AS can't be lowered, the render runs without it rather than
    failing every request."""
    try:
        with open("/proc/self/statm") as f:
            mapped = int(f.read().split()[0]) * resource.getpagesize()
        limit = mapped + memory_mb * 1024 * 1024
        resource.setrlimit(resource.RLIMIT_AS, (limit, limit))
    except (OSError, ValueError):
        pass
    resource.setrlimit(resource.RLIMIT_CPU, (cpu_seconds, cpu_seconds + 1))


def _child_main(conn, pipeline, code: str, memory_mb: int, cpu_seconds: int) -> None:
    """Entry point of a render child. Sends exactly one message: ("ok", payload)
    or ("error", detail, traceback). The error detail is formatted here because
    tracebacks (needed for the user's line number) don't pickle.

    BaseException, not Exception: a KeyboardInterrupt (SIGINT to the process
    group in a dev terminal) or SystemExit raised from library code must be
    reported as an error, not surface as a silent "crashed" (out of memory)."""
    try:
        _apply_child_limits(memory_mb, cpu_seconds)
        conn.send(("ok", pipeline(code)))
    except BaseException as e:
        conn.send(("error", _error_detail(e), traceback.format_exc()))
    finally:
        conn.close()


def _noop_pipeline(code: str) -> dict:
    return {}


def _run_in_child(pipeline, code: str, timeout_s: float) -> tuple:
    """Run `pipeline(code)` in a fresh child and wait at most `timeout_s`.
    Blocking; call it off the event loop. Always reaps the child (SIGKILL if
    still running) before returning, so the caller's slot can be freed.

    Returns ("ok", payload), ("error", detail, traceback), ("timeout",), or
    ("crashed", exitcode) when the child died without reporting (OOM kill,
    OCC abort on a failed allocation, segfault)."""
    recv_conn, send_conn = _mp.Pipe(duplex=False)
    proc = _mp.Process(
        target=_child_main,
        args=(send_conn, pipeline, code, RENDER_MEMORY_MB, (int(timeout_s) + 5) * (os.cpu_count() or 1)),
        daemon=True,
    )
    try:
        proc.start()
        send_conn.close()
        if not recv_conn.poll(timeout_s):
            return ("timeout",)
        try:
            return recv_conn.recv()
        except EOFError:
            proc.join()
            if proc.exitcode == -signal.SIGXCPU:
                return ("timeout",)
            return ("crashed", proc.exitcode)
    finally:
        send_conn.close()
        recv_conn.close()
        if proc.pid is not None:
            proc.kill()
            proc.join()
            proc.close()


def _timeout_detail() -> str:
    # Starts with the exact message the frontend has always received. No "/"
    # in the hint: sanitize_error-style path stripping would mangle it.
    return (
        f"Code execution timed out. Renders are limited to {EXEC_TIMEOUT} seconds. "
        "Common causes: many boolean operations (.union() or .cut()) inside a loop, "
        "and fillets or chamfers on a complex body. Combine shapes into one boolean, "
        "or fillet simpler geometry before the booleans."
    )


async def _execute_pipeline(pipeline, code: str, req_id: str, label: str) -> dict:
    """Run a render/export pipeline in a child process with bounded concurrency
    and a hard wall-clock deadline. Raises HTTPException(400/503) on failure;
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

    loop = asyncio.get_running_loop()
    future = loop.run_in_executor(_render_executor, _run_in_child, pipeline, code, EXEC_TIMEOUT)

    def _release(fut):
        # Release when the waiting thread returns, i.e. once the child is
        # reaped, even if this request was cancelled (client disconnect) first.
        global _inflight
        with _inflight_lock:
            _inflight -= 1
        # Mark a start failure retrieved: if this request was cancelled,
        # nothing else awaits `fut`, and asyncio would log "Future exception
        # was never retrieved" at GC.
        if not fut.cancelled():
            fut.exception()

    future.add_done_callback(_release)

    # shield: a cancelled request must not cancel the wait (the child runs to
    # its deadline and still holds the slot until then).
    try:
        outcome = await asyncio.shield(future)
    except Exception:
        # Could not start a child at all (forkserver gone, fork failed).
        logger.error("[%s] %s could not start: %s", req_id, label, traceback.format_exc())
        raise HTTPException(status_code=503, detail="Worker is unavailable. Please retry shortly.")
    status = outcome[0]
    if status == "ok":
        return outcome[1]
    if status == "timeout":
        logger.error("[%s] %s timed out after %ds, child killed", req_id, label, EXEC_TIMEOUT)
        raise HTTPException(status_code=400, detail=_timeout_detail())
    if status == "crashed":
        logger.error("[%s] %s child died (exit code %s)", req_id, label, outcome[1])
        raise HTTPException(
            status_code=400,
            detail=(
                "Rendering crashed, most likely by running out of memory "
                f"(limit {RENDER_MEMORY_MB} MB). Simplify the model or reduce repeated features."
            ),
        )
    logger.error("[%s] %s failed: %s", req_id, label, outcome[2])
    raise HTTPException(status_code=400, detail=outcome[1])


@app.post("/render", response_model=RenderResponse)
async def render(
    request: RenderRequest,
    http_req: Request,
    x_worker_secret: Optional[str] = Header(default=None, alias="X-Worker-Secret"),
):
    require_worker_secret(x_worker_secret)
    req_id = http_req.headers.get("x-request-id", "-")
    cache_key = _cache_key(request.code, "stl+views" if request.views else "stl")
    cached = _cache_get(cache_key)
    if cached is not None:
        logger.info("[%s] render cache hit", req_id)
        return cached

    logger.info("[%s] render start (code=%d chars, views=%s)", req_id, len(request.code), request.views)
    pipeline = _render_pipeline_with_views if request.views else _render_pipeline
    payload = await _execute_pipeline(pipeline, request.code, req_id, "render")
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


# /health forks a no-op child, so it fails when renders can't actually run
# (forkserver dead, fork or memory exhausted), not just when this process is up.
# One probe at a time, reused for a few seconds, so polling can't fork-bomb.
# The timeout stays under the compose healthcheck's 5 s. The forkserver is
# started at boot (_lifespan), so a probe normally costs one fork (~18 ms).
HEALTH_PROBE_TIMEOUT = 4
_HEALTH_CACHE_SECONDS = 5.0
_health_lock = asyncio.Lock()
_health_last: Optional[tuple[float, bool]] = None


async def _health_ok() -> bool:
    global _health_last
    # While a probe runs, answer from the previous one instead of queueing
    # behind it: the frontend's ping gives up after 2 s, and a queued caller
    # would wait out the whole probe first.
    if _health_lock.locked() and _health_last is not None:
        return _health_last[1]
    async with _health_lock:
        if _health_last is None or time.monotonic() - _health_last[0] > _HEALTH_CACHE_SECONDS:
            loop = asyncio.get_running_loop()
            try:
                outcome = await loop.run_in_executor(
                    _render_executor, _run_in_child, _noop_pipeline, "", HEALTH_PROBE_TIMEOUT
                )
            except Exception as e:
                outcome = ("unstartable", repr(e))
            if outcome[0] != "ok":
                logger.error("health probe failed: %s", outcome[:2])
            _health_last = (time.monotonic(), outcome[0] == "ok")
        return _health_last[1]


@app.get("/health")
async def health():
    ok = await _health_ok()
    body = {
        "status": "ok" if ok else "unavailable",
        "inflight": _inflight,
        "capacity": MAX_CONCURRENT_RENDERS,
    }
    return JSONResponse(body, status_code=200 if ok else 503)
