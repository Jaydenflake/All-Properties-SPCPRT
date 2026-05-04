#!/usr/bin/env python3
from __future__ import annotations

import json
import math
import unittest
import xml.etree.ElementTree as ET
from collections import defaultdict
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
UNITS_DIR = ROOT / "Canyon-Vista" / "units"
EXPORTS_DIR = ROOT / "Canyon-Vista" / "exports"
JSON_PATH = UNITS_DIR / "unit_polygons.image.json"
KML_PATH = EXPORTS_DIR / "canyon-vista-units.kml"
OVERLAY_PATH = EXPORTS_DIR / "canyon-vista-units-overlay.png"
IMAGE_WIDTH = 1584
IMAGE_HEIGHT = 1224


def polygon_area(points: list[list[float]]) -> float:
    total = 0.0
    for idx, point in enumerate(points):
        nxt = points[(idx + 1) % len(points)]
        total += point[0] * nxt[1] - nxt[0] * point[1]
    return abs(total) / 2


class UnitKmlExportContract(unittest.TestCase):
    def test_expected_artifacts_exist(self) -> None:
        self.assertTrue(JSON_PATH.is_file(), f"missing {JSON_PATH}")
        self.assertTrue(KML_PATH.is_file(), f"missing {KML_PATH}")
        self.assertTrue(OVERLAY_PATH.is_file(), f"missing {OVERLAY_PATH}")
        self.assertGreater(OVERLAY_PATH.stat().st_size, 10_000)

    def test_json_contains_exact_unit_set_and_valid_pixel_polygons(self) -> None:
        data = json.loads(JSON_PATH.read_text())
        units = data["units"]
        self.assertEqual([u["unit"] for u in units], list(range(1, 88)))
        self.assertEqual(data["image_size"], {"width": IMAGE_WIDTH, "height": IMAGE_HEIGHT})
        self.assertEqual(data["coordinate_mode"], "image_pixels")

        for unit in units:
            points = unit["corners_px"]
            self.assertGreaterEqual(len(points), 4, unit["unit"])
            self.assertGreater(polygon_area(points), 50, unit["unit"])
            for x, y in points:
                self.assertGreaterEqual(x, 0, unit["unit"])
                self.assertLessEqual(x, IMAGE_WIDTH, unit["unit"])
                self.assertGreaterEqual(y, 0, unit["unit"])
                self.assertLessEqual(y, IMAGE_HEIGHT, unit["unit"])

    def test_kml_has_one_closed_placemark_per_unit(self) -> None:
        tree = ET.parse(KML_PATH)
        ns = {"kml": "http://www.opengis.net/kml/2.2"}
        placemarks = tree.findall(".//kml:Placemark", ns)
        self.assertEqual(len(placemarks), 87)
        names = [pm.findtext("kml:name", namespaces=ns) for pm in placemarks]
        self.assertEqual(names, [f"Unit {i}" for i in range(1, 88)])

        for pm in placemarks:
            unit_name = pm.findtext("kml:name", namespaces=ns)
            coord_text = pm.findtext(".//kml:coordinates", namespaces=ns)
            self.assertIsNotNone(coord_text, unit_name)
            coords = [
                tuple(float(part) for part in item.split(","))
                for item in coord_text.split()
            ]
            self.assertGreaterEqual(len(coords), 5, unit_name)
            self.assertEqual(coords[0], coords[-1], unit_name)
            for lon, lat, alt in coords:
                x = lon * 10_000
                y = -lat * 10_000
                self.assertGreaterEqual(x, -0.05, unit_name)
                self.assertLessEqual(x, IMAGE_WIDTH + 0.05, unit_name)
                self.assertGreaterEqual(y, -0.05, unit_name)
                self.assertLessEqual(y, IMAGE_HEIGHT + 0.05, unit_name)
                self.assertTrue(math.isclose(alt, 0.0), unit_name)

    def test_kml_coordinates_match_json_pixels(self) -> None:
        data = json.loads(JSON_PATH.read_text())
        expected = {f"Unit {u['unit']}": u["corners_px"] for u in data["units"]}
        tree = ET.parse(KML_PATH)
        ns = {"kml": "http://www.opengis.net/kml/2.2"}
        for pm in tree.findall(".//kml:Placemark", ns):
            name = pm.findtext("kml:name", namespaces=ns)
            coord_text = pm.findtext(".//kml:coordinates", namespaces=ns)
            actual = []
            for item in coord_text.split()[:-1]:
                lon, lat, _alt = (float(part) for part in item.split(","))
                actual.append([round(lon * 10_000, 3), round(-lat * 10_000, 3)])
            self.assertEqual(actual, expected[name])

    def test_shared_walls_are_snapped_to_identical_edges(self) -> None:
        data = json.loads(JSON_PATH.read_text())
        edge_to_units = defaultdict(list)
        for unit in data["units"]:
            points = [tuple(point) for point in unit["corners_px"]]
            for start, end in zip(points, points[1:] + points[:1]):
                edge_to_units[tuple(sorted((start, end)))].append(unit["unit"])
        shared_edges = [units for units in edge_to_units.values() if len(units) > 1]
        self.assertGreaterEqual(len(shared_edges), 60)


if __name__ == "__main__":
    unittest.main()
