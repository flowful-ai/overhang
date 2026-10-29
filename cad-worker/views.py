"""Small shaded preview images of a render, for the model's visual self-check.

A software z-buffer rasterizer in numpy plus a stdlib PNG encoder: no GL, no
display and no extra dependency, so it runs the same in the container, in CI
and on a dev machine. Output is deliberately plain: flat Lambert shading, dark
lines on creases and silhouettes, back faces (an open or inverted mesh) in red,
and the build plate (z = 0) as a grey line in the front view. Each view is
fitted to the part, orthographic, Z up.
"""
import base64
import struct
import zlib

import numpy as np

VIEW_SIZE_PX = 384
# Fraction of the image left empty on each side of the fitted part.
_MARGIN = 0.06
# Upper bound on candidate pixels rasterized per numpy batch (memory bound:
# ~50 bytes per candidate).
_BATCH_PIXELS = 1_500_000
# Adjacent pixels whose surface normals differ by more than this get an edge
# line. Above the export mesh's 0.2 rad (~11.5 deg) facet angle, so curved
# faces stay smooth.
_CREASE_DEG = 25.0

_BG = np.array([255, 255, 255], dtype=np.float64)
_BODY = np.array([150, 175, 215], dtype=np.float64)
_BACK = np.array([220, 60, 60], dtype=np.float64)
_EDGE = np.array([35, 40, 55], dtype=np.float64)
_BED = np.array([150, 150, 150], dtype=np.float64)

# name -> (view direction, i.e. from the eye into the scene; screen up vector)
VIEWS = {
    "iso": ((-1.0, 1.0, -1.0), (0.0, 0.0, 1.0)),
    "top": ((0.0, 0.0, -1.0), (0.0, 1.0, 0.0)),
    "front": ((0.0, 1.0, 0.0), (0.0, 0.0, 1.0)),
}

# What each view shows, in the words the model gets next to the image.
VIEW_DESCRIPTIONS = {
    "iso": "isometric, from the front-right-top (+X right and away, +Y right and back, +Z up)",
    "top": "top, looking down -Z (+X right, +Y up)",
    "front": "front, looking along +Y (+X right, +Z up; grey line = build plate z=0)",
}


def _camera(direction, up):
    d = np.asarray(direction, dtype=np.float64)
    d /= np.linalg.norm(d)
    right = np.cross(d, np.asarray(up, dtype=np.float64))
    right /= np.linalg.norm(right)
    true_up = np.cross(right, d)
    return d, right, true_up


def _rasterize(px: np.ndarray, depth: np.ndarray, size: int) -> np.ndarray:
    """Z-buffer rasterize triangles given in pixel coordinates. `px` is
    (T, 3, 2) (x right, y down), `depth` is (T, 3), larger = farther. Returns
    the winning triangle index per pixel (size*size, -1 = background).

    Each triangle tests the pixel centres of its bounding box (edge functions,
    inclusive, so shared edges leave no cracks). Batches are vectorized and
    bounded by _BATCH_PIXELS candidates."""
    x, y = px[..., 0], px[..., 1]
    x0 = np.clip(np.ceil(x.min(axis=1) - 0.5), 0, size - 1).astype(np.int64)
    x1 = np.clip(np.floor(x.max(axis=1) - 0.5), 0, size - 1).astype(np.int64)
    y0 = np.clip(np.ceil(y.min(axis=1) - 0.5), 0, size - 1).astype(np.int64)
    y1 = np.clip(np.floor(y.max(axis=1) - 0.5), 0, size - 1).astype(np.int64)
    w = x1 - x0 + 1
    h = y1 - y0 + 1
    a, b, c = px[:, 0], px[:, 1], px[:, 2]
    area2 = (b[:, 0] - a[:, 0]) * (c[:, 1] - a[:, 1]) - (b[:, 1] - a[:, 1]) * (c[:, 0] - a[:, 0])
    keep = (w > 0) & (h > 0) & (np.abs(area2) > 1e-12)
    tris = np.flatnonzero(keep)
    counts = (w * h)[tris]

    zbuf = np.full(size * size, np.inf)
    tbuf = np.full(size * size, -1, dtype=np.int64)
    if len(tris) == 0:
        return tbuf
    ends = np.cumsum(counts)
    start = 0
    while start < len(tris):
        # Next batch: as many triangles as fit in _BATCH_PIXELS (at least one).
        base = ends[start - 1] if start else 0
        stop = int(np.searchsorted(ends, base + _BATCH_PIXELS, side="right"))
        stop = max(stop, start + 1)
        t = tris[start:stop]
        n = counts[start:stop]
        start = stop

        ti = np.repeat(t, n)
        local = np.arange(int(n.sum())) - np.repeat(np.cumsum(n) - n, n)
        cx = x0[ti] + local % w[ti]
        cy = y0[ti] + local // w[ti]
        pxc = cx + 0.5
        pyc = cy + 0.5
        ax, ay = a[ti, 0], a[ti, 1]
        bx, by = b[ti, 0], b[ti, 1]
        qx, qy = c[ti, 0], c[ti, 1]
        inv = 1.0 / area2[ti]
        w0 = ((bx - pxc) * (qy - pyc) - (by - pyc) * (qx - pxc)) * inv
        w1 = ((qx - pxc) * (ay - pyc) - (qy - pyc) * (ax - pxc)) * inv
        w2 = 1.0 - w0 - w1
        eps = -1e-9
        inside = (w0 >= eps) & (w1 >= eps) & (w2 >= eps)
        if not inside.any():
            continue
        ti, cx, cy = ti[inside], cx[inside], cy[inside]
        z = (w0[inside] * depth[ti, 0] + w1[inside] * depth[ti, 1] + w2[inside] * depth[ti, 2])
        pix = cy * size + cx
        np.minimum.at(zbuf, pix, z)
        win = z <= zbuf[pix]
        tbuf[pix[win]] = ti[win]
    return tbuf


