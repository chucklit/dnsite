#!/usr/bin/env python3
"""Build loader/assets/world.svg and loader/assets/centroids.json from the
world-atlas countries-110m.json TopoJSON.

    curl -sSL -o data/raw_map/countries-110m.json \
        https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json
    python -I tools/make_map.py            # run from the tools/ folder or repo root

Only the standard library plus pycountry (M49 numeric -> ISO alpha-2) is used.
The TopoJSON is decoded by hand (quantized, delta-encoded arcs), rotated so
10E is the central meridian, projected with Equal Earth, split at the
antimeridian, and written as one <path id="XX"> per country.
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

try:
    import pycountry
except ImportError:  # pragma: no cover
    sys.exit("pycountry is required: pip install pycountry")

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "data" / "raw_map" / "countries-110m.json"
OUT_SVG = ROOT / "loader" / "assets" / "world.svg"
OUT_JSON = ROOT / "loader" / "assets" / "centroids.json"

CENTRAL_MERIDIAN = 10.0      # degrees east; Europe/Greece near the middle
WIDTH = 1000.0               # viewBox width
LAT_MIN, LAT_MAX = -56.5, 84.0  # vertical crop once Antarctica is dropped
MIN_RING_AREA = 0.6          # px^2, after projection; drops specks
SIMPLIFY_AREA = 0.65         # px^2 Visvalingam threshold on shared arcs (0 = off)
DROP_NUMERIC = {"010"}       # Antarctica
EXTRA_CODES = {"Kosovo": "XK"}  # entries with no M49 id that still get a code
GRATICULE_STEP = 30

# --- Equal Earth -----------------------------------------------------------
A1, A2, A3, A4 = 1.340264, -0.081106, 0.000893, 0.003796
M = math.sqrt(3) / 2


def equal_earth(lon_deg: float, lat_deg: float) -> tuple[float, float]:
    lam = math.radians(lon_deg)
    phi = math.radians(lat_deg)
    theta = math.asin(M * math.sin(phi))
    t2 = theta * theta
    t6 = t2 * t2 * t2
    x = lam * math.cos(theta) / (M * (A1 + 3 * A2 * t2 + t6 * (7 * A3 + 9 * A4 * t2)))
    y = theta * (A1 + A2 * t2 + t6 * (A3 + A4 * t2))
    return x, y


def rotate_lon(lon: float) -> float:
    """Longitude relative to the central meridian, wrapped to [-180, 180)."""
    lon = lon - CENTRAL_MERIDIAN
    return (lon + 180.0) % 360.0 - 180.0


# --- TopoJSON decoding -----------------------------------------------------
def decode_arcs(topo: dict) -> list[list[tuple[float, float]]]:
    sx, sy = topo["transform"]["scale"]
    tx, ty = topo["transform"]["translate"]
    arcs = []
    for arc in topo["arcs"]:
        x = y = 0
        pts = []
        for dx, dy in arc:
            x += dx
            y += dy
            pts.append((x * sx + tx, y * sy + ty))
        arcs.append(pts)
    return arcs


def simplify_arcs(arcs, threshold):
    """Visvalingam-Whyatt on each shared arc, measured in projected px^2, so
    neighbouring countries keep identical borders (no slivers)."""
    if threshold <= 0:
        return arcs
    x_half = equal_earth(180.0, 0.0)[0]
    scale = WIDTH / (2 * x_half)
    out = []
    for arc in arcs:
        if len(arc) <= 2:
            out.append(arc)
            continue
        # continuous (unwrapped) projection of the arc for area measurement
        px = []
        prev = None
        for lon, lat in arc:
            lon = rotate_lon(lon)
            if prev is not None:
                while lon - prev > 180:
                    lon -= 360
                while lon - prev < -180:
                    lon += 360
            prev = lon
            x, y = equal_earth(lon, lat)
            px.append((x * scale, y * scale))
        keep = list(range(len(arc)))
        def tri(i, j, k):
            (x1, y1), (x2, y2), (x3, y3) = px[i], px[j], px[k]
            return abs((x2 - x1) * (y3 - y1) - (x3 - x1) * (y2 - y1)) / 2
        while len(keep) > 2:
            areas = [tri(keep[i - 1], keep[i], keep[i + 1]) for i in range(1, len(keep) - 1)]
            m = min(areas)
            if m >= threshold:
                break
            del keep[areas.index(m) + 1]
        out.append([arc[i] for i in keep])
    return out


def ring_coords(ring: list[int], arcs) -> list[tuple[float, float]]:
    pts: list[tuple[float, float]] = []
    for idx in ring:
        seg = arcs[idx] if idx >= 0 else arcs[~idx][::-1]
        if pts and pts[-1] == seg[0]:
            seg = seg[1:]
        pts.extend(seg)
    return pts


def geometry_polygons(geom: dict, arcs) -> list[list[list[tuple[float, float]]]]:
    """Return a list of polygons; each polygon is a list of rings (outer first)."""
    if geom["type"] == "Polygon":
        polys = [geom["arcs"]]
    elif geom["type"] == "MultiPolygon":
        polys = geom["arcs"]
    else:
        return []
    return [[ring_coords(r, arcs) for r in poly] for poly in polys]


# --- Antimeridian handling -------------------------------------------------
def unwrap(ring):
    """Rotate longitudes and make the ring continuous (no 360-degree jumps)."""
    out = []
    prev = None
    for lon, lat in ring:
        lon = rotate_lon(lon)
        if prev is not None:
            while lon - prev > 180:
                lon -= 360
            while lon - prev < -180:
                lon += 360
        out.append((lon, lat))
        prev = lon
    return out


def clip_lon(ring, lo=-180.0, hi=180.0):
    """Sutherland-Hodgman clip of a lon/lat ring to lo <= lon <= hi."""
    def clip(points, edge, keep):
        res = []
        n = len(points)
        for i in range(n):
            cur = points[i]
            prv = points[i - 1]
            cin, pin = keep(cur[0], edge), keep(prv[0], edge)
            if cin:
                if not pin:
                    res.append(cross(prv, cur, edge))
                res.append(cur)
            elif pin:
                res.append(cross(prv, cur, edge))
        return res

    def cross(a, b, edge):
        t = (edge - a[0]) / (b[0] - a[0])
        return (edge, a[1] + t * (b[1] - a[1]))

    r = clip(ring, lo, lambda x, e: x >= e)
    if len(r) >= 3:
        r = clip(r, hi, lambda x, e: x <= e)
    return r if len(r) >= 3 else []


def densify_meridian_edges(ring, step=2.0):
    """Edges that run along the clip meridian are straight in lon/lat but curved
    once projected, so interpolate latitude along them."""
    out = []
    n = len(ring)
    for i in range(n):
        a, b = ring[i], ring[(i + 1) % n]
        out.append(a)
        if abs(a[0]) == 180.0 and a[0] == b[0] and abs(b[1] - a[1]) > step:
            k = int(abs(b[1] - a[1]) // step)
            for j in range(1, k + 1):
                out.append((a[0], a[1] + (b[1] - a[1]) * j / (k + 1)))
    return out


def split_ring(ring):
    """Split a lon/lat ring at the antimeridian of the rotated frame."""
    u = unwrap(ring)
    lons = [p[0] for p in u]
    pieces = []
    for shift in (-360.0, 0.0, 360.0):
        if max(lons) + shift < -180.0 or min(lons) + shift > 180.0:
            continue
        shifted = [(x + shift, y) for x, y in u]
        c = clip_lon(shifted)
        if c:
            pieces.append(densify_meridian_edges(c))
    return pieces


# --- Geometry helpers -------------------------------------------------------
def shoelace(pts):
    a = 0.0
    n = len(pts)
    for i in range(n):
        x1, y1 = pts[i]
        x2, y2 = pts[(i + 1) % n]
        a += x1 * y2 - x2 * y1
    return a / 2


def point_in_ring(pt, ring):
    x, y = pt
    inside = False
    n = len(ring)
    for i in range(n):
        x1, y1 = ring[i]
        x2, y2 = ring[(i + 1) % n]
        if (y1 > y) != (y2 > y):
            xi = x1 + (y - y1) * (x2 - x1) / (y2 - y1)
            if x < xi:
                inside = not inside
    return inside


def point_on_surface(ring):
    """Centroid if it is inside the ring, else the midpoint of the longest
    horizontal interior span through the centroid's row (or near it)."""
    a = shoelace(ring)
    if abs(a) < 1e-9:
        return ring[0]
    cx = cy = 0.0
    n = len(ring)
    for i in range(n):
        x1, y1 = ring[i]
        x2, y2 = ring[(i + 1) % n]
        f = x1 * y2 - x2 * y1
        cx += (x1 + x2) * f
        cy += (y1 + y2) * f
    cx /= 6 * a
    cy /= 6 * a
    if point_in_ring((cx, cy), ring):
        return cx, cy
    ys = [p[1] for p in ring]
    ymin, ymax = min(ys), max(ys)
    best = None
    for frac in (0.0, 0.1, -0.1, 0.2, -0.2, 0.3, -0.3, 0.4, -0.4):
        y = cy + frac * (ymax - ymin)
        xs = []
        for i in range(n):
            x1, y1 = ring[i]
            x2, y2 = ring[(i + 1) % n]
            if (y1 > y) != (y2 > y):
                xs.append(x1 + (y - y1) * (x2 - x1) / (y2 - y1))
        xs.sort()
        for j in range(0, len(xs) - 1, 2):
            w = xs[j + 1] - xs[j]
            if best is None or w > best[0]:
                best = (w, (xs[j] + xs[j + 1]) / 2, y)
        if best and best[0] > 0:
            break
    return (best[1], best[2]) if best else (cx, cy)


