"""Tests for the geometry report, issue severities, the ray-cast wall
thickness check and the preview images (main.py, views.py).

Run like test_main.py (see CONTRIBUTING.md).
"""
import base64
import struct
import zlib

import cadquery as cq
import numpy as np
import pytest
from fastapi.testclient import TestClient

from main import (
    ADVISORY,
    BLOCKING,
    _render_pipeline,
    app,
    as_export_shape,
    export_to_bytes,
    geometry_report,
    inspect_mesh,
    load_mesh,
    validate_mesh,
    wall_thickness_samples,
)
from views import VIEW_SIZE_PX, encode_png, render_views

client = TestClient(app)


def _mesh(result):
    shape = as_export_shape(result)
    return shape, load_mesh(export_to_bytes(shape, "STL", ".stl"))


def _issues(result):
    shape, tm = _mesh(result)
    issues, report = inspect_mesh(tm, shape)
    return issues, report


def _thin(issues):
    return [i for i in issues if "thin" in i["message"].lower()]


def _decode_png(data: bytes) -> np.ndarray:
    """Decode the encoder's own output (8-bit RGB, filter 0) back to pixels."""
    assert data[:8] == b"\x89PNG\r\n\x1a\n"
    pos, idat, width, height = 8, b"", 0, 0
    while pos < len(data):
        (length,) = struct.unpack(">I", data[pos:pos + 4])
        tag = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + length]
        if tag == b"IHDR":
            width, height = struct.unpack(">II", body[:8])
        elif tag == b"IDAT":
            idat += body
        pos += 12 + length
    raw = np.frombuffer(zlib.decompress(idat), dtype=np.uint8).reshape(height, 1 + width * 3)
    assert (raw[:, 0] == 0).all()
    return raw[:, 1:].reshape(height, width, 3)


# --- Wall thickness (ray cast) ---

def test_small_solid_part_is_not_thin():
    # The old 2 * volume / area estimate read a 3mm cube as a 1.0mm wall.
    issues, report = _issues(cq.Workplane("XY").box(3, 3, 3, centered=(True, True, False)))
    assert _thin(issues) == []
    assert report["min_wall_mm"] == pytest.approx(3.0, abs=0.05)


def _box_with_one_wall(wall: float):
    # 80 x 50 x 30 open box: 2mm walls except the +X wall, which is `wall` thick.
    outer = cq.Workplane("XY").box(80, 50, 30, centered=(True, True, False))
    inner_w = 80 - 2 - wall
    inner = (
        cq.Workplane("XY").workplane(offset=2).center((2 - wall) / 2, 0)
        .box(inner_w, 46, 30, centered=(True, True, False))
    )
    return outer.cut(inner)


def test_single_thin_wall_is_blocking():
    # One 0.6mm wall on an otherwise 2mm box: the volume / area average
    # missed it, the ray cast must not.
    issues, report = _issues(_box_with_one_wall(0.6))
    thin = _thin(issues)
    assert len(thin) == 1 and thin[0]["severity"] == BLOCKING
    assert "0.6" in thin[0]["message"]
    assert report["min_wall_mm"] == pytest.approx(0.6, abs=0.05)


def test_wall_under_recommended_minimum_is_advisory():
    thin = _thin(_issues(_box_with_one_wall(1.0))[0])
    assert len(thin) == 1 and thin[0]["severity"] == ADVISORY


def test_two_mm_walls_are_not_thin():
    issues, report = _issues(_box_with_one_wall(2.0))
    assert _thin(issues) == []
    assert report["min_wall_mm"] == pytest.approx(2.0, abs=0.05)


def test_acute_rim_is_not_a_thin_wall():
    # A 5mm-wide wall leaning 30 degrees: the rim meets the top face at an
    # acute angle, where normal rays leave through the top after a short run.
    profile = (
        cq.Workplane("XZ").polyline([(40, 0), (45, 0), (45 - 40 * np.tan(np.radians(30)), 40),
                                     (40 - 40 * np.tan(np.radians(30)), 40)]).close()
    )
    issues, report = _issues(profile.revolve(360, (0, 0, 0), (0, 1, 0)))
    assert _thin(issues) == []
    assert report["min_wall_mm"] > 4.0


