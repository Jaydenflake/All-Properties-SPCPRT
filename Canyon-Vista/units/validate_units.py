#!/usr/bin/env python3
"""Validate Canyon-Vista units.json geometry (polygon area, monotonic floors)."""
from __future__ import annotations

import json
import sys
from pathlib import Path

MIN_AREA = 0.0001


def polygon_area(corners: list[list[float]]) -> float:
    n = len(corners)
    s = 0.0
    for i in range(n):
        j = (i + 1) % n
        s += corners[i][0] * corners[j][1] - corners[j][0] * corners[i][1]
    return abs(s) / 2


def main() -> int:
    path = Path(sys.argv[1] if len(sys.argv) > 1 else "units.json")
    if not path.is_file():
        print(f"File not found: {path}", file=sys.stderr)
        return 1
    data = json.loads(path.read_text(encoding="utf-8"))
    units = data.get("units", data)
    if not isinstance(units, list):
        print("Expected top-level 'units' array", file=sys.stderr)
        return 1

    errors: list[str] = []
    for u in units:
        uu = u.get("unit", "?")
        c = u.get("corners_xz")
        if not c or len(c) < 4:
            errors.append(f"{uu}: need 4 corners_xz")
            continue
        if polygon_area(c) < MIN_AREA:
            errors.append(f"{uu}: polygon area < {MIN_AREA} (degenerate)")

        floors = u.get("floors") or []
        if not isinstance(floors, list):
            errors.append(f"{uu}: floors must be a list")
            continue
        gy = u.get("ground_y")
        if gy is None:
            errors.append(f"{uu}: missing ground_y")
        prev = float(gy) if gy is not None else None
        for i, fl in enumerate(floors):
            ty = fl.get("top_y") if isinstance(fl, dict) else None
            if ty is None:
                errors.append(f"{uu} floor {i}: missing top_y")
                continue
            if prev is not None and float(ty) <= float(prev):
                errors.append(f"{uu} floor {i}: top_y {ty} must be > previous bound {prev}")
            prev = float(ty)

    if errors:
        print("\n".join(errors), file=sys.stderr)
        return 1
    print(f"OK: {len(units)} units validated")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
