# Canyon Vista — unit footprint pipeline

This folder contains scripts to turn the 2D site map into `units.json` (oriented rectangles in **scene XZ** + per-floor `top_y` values), which the viewer loads via [`shared/unit-extrude-editor.mjs`](../shared/unit-extrude-editor.mjs).

## Prerequisites

1. **Site map image** — save as `canyon_vista_sitemap.png` in this directory (export from your PDF or copy the map PNG).
2. **Python 3.10+** and a virtualenv:

```bash
cd Canyon-Vista/units
python -m venv .venv
# Windows:
.venv\Scripts\activate
# macOS/Linux:
source .venv/bin/activate

pip install -r requirements.txt
```

3. **PyTorch** — if `pip install -r requirements.txt` does not install CUDA builds, install from [pytorch.org](https://pytorch.org) first.
4. **SAM 2 checkpoint** — download e.g. `sam2.1_hiera_small.pt` from the [SAM 2 repo](https://github.com/facebookresearch/sam2#download-checkpoints) into `checkpoints/`. The script auto-picks Hydra config `configs/sam2.1/sam2.1_hiera_s.yaml` from the installed `sam2` package; override with `--config` if needed.

## Step A — Click unit centers (`clicks.json`)

```bash
python extract_units.py click --image canyon_vista_sitemap.png --output clicks.json
```

- **Left-click** on a unit cell center.
- Enter the **unit number** when prompted (e.g. `37`, `00`).
- **Right-click** removes the last click.
- Press **S** (focus the plot window) to **save** and quit.

Optional: add **negative** points for SAM (neighbor cells) in the JSON later, or use:

```bash
python extract_units.py segment --clicks clicks.json --image canyon_vista_sitemap.png --negative-margin 8
```

(If your `clicks.json` includes a `negative_px` array per entry, those are passed to SAM as label 0.)

## Step B — Segment with SAM 2 (`units_raw.json`)

```bash
python extract_units.py segment ^
  --image canyon_vista_sitemap.png ^
  --clicks clicks.json ^
  --checkpoint checkpoints/sam2.1_hiera_small.pt ^
  --output units_raw.json
```

## Step C — Preview rectangles

```bash
python extract_units.py preview --image canyon_vista_sitemap.png --raw units_raw.json --output units_preview.png
```

## Step D — Register image → scene (`units.json`)

1. Copy `correspondences.example.json` to `correspondences.json`.
2. For **4–6** lot corners, record `click_px` on the **same** corners on the site map image (pixels). Names must match [`lot_anchors.json`](lot_anchors.json).
3. Run:

```bash
python register_units.py ^
  --raw units_raw.json ^
  --correspondences correspondences.json ^
  --anchors lot_anchors.json ^
  --output units.json ^
  --report registration_report.txt
```

Re-run **Step D** whenever you change `borderDotPositionsByHole` in `index.html`; refresh `lot_anchors.json` from the viewer (copy from exported lot JSON).

## Step E — Tune in the viewer

From `Canyon-Vista/`:

```bash
node scripts/dev-server.mjs
```

Open **Unit extrude** mode (developer tools), align corners on the splat, set **Mark floor top** per floor, then **Copy Units JSON** and replace `units/units.json`.

## Validate

```bash
python validate_units.py units.json
```

## Files

| File | Purpose |
|------|---------|
| `canyon_vista_sitemap.png` | Source map (you add) |
| `clicks.json` | Click prompts + unit ids |
| `units_raw.json` | Oriented rects in **image pixels** |
| `correspondences.json` | Lot vertex ↔ pixel registration |
| `lot_anchors.json` | Scene positions of lot vertices |
| `units.json` | Final data for the viewer |
| `registration_report.txt` | Affine residuals + warnings |

## Production behavior

- The **Unit extrude** toggle is inside the same developer tool strip as splat / lot / path editors. When `developerToolsVisible` is `false` in [`index.html`](../index.html) (`parameters.developerToolsVisible`), that strip is hidden and any active unit overlay mode is turned off.
- When unit edit mode is **off**, all unit slabs use **opacity 0** (meshes stay in the scene for future highlight wiring).

## Re-exporting `lot_anchors.json`

When lot line vertices change in `Canyon-Vista/index.html`, copy the vertex list from **Copy Lot JSON** in the viewer into `lot_anchors.json` under `"vertices"`.