# --- Path encoding ---------------------------------------------------------
def fmt(v: int) -> str:
    """Tenths-integer -> shortest decimal string."""
    s = "-" if v < 0 else ""
    v = abs(v)
    return f"{s}{v // 10}" if v % 10 == 0 else f"{s}{v // 10}.{v % 10}"


def ring_path(ring_px) -> str:
    """Relative-move path for a ring, coordinates in tenths of a px."""
    q = []
    for x, y in ring_px:
        p = (round(x * 10), round(y * 10))
        if not q or q[-1] != p:
            q.append(p)
    if len(q) > 1 and q[0] == q[-1]:
        q.pop()
    if len(q) < 3:
        return ""
    parts = [f"M{fmt(q[0][0])} {fmt(q[0][1])}"]
    px, py = q[0]
    for x, y in q[1:]:
        dx, dy = x - px, y - py
        if dy == 0:
            parts.append(f"h{fmt(dx)}")
        elif dx == 0:
            parts.append(f"v{fmt(dy)}")
        else:
            sx, sy = fmt(dx), fmt(dy)
            parts.append(f"l{sx}{'' if sy.startswith('-') else ' '}{sy}")
        px, py = x, y
    parts.append("z")
    return "".join(parts)


def xml_attr(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


# --- Main ------------------------------------------------------------------
def main() -> None:
    topo = json.loads(SRC.read_text())
    arcs = simplify_arcs(decode_arcs(topo), SIMPLIFY_AREA)
    geoms = topo["objects"]["countries"]["geometries"]

    # Projection -> pixel transform. x spans the full Equal Earth width.
    x_half = equal_earth(180.0, 0.0)[0]
    scale = WIDTH / (2 * x_half)
    y_top = equal_earth(0.0, LAT_MAX)[1]
    y_bot = equal_earth(0.0, LAT_MIN)[1]
    height = (y_top - y_bot) * scale

    def to_px(lon, lat):
        x, y = equal_earth(lon, lat)
        return (x + x_half) * scale, (y_top - y) * scale

    skipped: list[str] = []
    countries: list[tuple[str, str, list[list[tuple[float, float]]]]] = []  # (iso2, name, rings_px)
    centroids: dict[str, list[float]] = {}
    seen: set[str] = set()

    for g in geoms:
        name = g["properties"]["name"]
        num = g.get("id")
        if num in DROP_NUMERIC:
            skipped.append(f"{name} (dropped on purpose)")
            continue
        iso2 = None
        if num and num.isdigit():
            c = pycountry.countries.get(numeric=num)
            if c:
                iso2 = c.alpha_2
        if iso2 is None:
            iso2 = EXTRA_CODES.get(name)
        if iso2 is None:
            skipped.append(f"{name} (id={num!r}: no ISO 3166-1 code)")
            continue
        if iso2 in seen:
            skipped.append(f"{name} (duplicate of {iso2})")
            continue

        rings_px: list[list[tuple[float, float]]] = []
        best_area = -1.0
        best_ring = None
        for poly in geometry_polygons(g, arcs):
            outer_pieces = split_ring(poly[0])
            holes = [p for r in poly[1:] for p in split_ring(r)]
            for piece in outer_pieces:
                px = [to_px(*p) for p in piece]
                area = abs(shoelace(px))
                if area < MIN_RING_AREA:
                    continue
                rings_px.append(px)
                if area > best_area:
                    best_area, best_ring = area, px
            for hole in holes:
                px = [to_px(*p) for p in hole]
                if abs(shoelace(px)) >= MIN_RING_AREA:
                    rings_px.append(px)
        if not rings_px or best_ring is None:
            skipped.append(f"{name} (no drawable geometry)")
            continue
        seen.add(iso2)
        countries.append((iso2, name, rings_px))
        cx, cy = point_on_surface(best_ring)
        centroids[iso2] = [round(cx, 1), round(cy, 1)]

    countries.sort(key=lambda c: c[0])

    # Graticule: parallels and meridians every 30 degrees plus the outline,
    # all in one path. Longitudes are in the rotated frame.
    def polyline(points):
        q = []
        for x, y in points:
            p = (round(x * 10), round(y * 10))
            if not q or q[-1] != p:
                q.append(p)
        out = [f"M{fmt(q[0][0])} {fmt(q[0][1])}"]
        px, py = q[0]
        for x, y in q[1:]:
            sx, sy = fmt(x - px), fmt(y - py)
            out.append(f"l{sx}{'' if sy.startswith('-') else ' '}{sy}")
            px, py = x, y
        return "".join(out)

    grat = []
    lat_lo = math.ceil(LAT_MIN / GRATICULE_STEP) * GRATICULE_STEP
    lat_hi = math.floor(LAT_MAX / GRATICULE_STEP) * GRATICULE_STEP
    for lat in range(lat_lo, lat_hi + 1, GRATICULE_STEP):
        grat.append(polyline([to_px(lon, lat) for lon in range(-180, 181, 5)]))
    for lon_true in range(-180, 180, GRATICULE_STEP):
        lon = rotate_lon(lon_true)
        grat.append(polyline([to_px(lon, lat) for lat in
                              [LAT_MIN] + list(range(int(LAT_MIN) + 1, int(LAT_MAX), 2)) + [LAT_MAX]]))
    # outline (the two edge meridians of the rotated frame, clipped to the crop)
    for lon in (-180.0, 180.0):
        grat.append(polyline([to_px(lon, lat) for lat in
                              [LAT_MIN] + list(range(int(LAT_MIN) + 1, int(LAT_MAX), 2)) + [LAT_MAX]]))

    h = math.ceil(height * 10) / 10
    lines = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {int(WIDTH)} {fmt(round(h * 10))}">',
        f'<g id="graticule"><path fill="none" d="{"".join(grat)}"/></g>',
        '<g id="countries">',
    ]
    for iso2, name, rings in countries:
        d = "".join(ring_path(r) for r in rings)
        if not d:
            continue
        lines.append(f'<path id="{iso2}" data-name="{xml_attr(name)}" d="{d}"/>')
    lines.append("</g></svg>")
    OUT_SVG.parent.mkdir(parents=True, exist_ok=True)
    OUT_SVG.write_text("\n".join(lines) + "\n", encoding="utf-8")
    OUT_JSON.write_text(json.dumps(centroids, separators=(",", ":"), sort_keys=True) + "\n")

    print(f"wrote {OUT_SVG} ({OUT_SVG.stat().st_size:,} bytes, {len(countries)} countries, "
          f"viewBox 0 0 {int(WIDTH)} {fmt(round(h * 10))})")
    print(f"wrote {OUT_JSON} ({OUT_JSON.stat().st_size:,} bytes)")
    print("skipped:")
    for s in skipped:
        print("  -", s)


if __name__ == "__main__":
    main()