def render_view(vertices: np.ndarray, faces: np.ndarray, face_normals: np.ndarray,
                direction, up, size: int = VIEW_SIZE_PX, bed_line: bool = False) -> np.ndarray:
    """Render one orthographic view to an (size, size, 3) uint8 RGB array."""
    d, right, true_up = _camera(direction, up)
    sx = vertices @ right
    sy = vertices @ true_up
    sz = vertices @ d
    cx = (sx.min() + sx.max()) / 2
    cy = (sy.min() + sy.max()) / 2
    span = max(sx.max() - sx.min(), sy.max() - sy.min(), 1e-6)
    scale = size * (1 - 2 * _MARGIN) / span
    vx = (sx - cx) * scale + size / 2
    vy = size / 2 - (sy - cy) * scale

    px = np.stack([vx[faces], vy[faces]], axis=-1)
    tbuf = _rasterize(px, sz[faces], size)

    hit = tbuf >= 0
    img = np.tile(_BG, (size * size, 1))
    n = face_normals[tbuf[hit]]
    facing = n @ d
    light = -d + 0.6 * true_up - 0.35 * right
    light /= np.linalg.norm(light)
    lambert = np.clip(n @ light, 0.0, 1.0)
    shade = (0.35 + 0.65 * lambert)[:, None]
    img[hit] = np.where((facing <= 0)[:, None], _BODY * shade, _BACK * shade)

    # Edge lines: a pixel next to background, or whose normal turns by more
    # than _CREASE_DEG against its right or lower neighbour.
    normals = np.zeros((size * size, 3))
    normals[hit] = n
    normals = normals.reshape(size, size, 3)
    hit2 = hit.reshape(size, size)
    edge = np.zeros((size, size), dtype=bool)
    cos_lim = np.cos(np.radians(_CREASE_DEG))
    for axis in (0, 1):
        a_hit = hit2
        b_hit = np.roll(hit2, -1, axis=axis)
        dots = (normals * np.roll(normals, -1, axis=axis)).sum(axis=2)
        e = (a_hit != b_hit) | (a_hit & b_hit & (dots < cos_lim))
        # np.roll wraps around; the last row/column has no neighbour.
        if axis == 0:
            e[-1, :] = False
        else:
            e[:, -1] = False
        edge |= e
    img = img.reshape(size, size, 3)
    img[edge] = _EDGE

    if bed_line:
        # Screen row of z = 0 in this view (front: screen up is +Z).
        row = int(round(size / 2 - (0.0 - cy) * scale))
        if 0 <= row < size:
            cols = np.arange(size)
            dashed = (cols // 6) % 2 == 0
            img[row, dashed & ~hit2[row]] = _BED
    return img.astype(np.uint8)


def encode_png(rgb: np.ndarray) -> bytes:
    """Minimal 8-bit RGB PNG encoder (stdlib zlib)."""
    h, w, _ = rgb.shape
    raw = np.concatenate([np.zeros((h, 1), dtype=np.uint8), rgb.reshape(h, w * 3)], axis=1).tobytes()

    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def render_views(vertices: np.ndarray, faces: np.ndarray, face_normals: np.ndarray,
                 size: int = VIEW_SIZE_PX) -> list[dict]:
    """The three standard views as [{"name", "png_base64"}], in VIEWS order."""
    out = []
    for name, (direction, up) in VIEWS.items():
        img = render_view(vertices, faces, face_normals, direction, up, size, bed_line=name == "front")
        out.append({"name": name, "png_base64": base64.b64encode(encode_png(img)).decode("ascii")})
    return out