def test_thickness_samples_are_deterministic():
    shape, tm = _mesh(_box_with_one_wall(1.0))
    a, _ = wall_thickness_samples(shape, tm, samples=200)
    b, _ = wall_thickness_samples(shape, tm, samples=200)
    np.testing.assert_array_equal(a, b)


def test_validate_mesh_without_shape_skips_ray_cast():
    # The STL-only entry point keeps working (no BRep to cast against).
    stl = export_to_bytes(as_export_shape(_box_with_one_wall(0.6)), "STL", ".stl")
    assert not any("thin walls" in w.lower() for w in validate_mesh(stl))


# --- Severities ---

def test_very_thin_part_is_blocking():
    issues, _ = _issues(cq.Workplane("XY").box(10, 10, 0.5))
    thin = _thin(issues)
    assert len(thin) == 1 and thin[0]["severity"] == BLOCKING


def test_overhang_is_advisory_and_reports_worst_angle_and_location():
    # Mushroom: the cap underside is a flat ceiling at z=20.
    result = (
        cq.Workplane("XY").circle(5).extrude(20)
        .faces(">Z").workplane().circle(15).extrude(3)
    )
    issues, report = _issues(result)
    overhang = [i for i in issues if "overhang" in i["message"].lower()]
    assert len(overhang) == 1 and overhang[0]["severity"] == ADVISORY
    assert "90 degrees from vertical" in overhang[0]["message"]
    assert report["overhang"]["worst_deg"] == pytest.approx(90.0, abs=0.5)
    assert report["overhang"]["at"][2] == pytest.approx(20.0, abs=0.1)


def test_overhang_report_without_warning():
    # A 45-60 degree chamfer under a ledge is reported but not warned about
    # when it is small.
    issues, report = _issues(cq.Workplane("XY").box(20, 20, 10, centered=(True, True, False)))
    assert report["overhang"] is None
    assert not any("overhang" in i["message"].lower() for i in issues)


def test_render_pipeline_classifies_build_overflow_as_blocking():
    out = _render_pipeline('import cadquery as cq\nresult = cq.Workplane("XY").box(300, 300, 2)')
    overflow = [i for i in out["issues"] if "Build plate overflow" in i["message"]]
    assert overflow and overflow[0]["severity"] == BLOCKING
    # warnings mirror the issue messages, in order.
    assert out["warnings"] == [i["message"] for i in out["issues"]]


# --- Geometry report ---

def _report(result, assembly=False):
    return geometry_report(as_export_shape(result), assembly)


def test_report_counts_through_holes():
    plate = (
        cq.Workplane("XY").box(60, 40, 5, centered=(True, True, False))
        .faces(">Z").workplane().rect(50, 30, forConstruction=True).vertices().hole(3.5)
    )
    report, issues = _report(plate)
    assert report["solid_count"] == 1
    assert report["hole_count"] == 4
    assert report["holes"] == [{"diameter": 3.5, "depth": 5.0, "axis": "Z", "through": True, "count": 4}]
    assert report["z_min"] == 0.0
    assert report["valid"] is True
    assert report["faces"]["plane"] == 6 and report["faces"]["cylinder"] == 4
    assert issues == []


def test_report_blind_and_counterbored_holes():
    block = cq.Workplane("XY").box(40, 20, 10, centered=(True, True, False))
    blind = block.faces(">Z").workplane().center(-10, 0).hole(4, depth=6)
    both = blind.faces(">Z").workplane().center(10, 0).cboreHole(3.4, 6.5, 3)
    report, _ = _report(both)
    assert report["hole_count"] == 2
    by_d = {h["diameter"]: h for h in report["holes"]}
    assert by_d[4.0]["through"] is False and by_d[4.0]["depth"] == pytest.approx(6.0, abs=0.01)
    # Counterbore + bore: one through hole, reported at the bore diameter.
    assert by_d[3.4]["through"] is True and by_d[3.4]["depth"] == pytest.approx(10.0, abs=0.01)


def test_report_ignores_slots_and_concave_fillets():
    slotted = (
        cq.Workplane("XY").box(40, 20, 3, centered=(True, True, False))
        .faces(">Z").workplane().slot2D(15, 4).cutThruAll()
    )
    assert _report(slotted)[0]["hole_count"] == 0
    l_shape = (
        cq.Workplane("XY").box(30, 20, 3, centered=(True, True, False))
        .union(cq.Workplane("XY").center(-13.5, 0).box(3, 20, 20, centered=(True, True, False)))
        .edges("|Y").edges(">X and <Z").fillet(1)
    )
    report, _ = _report(l_shape)
    assert report["hole_count"] == 0


