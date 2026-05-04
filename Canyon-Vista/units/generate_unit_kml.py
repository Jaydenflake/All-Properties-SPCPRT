#!/usr/bin/env python3
"""Generate pixel-space Canyon Vista unit polygons and one combined KML.

The source sitemap is not georeferenced. KML coordinates intentionally encode
image pixels as lon/lat-like values:

    lon = x / 10000
    lat = -y / 10000

This keeps the exported KML selectable by unit while preserving the original
image coordinate system for QA.
"""
from __future__ import annotations

import json
import math
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import Path
from xml.dom import minidom

import cv2
import numpy as np
from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[2]
UNITS_DIR = ROOT / "Canyon-Vista" / "units"
EXPORTS_DIR = ROOT / "Canyon-Vista" / "exports"
SOURCE_IMAGE = UNITS_DIR / "canyon_vista_sitemap.png"
CLICKS_JSON = UNITS_DIR / "clicks.json"
POLYGONS_JSON = UNITS_DIR / "unit_polygons.image.json"
KML_PATH = EXPORTS_DIR / "canyon-vista-units.kml"
OVERLAY_PATH = EXPORTS_DIR / "canyon-vista-units-overlay.png"
SCALE = 10_000.0


@dataclass
class Component:
    component_id: int
    area: int
    bbox: tuple[int, int, int, int]
    centroid: tuple[float, float]
    polygon: list[list[float]]


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def save_json(path: Path, data: dict) -> None:
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


def polygon_area(points: list[list[float]]) -> float:
    total = 0.0
    for idx, point in enumerate(points):
        nxt = points[(idx + 1) % len(points)]
        total += point[0] * nxt[1] - nxt[0] * point[1]
    return abs(total) / 2.0


def polygon_center(points: list[list[float]]) -> list[float]:
    area_factor = 0.0
    cx = 0.0
    cy = 0.0
    for idx, point in enumerate(points):
        nxt = points[(idx + 1) % len(points)]
        cross = point[0] * nxt[1] - nxt[0] * point[1]
        area_factor += cross
        cx += (point[0] + nxt[0]) * cross
        cy += (point[1] + nxt[1]) * cross
    if abs(area_factor) < 1e-6:
        return [
            round(sum(point[0] for point in points) / len(points), 3),
            round(sum(point[1] for point in points) / len(points), 3),
        ]
    return [round(cx / (3.0 * area_factor), 3), round(cy / (3.0 * area_factor), 3)]


def order_clockwise(points: list[list[float]]) -> list[list[float]]:
    cx = sum(point[0] for point in points) / len(points)
    cy = sum(point[1] for point in points) / len(points)
    ordered = sorted(points, key=lambda point: math.atan2(point[1] - cy, point[0] - cx))
    if signed_area(ordered) < 0:
        ordered.reverse()
    return ordered


def signed_area(points: list[list[float]]) -> float:
    total = 0.0
    for idx, point in enumerate(points):
        nxt = points[(idx + 1) % len(points)]
        total += point[0] * nxt[1] - nxt[0] * point[1]
    return total / 2.0


def clean_polygon(points: list[list[float]], image_width: int, image_height: int) -> list[list[float]]:
    cleaned: list[list[float]] = []
    for x, y in points:
        px = min(max(float(x), 0.0), float(image_width))
        py = min(max(float(y), 0.0), float(image_height))
        point = [round(px, 3), round(py, 3)]
        if not cleaned or cleaned[-1] != point:
            cleaned.append(point)
    if len(cleaned) > 1 and cleaned[0] == cleaned[-1]:
        cleaned.pop()
    return order_clockwise(cleaned)


def expand_from_center(points: list[list[float]], amount: float) -> list[list[float]]:
    cx = sum(point[0] for point in points) / len(points)
    cy = sum(point[1] for point in points) / len(points)
    out = []
    for x, y in points:
        dx = x - cx
        dy = y - cy
        length = math.hypot(dx, dy)
        if length < 1e-6:
            out.append([x, y])
        else:
            out.append([x + amount * dx / length, y + amount * dy / length])
    return out


