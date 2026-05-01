#!/usr/bin/env python3
"""
Canyon Vista site map → per-unit oriented rectangles (image pixel space).

Subcommands:
  click    Interactive matplotlib: left-click = add unit + prompt for number, right-click = undo, 's' = save.
  segment  Run SAM 2 on clicks.json → units_raw.json (minAreaRect per mask).
  preview  Draw rectangles on the site map → units_preview.png
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def load_json(path: Path) -> dict | list:
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def save_json(path: Path, data) -> None:
    with path.open("w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
        f.write("\n")


def cmd_click(args: argparse.Namespace) -> int:
    image_path = Path(args.image)
    if not image_path.is_file():
        print(f"Image not found: {image_path}", file=sys.stderr)
        return 1

    try:
        import matplotlib.pyplot as plt
        import numpy as np
        from matplotlib.image import imread
    except ImportError as e:
        print("Need matplotlib and numpy:", e, file=sys.stderr)
        return 1

    try:
        import tkinter as tk
        from tkinter import simpledialog
    except ImportError:
        tk = None
        simpledialog = None

    img = imread(str(image_path))
    if img.ndim == 2:
        img = np.stack([img, img, img], axis=-1)
    elif img.shape[2] == 4:
        img = img[:, :, :3]

    out_path = Path(args.output)
    clicks: list[dict] = []
    if out_path.is_file():
        try:
            existing = load_json(out_path)
            if isinstance(existing, dict) and isinstance(existing.get("clicks"), list):
                clicks = existing["clicks"]
                print(f"Loaded {len(clicks)} existing clicks from {out_path}")
        except json.JSONDecodeError:
            pass

    fig, ax = plt.subplots(figsize=(14, 12))
    ax.imshow(img)
    ax.set_title("Left-click: add unit | Right-click: undo | 's': save & quit")
    scatter = ax.scatter([], [], s=24, c="cyan", marker="o")

    def redraw_markers():
        if not clicks:
            scatter.set_offsets(np.empty((0, 2)))
        else:
            pts = np.array([c["positive_px"][:2] for c in clicks], dtype=float)
            scatter.set_offsets(pts)
        fig.canvas.draw_idle()

    def on_click(event):
        if event.inaxes != ax or event.xdata is None or event.ydata is None:
            return
        x, y = float(event.xdata), float(event.ydata)
        if event.button == 1:
            unit = None
            if tk is not None and simpledialog is not None:
                root = tk.Tk()
                root.withdraw()
                root.attributes("-topmost", True)
                unit = simpledialog.askstring("Unit number", f"Unit number for click ({x:.1f}, {y:.1f}):")
                root.destroy()
            if not unit:
                unit = input(f"Unit number for click ({x:.1f}, {y:.1f}): ").strip()
            if not unit:
                print("Skipped (empty unit)")
                return
            neg = []
            if args.negative_margin and args.negative_margin > 0:
                m = float(args.negative_margin)
                neg = [
                    [x + m, y],
                    [x - m, y],
                    [x, y + m],
                    [x, y - m],
                ]
            clicks.append(
                {
                    "unit": unit,
                    "positive_px": [x, y],
                    "negative_px": neg,
                }
            )
            print(f"Added unit {unit} @ ({x:.1f}, {y:.1f}) — total {len(clicks)}")
        elif event.button == 3:
            if clicks:
                removed = clicks.pop()
                print(f"Removed unit {removed.get('unit')} — {len(clicks)} left")
        redraw_markers()

    def on_key(event):
        if event.key == "s":
            payload = {
                "image": str(image_path.as_posix()),
                "clicks": clicks,
            }
            save_json(out_path, payload)
            print(f"Saved {len(clicks)} clicks to {out_path}")
            plt.close(fig)

    fig.canvas.mpl_connect("button_press_event", on_click)
    fig.canvas.mpl_connect("key_press_event", on_key)
    redraw_markers()
    plt.tight_layout()
    plt.show()
    return 0


def discover_sam2_config_name() -> str | None:
    """Return Hydra config_name relative to the sam2 package (for build_sam2)."""
    try:
        import sam2
    except ImportError:
        return None
    root = Path(sam2.__file__).resolve().parent
    candidates = [
        "configs/sam2.1/sam2.1_hiera_s.yaml",
        "configs/sam2/sam2_hiera_s.yaml",
        "configs/sam2.1/sam2.1_hiera_t.yaml",
        "configs/sam2/sam2_hiera_t.yaml",
    ]
    for c in candidates:
        if (root / c).is_file():
            return c
    return None


def cmd_segment(args: argparse.Namespace) -> int:
    image_path = Path(args.image)
    clicks_path = Path(args.clicks)
    ckpt_path = Path(args.checkpoint)
    out_path = Path(args.output)

    if not image_path.is_file():
        print(f"Image not found: {image_path}", file=sys.stderr)
        return 1
    if not clicks_path.is_file():
        print(f"Clicks not found: {clicks_path}", file=sys.stderr)
        return 1
    if not ckpt_path.is_file():
        print(f"SAM2 checkpoint not found: {ckpt_path}", file=sys.stderr)
        print("Download from https://github.com/facebookresearch/sam2#download-checkpoints", file=sys.stderr)
        return 1

    cfg_name = (args.config or "").strip() or discover_sam2_config_name()
    if not cfg_name:
        print(
            "Could not find SAM2 config under the installed package. "
            "Pass --config configs/sam2.1/sam2.1_hiera_s.yaml (Hydra name relative to sam2).",
            file=sys.stderr,
        )
        return 1

    try:
        import cv2
        import numpy as np
        import torch
        from sam2.build_sam import build_sam2
        from sam2.sam2_image_predictor import SAM2ImagePredictor
    except ImportError as e:
        print("Missing dependency (torch, opencv, sam2):", e, file=sys.stderr)
        return 1

    data = load_json(clicks_path)
    if isinstance(data, dict) and "clicks" in data:
        click_list = data["clicks"]
    else:
        click_list = data
    if not isinstance(click_list, list) or not click_list:
        print("No clicks in file", file=sys.stderr)
        return 1

    image_bgr = cv2.imread(str(image_path), cv2.IMREAD_COLOR)
    if image_bgr is None:
        print(f"OpenCV could not read image: {image_path}", file=sys.stderr)
        return 1
    image_rgb = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2RGB)

    if args.device:
        device = torch.device(args.device)
    elif torch.cuda.is_available():
        device = torch.device("cuda")
    elif hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        device = torch.device("mps")
    else:
        device = torch.device("cpu")
    print(f"Loading SAM2 ({cfg_name}) on {device}...")
    sam2_model = build_sam2(cfg_name, str(ckpt_path), device=device, mode="eval")
    predictor = SAM2ImagePredictor(sam2_model)
    predictor.set_image(image_rgb)

    units_raw: list[dict] = []
    ih, iw = image_rgb.shape[:2]

    for entry in click_list:
        unit = str(entry.get("unit", "")).strip()
        pos = entry.get("positive_px") or entry.get("click_px")
        if not unit or not pos or len(pos) < 2:
            continue
        px, py = float(pos[0]), float(pos[1])

        neg_list = entry.get("negative_px") or []
        point_coords = [[px, py]]
        point_labels = [1]
        for n in neg_list:
            if n and len(n) >= 2:
                point_coords.append([float(n[0]), float(n[1])])
                point_labels.append(0)

        coords = np.array(point_coords, dtype=np.float32)
        labels = np.array(point_labels, dtype=np.int32)

        pred_kw = dict(
            point_coords=coords,
            point_labels=labels,
            multimask_output=True,
        )
        try:
            pred_kw["normalize_coords"] = False
            masks, scores, _ = predictor.predict(**pred_kw)
        except TypeError:
            pred_kw.pop("normalize_coords", None)
            masks, scores, _ = predictor.predict(**pred_kw)
        if masks is None or len(masks) == 0:
            print(f"Warning: no mask for unit {unit}", file=sys.stderr)
            continue
        best = int(np.argmax(scores))
        mask = masks[best].astype(bool)
        if not np.any(mask):
            print(f"Warning: empty mask for unit {unit}", file=sys.stderr)
            continue

        ys, xs = np.where(mask)
        pts = np.stack([xs.astype(np.float32), ys.astype(np.float32)], axis=1)
        rect = cv2.minAreaRect(pts)
        box = cv2.boxPoints(rect)
        box = np.round(box).astype(float)

        (cx, cy), (w, h), theta = rect
        if w < h:
            theta = theta + 90
            w, h = h, w

        corners_px = [[float(box[i][0]), float(box[i][1])] for i in range(4)]

        units_raw.append(
            {
                "unit": unit,
                "corners_px": corners_px,
                "center_px": [float(cx), float(cy)],
                "size_px": [float(w), float(h)],
                "rotation_deg": float(theta),
            }
        )
        print(f"  unit {unit}: area={mask.sum()} px, score={float(scores[best]):.3f}")

    payload = {
        "image": str(image_path.as_posix()),
        "image_size": {"width": iw, "height": ih},
        "units": units_raw,
    }
    save_json(out_path, payload)
    print(f"Wrote {len(units_raw)} units to {out_path}")
    return 0


def cmd_preview(args: argparse.Namespace) -> int:
    image_path = Path(args.image)
    raw_path = Path(args.raw)
    out_img = Path(args.output)
    if not image_path.is_file() or not raw_path.is_file():
        print("Missing image or raw JSON", file=sys.stderr)
        return 1

    try:
        import cv2
        import numpy as np
    except ImportError as e:
        print(e, file=sys.stderr)
        return 1

    raw = load_json(raw_path)
    units = raw["units"] if isinstance(raw, dict) and "units" in raw else raw
    if not isinstance(units, list):
        print("Invalid raw JSON shape", file=sys.stderr)
        return 1

    bgr = cv2.imread(str(image_path), cv2.IMREAD_COLOR)
    if bgr is None:
        return 1
    for u in units:
        corners = u.get("corners_px")
        if not corners or len(corners) < 4:
            continue
        pts = np.array(corners, dtype=np.int32).reshape(-1, 1, 2)
        cv2.polylines(bgr, [pts], True, (0, 255, 0), 2)
        cx, cy = int(np.mean(pts[:, 0, 0])), int(np.mean(pts[:, 0, 1]))
        label = str(u.get("unit", "?"))
        cv2.putText(bgr, label, (cx - 10, cy), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 255, 255), 1, cv2.LINE_AA)

    cv2.imwrite(str(out_img), bgr)
    print(f"Wrote {out_img}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Canyon Vista map → unit rectangles (pixels)")
    sp = ap.add_subparsers(dest="cmd", required=True)

    p_click = sp.add_parser("click", help="Interactive click collection")
    p_click.add_argument("--image", default="canyon_vista_sitemap.png")
    p_click.add_argument("--output", default="clicks.json")
    p_click.add_argument("--negative-margin", type=float, default=0, help="Add 4 symmetric negative points for SAM (pixels)")
    p_click.set_defaults(func=cmd_click)

    p_seg = sp.add_parser("segment", help="SAM2 segment + minAreaRect")
    p_seg.add_argument("--image", default="canyon_vista_sitemap.png")
    p_seg.add_argument("--clicks", default="clicks.json")
    p_seg.add_argument("--checkpoint", default="checkpoints/sam2.1_hiera_small.pt")
    p_seg.add_argument("--config", default="", help='Hydra config name, e.g. configs/sam2.1/sam2.1_hiera_s.yaml')
    p_seg.add_argument("--output", default="units_raw.json")
    p_seg.add_argument("--device", default="", help="cuda | cpu | mps")
    p_seg.set_defaults(func=cmd_segment)

    p_prev = sp.add_parser("preview", help="Draw units_raw on image")
    p_prev.add_argument("--image", default="canyon_vista_sitemap.png")
    p_prev.add_argument("--raw", default="units_raw.json")
    p_prev.add_argument("--output", default="units_preview.png")
    p_prev.set_defaults(func=cmd_preview)

    args = ap.parse_args()
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
