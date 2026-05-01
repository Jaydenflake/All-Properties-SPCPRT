#!/usr/bin/env python3
from __future__ import annotations

import unittest
import xml.etree.ElementTree as ET
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
INDEX_PATH = ROOT / "Canyon-Vista" / "index.html"
MODULE_PATH = ROOT / "shared" / "unit-kml-overlay.mjs"
KML_PATH = ROOT / "Canyon-Vista" / "exports" / "canyon-vista-units.kml"


class RoomOverlayWiringContract(unittest.TestCase):
    def test_viewer_has_room_lookup_controls_and_loads_kml_overlay(self) -> None:
        html = INDEX_PATH.read_text(encoding="utf-8")
        self.assertIn('id="roomLookupPanel"', html)
        self.assertIn('id="roomSearchInput"', html)
        self.assertIn('id="roomLookupStatus"', html)
        self.assertIn("../shared/unit-kml-overlay.mjs", html)
        self.assertIn("exports/canyon-vista-units.kml", html)
        self.assertIn("pauseCameraAutomation: pauseCameraAutomationFromInteraction", html)

    def test_overlay_module_exposes_runtime_api(self) -> None:
        source = MODULE_PATH.read_text(encoding="utf-8")
        self.assertIn("export function initRoomKmlOverlay", source)
        self.assertIn("selectRoom", source)
        self.assertIn("getSelectedRoom", source)
        self.assertIn("getRoomScreenState", source)
        self.assertIn("getRoomVisualState", source)
        self.assertIn("orbitSelectedRoomForVerification", source)
        self.assertIn("depthTest: false", source)
        self.assertIn("window.__roomKmlOverlay", source)

    def test_generated_kml_still_has_exact_unit_segments(self) -> None:
        tree = ET.parse(KML_PATH)
        ns = {"kml": "http://www.opengis.net/kml/2.2"}
        names = [pm.findtext("kml:name", namespaces=ns) for pm in tree.findall(".//kml:Placemark", ns)]
        self.assertEqual(names, [f"Unit {unit}" for unit in range(1, 88)])


if __name__ == "__main__":
    unittest.main()