def load_components(
    image_rgb: np.ndarray,
    saturation_min: int,
    value_min: int,
    *,
    image_width: int,
    image_height: int,
) -> list[Component]:
    hsv = cv2.cvtColor(image_rgb, cv2.COLOR_RGB2HSV)
    _h, saturation, value = cv2.split(hsv)
    mask = (
        (saturation > saturation_min)
        & (value > value_min)
        & (image_rgb[:, :, 0] < 252)
        & (image_rgb[:, :, 1] < 252)
        & (image_rgb[:, :, 2] < 252)
    )
    mask[:, :400] = False
    mask[:, 1500:] = False
    mask[:100, :] = False
    mask[950:, :] = False

    eroded = cv2.erode(mask.astype("uint8") * 255, np.ones((3, 3), np.uint8), iterations=1)
    count, labels, stats, centroids = cv2.connectedComponentsWithStats(eroded, 8)

    components: list[Component] = []
    for component_id in range(1, count):
        x, y, width, height, area = (int(v) for v in stats[component_id])
        if not (100 < area < 12_000 and 10 < width < 130 and 10 < height < 160):
            continue

        component_mask = (labels == component_id).astype("uint8") * 255
        contours, _hierarchy = cv2.findContours(component_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if not contours:
            continue
        contour = max(contours, key=cv2.contourArea)
        hull = cv2.convexHull(contour)
        epsilon = max(2.0, 0.015 * cv2.arcLength(hull, True))
        approx = cv2.approxPolyDP(hull, epsilon, True).reshape(-1, 2)
        if len(approx) < 4:
            approx = np.array([[x, y], [x + width, y], [x + width, y + height], [x, y + height]], dtype=np.float64)

        points = [[float(px), float(py)] for px, py in approx.tolist()]
        points = expand_from_center(points, 3.0)
        components.append(
            Component(
                component_id=component_id,
                area=area,
                bbox=(x, y, width, height),
                centroid=(float(centroids[component_id][0]), float(centroids[component_id][1])),
                polygon=clean_polygon(points, image_width, image_height),
            )
        )
    return components


def corrected_unit_seeds() -> dict[int, tuple[float, float]]:
    raw_clicks = load_json(CLICKS_JSON)["clicks"]
    seeds: dict[int, tuple[float, float]] = {}
    for entry in raw_clicks:
        unit_text = str(entry["unit"])
        if unit_text == "00":
            continue
        x, y = (float(v) for v in entry["positive_px"][:2])
        unit = int(unit_text)
        if unit == 78 and y < 300:
            unit = 73
        seeds[unit] = (x, y)

    # Unit 27 is visible as a faint white/gray label and is absent from clicks.
    seeds[27] = (621.0, 558.0)
    missing = [unit for unit in range(1, 88) if unit not in seeds]
    if missing:
        raise RuntimeError(f"missing corrected seeds for units: {missing}")
    return seeds


def choose_component(components: list[Component], x: float, y: float) -> Component:
    containing = []
    for component in components:
        bx, by, bw, bh = component.bbox
        if bx - 20 <= x <= bx + bw + 20 and by - 20 <= y <= by + bh + 20:
            containing.append(component)
    candidates = containing or components
    return min(candidates, key=lambda c: (c.centroid[0] - x) ** 2 + (c.centroid[1] - y) ** 2)


def rect(x1: float, y1: float, x2: float, y2: float) -> list[list[float]]:
    return [[x1, y1], [x2, y1], [x2, y2], [x1, y2]]


def manual_overrides() -> dict[int, tuple[list[list[float]], str]]:
    return {
        31: (rect(590, 381, 640, 429), "manual: unit 31 mask is pulled into the corridor by thresholding"),
        27: (rect(582, 536, 641, 590), "manual: faint unit 27 is white/gray, not a colored mask"),
        50: (rect(925, 379, 975, 412), "manual: unit 50 mask is merged with adjacent storage/amenity color"),
        51: (rect(986, 377, 1036, 427), "manual: unit 51 mask is merged with resident-storage text block"),
        61: (rect(1101, 475, 1151, 524), "manual: split merged 61/63 colored component"),
        63: (rect(1151, 475, 1210, 524), "manual: split merged 61/63 colored component"),
    }


def snap_axis_values(units: list[dict], tolerance: float = 4.0) -> None:
    """Snap nearly equal x/y vertex values so shared rectilinear walls coincide."""
    for axis_index in (0, 1):
        values = sorted(point[axis_index] for unit in units for point in unit["corners_px"])
        clusters: list[list[float]] = []
        for value in values:
            if not clusters or value - clusters[-1][-1] > tolerance:
                clusters.append([value])
            else:
                clusters[-1].append(value)
        replacements = {}
        for cluster in clusters:
            if len(cluster) < 2:
                continue
            avg = round(sum(cluster) / len(cluster), 3)
            for value in cluster:
                replacements[value] = avg
        for unit in units:
            for point in unit["corners_px"]:
                if point[axis_index] in replacements:
                    point[axis_index] = replacements[point[axis_index]]


def build_unit_polygons() -> dict:
    image = Image.open(SOURCE_IMAGE).convert("RGB")
    image_width, image_height = image.size
    image_rgb = np.array(image)
    high_components = load_components(image_rgb, 35, 90, image_width=image_width, image_height=image_height)
    low_components = load_components(image_rgb, 25, 65, image_width=image_width, image_height=image_height)
    low_component_units = {31, 36, 37, 57, 58, 73, 74}
    overrides = manual_overrides()
    seeds = corrected_unit_seeds()

    units: list[dict] = []
    for unit in range(1, 88):
        notes: list[str] = []
        if unit in overrides:
            polygon, note = overrides[unit]
            notes.append(note)
        else:
            source_components = low_components if unit in low_component_units else high_components
            component = choose_component(source_components, *seeds[unit])
            polygon = component.polygon
            notes.append(
                f"cv: component={component.component_id} bbox={component.bbox} "
                f"threshold={'low' if unit in low_component_units else 'high'}"
            )

        polygon = clean_polygon(polygon, image_width, image_height)
        units.append(
            {
                "unit": unit,
                "corners_px": polygon,
                "center_px": polygon_center(polygon),
                "area_px2": round(polygon_area(polygon), 3),
                "qa_notes": notes,
            }
        )

    snap_axis_values(units)
    for unit in units:
        unit["corners_px"] = clean_polygon(unit["corners_px"], image_width, image_height)
        unit["center_px"] = polygon_center(unit["corners_px"])
        unit["area_px2"] = round(polygon_area(unit["corners_px"]), 3)

    return {
        "version": 1,
        "property": "canyon-vista",
        "source_image": SOURCE_IMAGE.name,
        "image_size": {"width": image_width, "height": image_height},
        "coordinate_mode": "image_pixels",
        "kml_coordinate_encoding": "lon=x/10000, lat=-y/10000, alt=0",
        "units": units,
    }


def add_text(parent: ET.Element, tag: str, value: str) -> ET.Element:
    child = ET.SubElement(parent, tag)
    child.text = value
    return child


def write_kml(payload: dict) -> None:
    ET.register_namespace("", "http://www.opengis.net/kml/2.2")
    kml = ET.Element("{http://www.opengis.net/kml/2.2}kml")
    document = ET.SubElement(kml, "Document")
    add_text(document, "name", "Canyon Vista Units")

    style = ET.SubElement(document, "Style", id="unit-polygon")
    line_style = ET.SubElement(style, "LineStyle")
    add_text(line_style, "color", "ff004cff")
    add_text(line_style, "width", "2")
    poly_style = ET.SubElement(style, "PolyStyle")
    add_text(poly_style, "color", "33004cff")

    for unit in payload["units"]:
        placemark = ET.SubElement(document, "Placemark")
        add_text(placemark, "name", f"Unit {unit['unit']}")
        add_text(placemark, "styleUrl", "#unit-polygon")
        extended = ET.SubElement(placemark, "ExtendedData")
        for key, value in {
            "unit": str(unit["unit"]),
            "image_width": str(payload["image_size"]["width"]),
            "image_height": str(payload["image_size"]["height"]),
            "coordinate_mode": payload["coordinate_mode"],
            "coordinate_encoding": payload["kml_coordinate_encoding"],
        }.items():
            data = ET.SubElement(extended, "Data", name=key)
            add_text(data, "value", value)

        polygon = ET.SubElement(placemark, "Polygon")
        add_text(polygon, "tessellate", "0")
        outer = ET.SubElement(polygon, "outerBoundaryIs")
        ring = ET.SubElement(outer, "LinearRing")
        coordinates = []
        points = unit["corners_px"] + [unit["corners_px"][0]]
        for x, y in points:
            coordinates.append(f"{x / SCALE:.7f},{-y / SCALE:.7f},0")
        add_text(ring, "coordinates", "\n" + " ".join(coordinates) + "\n")

    xml_text = ET.tostring(kml, encoding="utf-8")
    pretty = minidom.parseString(xml_text).toprettyxml(indent="  ")
    KML_PATH.write_text(pretty, encoding="utf-8")


def write_overlay(payload: dict) -> None:
    base = Image.open(SOURCE_IMAGE).convert("RGBA")
    overlay = Image.new("RGBA", base.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    for unit in payload["units"]:
        points = [tuple(point) for point in unit["corners_px"]]
        draw.polygon(points, fill=(255, 76, 0, 46), outline=(255, 76, 0, 235))
        cx, cy = unit["center_px"]
        label = str(unit["unit"])
        draw.rectangle((cx - 10, cy - 7, cx + 10, cy + 8), fill=(255, 255, 255, 190))
        draw.text((cx - 7, cy - 6), label, fill=(0, 0, 0, 255))
    Image.alpha_composite(base, overlay).save(OVERLAY_PATH)


def main() -> int:
    EXPORTS_DIR.mkdir(parents=True, exist_ok=True)
    payload = build_unit_polygons()
    save_json(POLYGONS_JSON, payload)
    write_kml(payload)
    write_overlay(payload)
    print(f"Wrote {POLYGONS_JSON}")
    print(f"Wrote {KML_PATH}")
    print(f"Wrote {OVERLAY_PATH}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