def test_report_flags_part_off_the_bed():
    report, issues = _report(cq.Workplane("XY").box(10, 10, 10))
    assert report["z_min"] == -5.0
    assert any(i["severity"] == ADVISORY and "Not on the build plate" in i["message"] for i in issues)
    lifted = cq.Workplane("XY").workplane(offset=3).box(10, 10, 10, centered=(True, True, False))
    assert any("above z=0" in i["message"] for i in _report(lifted)[1])


def test_report_flags_disjoint_and_floating_solids():
    base = cq.Workplane("XY").box(10, 10, 10, centered=(True, True, False))
    floating = cq.Workplane("XY").workplane(offset=20).box(10, 10, 10, centered=(True, True, False))
    report, issues = _report(base.union(floating))
    assert report["solid_count"] == 2
    assert len(report["solids"]) == 2
    messages = " ".join(i["message"] for i in issues)
    assert "2 separate solids that are not fused" in messages
    assert "1 of 2 separate solids do not reach the bed" in messages


def test_report_assembly_parts_are_not_disjoint_warnings():
    asm = (
        cq.Assembly()
        .add(cq.Workplane("XY").box(10, 10, 10, centered=(True, True, False)))
        .add(cq.Workplane("XY").box(10, 10, 4, centered=(True, True, False)), loc=cq.Location((20, 0, 0)))
    )
    report, issues = _report(asm, assembly=True)
    assert report["solid_count"] == 2
    assert issues == []


def test_render_pipeline_returns_geometry():
    out = _render_pipeline(
        'import cadquery as cq\n'
        'result = cq.Workplane("XY").circle(30).extrude(6).faces(">Z").workplane()'
        '.polarArray(22.5, 0, 360, 6).hole(4.3)'
    )
    g = out["geometry"]
    assert g["solid_count"] == 1 and g["hole_count"] == 6
    # The thinnest webs run from the bolt holes to the rim (30 - 22.5 - 2.15).
    assert 5.0 < g["min_wall_mm"] <= 6.05
    assert out["views"] is None


# --- Views ---

