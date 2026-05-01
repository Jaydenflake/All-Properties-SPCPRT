#!/usr/bin/env python3
"""Register units_raw.json (pixel corners) to scene XZ using lot vertex correspondences."""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import cv2
import numpy as np


def load_json(path: Path) -> dict | list:
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def transform_pixel_to_scene(M: np.ndarray, px: float, py: float) -> tuple[float, float]:
    v = np.array([px, py, 1.0], dtype=np.float64)
    xz = M @ v
    return float(xz[0]), float(xz[1])


def nearest_ground_y(cx: float, cz: float, anchors: list[dict]) -> float:
    best_y = -0.13
    best_d = float("inf")
    for v in anchors:
        p = v["position"]
        x, y, z = p["x"], p["y"], p["z"]
        d = (x - cx) ** 2 + (z - cz) ** 2
        if d < best_d:
            best_d = d
            best_y = y
    return best_y


def polygon_area_xz(corners_xz: list[list[float]]) -> float:
    n = len(corners_xz)
    s = 0.0
    for i in range(n):
        j = (i + 1) % n
        s += corners_xz[i][0] * corners_xz[j][1]
        s -= corners_xz[j][0] * corners_xz[i][1]
    return abs(s) / 2


def cmd_register(args: argparse.Namespace) -> int:
    raw_path = Path(args.raw)
    corr_path = Path(args.correspondences)
    anchors_path = Path(args.anchors)
    if not raw_path.is_file():
        print(f"Missing raw: {raw_path}", file=sys.stderr)
        return 1
    if not corr_path.is_file():
        print(f"Missing correspondences: {corr_path}", file=sys.stderr)
        print("Copy correspondences.example.json to correspondences.json and fill click_px.", file=sys.stderr)
        return 1
    if not anchors_path.is_file():
        print(f"Missing anchors: {anchors_path}", file=sys.stderr)
        return 1

    raw = load_json(raw_path)
    corr = load_json(corr_path)
    anchors_data = load_json(anchors_path)

    anchors = anchors_data.get("vertices", anchors_data)
    if not isinstance(anchors, list):
        print("lot_anchors.json must have a 'vertices' array", file=sys.stderr)
        return 1

    name_to_pos = {v["name"]: v["position"] for v in anchors}
    correspondences = corr.get("correspondences", corr)
    if not isinstance(correspondences, list):
        print("correspondences must be a list under 'correspondences'", file=sys.stderr)
        return 1

    src_pts = []
    dst_pts = []
    for c in correspondences:
        name = c.get("lot_vertex_name")
        cpx = c.get("click_px", [0, 0])
        px, py = float(cpx[0]), float(cpx[1])
        if name not in name_to_pos:
            print(f"Unknown lot_vertex_name: {name}", file=sys.stderr)
            continue
        p = name_to_pos[name]
        src_pts.append([px, py])
        dst_pts.append([float(p["x"]), float(p["z"])])

    if len(src_pts) < 3:
        print("Need at least 3 valid correspondences.", file=sys.stderr)
        return 1

    src = np.array(src_pts, dtype=np.float64)
    dst = np.array(dst_pts, dtype=np.float64)
    M, _inliers = cv2.estimateAffine2D(src, dst, method=cv2.RANSAC, ransacReprojThreshold=3.0)
    if M is None:
        M, _ = cv2.estimateAffine2D(src, dst)

    if M is None:
        print("estimateAffine2D failed", file=sys.stderr)
        return 1

    residuals = []
    for i, (sx, sy) in enumerate(src_pts):
        tx, tz = transform_pixel_to_scene(M, sx, sy)
        residuals.append(math.hypot(tx - dst_pts[i][0], tz - dst_pts[i][1]))
    max_res = max(residuals)
    mean_res = sum(residuals) / len(residuals)

    units_in = raw["units"] if isinstance(raw, dict) and "units" in raw else raw
    if not isinstance(units_in, list):
        print("units_raw must contain a 'units' array or be a list", file=sys.stderr)
        return 1

    lot_xs = [v["position"]["x"] for v in anchors]
    lot_zs = [v["position"]["z"] for v in anchors]
    xmin, xmax = min(lot_xs), max(lot_xs)
    zmin, zmax = min(lot_zs), max(lot_zs)
    margin = float(args.aabb_margin)
    warnings: list[str] = []
    out_units: list[dict] = []

    for u in units_in:
        unit = str(u.get("unit", "")).strip()
        corners_px = u.get("corners_px")
        if not unit or not corners_px:
            continue
        corners_xz: list[list[float]] = []
        for px, py in corners_px[:4]:
            x, z = transform_pixel_to_scene(M, float(px), float(py))
            corners_xz.append([x, z])
        cx = sum(p[0] for p in corners_xz) / len(corners_xz)
        cz = sum(p[1] for p in corners_xz) / len(corners_xz)
        gy = nearest_ground_y(cx, cz, anchors)
        area = polygon_area_xz(corners_xz)
        if area < 1e-5:
            warnings.append(f"unit {unit}: degenerate polygon area={area}")
        if cx < xmin - margin or cx > xmax + margin or cz < zmin - margin or cz > zmax + margin:
            warnings.append(
                f"unit {unit}: center ({cx:.4f},{cz:.4f}) outside padded lot AABB (margin {margin})"
            )

        rot = float(u.get("rotation_deg", 0.0))
        out_units.append(
            {
                "unit": unit,
                "corners_xz": corners_xz,
                "center_xz": [cx, cz],
                "rotation_deg": rot,
                "ground_y": gy,
                "floorplan_type": str(u.get("floorplan_type", "")),
                "floors": u.get("floors") if isinstance(u.get("floors"), list) else [],
            }
        )

    def sort_key(x: dict):
        s = x["unit"]
        try:
            return (0, int(s))
        except ValueError:
            return (1, s)

    out_units.sort(key=sort_key)

    payload = {
        "version": 1,
        "property": args.property,
        "affine_2x3": M.tolist(),
        "registration": {
            "max_residual": max_res,
            "mean_residual": mean_res,
            "num_correspondences": len(src_pts),
        },
        "units": out_units,
    }

    out_path = Path(args.output)
    with out_path.open("w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)
        f.write("\n")

    report_lines = [
        f"Affine transform (2x3): image (px,py) -> scene (x,z)\n{M}\n\n",
        f"Correspondences: {len(src_pts)}, mean residual: {mean_res:.6f}, max: {max_res:.6f}\n",
    ]
    if max_res > 0.02:
        report_lines.append("\nWARNING: max residual > 0.02 — refine correspondences.json\n")
    for w in warnings:
        report_lines.append(f"WARNING: {w}\n")
    report_lines.append(f"\nUnits written: {len(out_units)} -> {out_path}\n")

    Path(args.report).write_text("".join(report_lines), encoding="utf-8")
    print(f"Wrote {out_path} and {args.report}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw", default="units_raw.json")
    ap.add_argument("--correspondences", default="correspondences.json")
    ap.add_argument("--anchors", default="lot_anchors.json")
    ap.add_argument("--output", default="units.json")
    ap.add_argument("--report", default="registration_report.txt")
    ap.add_argument("--property", default="canyon-vista")
    ap.add_argument("--aabb-margin", type=float, default=0.15)
    return cmd_register(ap.parse_args())


if __name__ == "__main__":
    raise SystemExit(main())