def test_render_views_returns_three_pngs_with_visible_through_hole():
    plate = cq.Workplane("XY").box(40, 40, 4, centered=(True, True, False)).faces(">Z").workplane().hole(12)
    _, tm = _mesh(plate)
    views = render_views(tm.vertices, tm.faces, tm.face_normals)
    assert [v["name"] for v in views] == ["iso", "top", "front"]
    top = _decode_png(base64.b64decode(views[1]["png_base64"]))
    assert top.shape == (VIEW_SIZE_PX, VIEW_SIZE_PX, 3)
    c = VIEW_SIZE_PX // 2
    # Through the hole: background. Between hole and edge: the part.
    assert tuple(top[c, c]) == (255, 255, 255)
    assert tuple(top[c, c + VIEW_SIZE_PX // 3]) != (255, 255, 255)
    for v in views:
        assert len(base64.b64decode(v["png_base64"])) < 60_000


def test_encode_png_roundtrip():
    rgb = (np.arange(4 * 5 * 3) % 256).astype(np.uint8).reshape(4, 5, 3)
    np.testing.assert_array_equal(_decode_png(encode_png(rgb)), rgb)


def test_render_endpoint_views_only_on_request():
    code = 'import cadquery as cq\nresult = cq.Workplane("XY").box(12, 10, 8)'
    plain = client.post("/render", json={"code": code}).json()
    assert plain["views"] is None
    assert plain["geometry"]["solid_count"] == 1
    with_views = client.post("/render", json={"code": code, "views": True}).json()
    assert [v["name"] for v in with_views["views"]] == ["iso", "top", "front"]
    # Separate cache entries: the plain render must not be served views-less.
    assert client.post("/render", json={"code": code}).json()["views"] is None


# --- Review follow-ups: deadlines, drilled tips, touching parts ---

def test_slow_exec_skips_optional_analyses(monkeypatch):
    # A script whose exec + export eats the analysis share of EXEC_TIMEOUT
    # must still come back fast, without the optional analyses, instead of
    # being pushed past the hard kill.
    import time

    import main

    real_exec = main.exec_user_code

    def slow_exec(code):
        time.sleep(0.7)
        return real_exec(code)

    monkeypatch.setattr(main, "EXEC_TIMEOUT", 1)  # analysis deadline at 0.6 s
    monkeypatch.setattr(main, "exec_user_code", slow_exec)
    calls = []
    monkeypatch.setattr(cq.Shape, "isValid", lambda self: calls.append(1) or True)
    started = time.monotonic()
    out = main._render_pipeline(
        'import cadquery as cq\nresult = cq.Workplane("XY").box(20, 20, 5).faces(">Z").workplane().hole(4)',
        views=True,
    )
    elapsed = time.monotonic() - started
    g = out["geometry"]
    assert g["solid_count"] == 1  # cheap parts still reported
    assert g["hole_count"] is None and g["min_wall_mm"] is None and g["valid"] is None
    assert out["views"] is None
    assert calls == []
    assert elapsed < 1.0


def test_thickness_rays_stop_at_the_deadline():
    import time
    shape, tm = _mesh(_box_with_one_wall(1.0))
    t, _ = wall_thickness_samples(shape, tm, samples=500, deadline=time.monotonic() - 1)
    assert np.isnan(t).all()


def test_validity_check_skipped_on_large_shapes(monkeypatch):
    import main
    monkeypatch.setattr(main, "VALIDITY_MAX_FACES", 5)
    calls = []
    monkeypatch.setattr(cq.Shape, "isValid", lambda self: calls.append(1) or True)
    report, _ = _report(cq.Workplane("XY").box(10, 10, 10).faces(">Z").workplane().hole(3))
    assert report["valid"] is None and calls == []


@pytest.mark.parametrize("tip", ["cone", "ball"])
def test_blind_hole_with_drilled_tip_is_not_through(tip):
    # A 5mm bore 6mm deep ending in a 118 degree drill point or a ball end,
    # cut by revolving the profile: the bore ends in an empty tip.
    r, depth = 2.5, 6.0
    block = cq.Workplane("XY").box(20, 20, 15, centered=(True, True, False))
    if tip == "cone":
        tip_len = r / np.tan(np.radians(59))
        profile = cq.Workplane("XZ").polyline(
            [(0, 15), (r, 15), (r, 15 - depth), (0, 15 - depth - tip_len)]).close()
    else:
        profile = (cq.Workplane("XZ").moveTo(0, 15).lineTo(r, 15).lineTo(r, 15 - depth)
                   .threePointArc((r * np.sin(np.radians(45)), 15 - depth - r * np.cos(np.radians(45))),
                                  (0, 15 - depth - r)).close())
    drilled = block.cut(profile.revolve(360, (0, 0, 0), (0, 1, 0)))
    report, _ = _report(drilled)
    assert report["hole_count"] == 1
    hole = report["holes"][0]
    assert hole["diameter"] == pytest.approx(5.0) and hole["through"] is False


def test_touching_assembly_parts_are_not_blocking():
    # Two closed parts sharing a face: the combined mesh is open where they
    # touch, but each solid is closed.
    asm = (
        cq.Assembly()
        .add(cq.Workplane("XY").box(10, 10, 10, centered=(True, True, False)))
        .add(cq.Workplane("XY").box(10, 10, 10, centered=(True, True, False)), loc=cq.Location((10, 0, 0)))
    )
    shape, tm = _mesh(asm)
    issues, _ = inspect_mesh(tm, shape)
    watertight = [i for i in issues if "watertight" in i["message"].lower()]
    assert watertight and all(i["severity"] == ADVISORY for i in watertight)
    # Rays from the shared face must not read the touching faces as a wall.
    assert not [i for i in issues if i["severity"] == BLOCKING]


def test_open_single_body_is_still_blocking():
    # An open mesh with no BRep to check per body stays blocking.
    import io as _io
    import trimesh as _trimesh
    box = _trimesh.creation.box((10, 10, 10))
    box.update_faces(np.arange(len(box.faces)) != 0)
    buf = _io.BytesIO()
    box.export(buf, file_type="stl")
    issues, _ = inspect_mesh(load_mesh(buf.getvalue()))
    assert any(i["severity"] == BLOCKING and "watertight" in i["message"].lower() for i in issues)
