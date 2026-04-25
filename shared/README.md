# Shared path animation (flight path + editor + recording)

This folder contains a reusable module that adds **flight path** (camera path) animation, an **editor UI** to create and edit checkpoints, and **video recording** to any property index page that uses Three.js and OrbitControls.

## What it provides

- **Flight path**: Catmull-Rom interpolated camera path with position + look-at per checkpoint and configurable duration, speed, and loop.
- **Editor UI**: "Path" toggle (top-right), panel with checkpoint strip (capture, play/pause, overwrite, delete, go to checkpoint), and "Copy JSON" export.
- **Record button**: In the property’s menu bar; records the first 20 seconds of the path animation to a WebM file and downloads it (UI is hidden during recording).

## Usage (add to a property index)

1. **Script**: After `camera`, `controls`, `renderer`, and `parameters` exist (and before or after your `animate()` loop), load and init the module:

```javascript
import('../shared/path-animation.mjs').then(({ initPathAnimation }) => {
  window.__pathAnimation = initPathAnimation({
    camera,
    controls,
    renderer,
    sceneOrigin: parameters.scene.origin,
    startPosition: parameters.camera.startPosition,
    menuContainer: document.getElementById('menuContainer'),
    propertyLabel: 'Your-Property-Name'
  });
}).catch(err => console.warn('Path animation failed to load', err));
```

2. **Animate loop**: Compute delta time and call the path animation update; skip your normal auto-rotate when the path is playing:

```javascript
function animate() {
  const now = performance.now();
  if (window.__pathAnimation) {
    if (window.__pathAnimationLastTime == null) window.__pathAnimationLastTime = now;
    const deltaSec = Math.min((now - window.__pathAnimationLastTime) / 1000, 0.1);
    window.__pathAnimationLastTime = now;
    window.__pathAnimation.update(deltaSec);
  }
  if (autoRotate && (!window.__pathAnimation || !window.__pathAnimation.getState().playing)) {
    // ... your existing auto-rotate (angle, camera.position, etc.) ...
  }
  // ... rest of animate (hotspots, controls.update, renderer.render, requestAnimationFrame) ...
}
```

3. **Paths**: The module is loaded from `../shared/path-animation.mjs` when the HTML file lives in `indexes/`. If your structure is different, adjust the import path.

## Options

| Option | Description |
|--------|-------------|
| `camera` | Three.js PerspectiveCamera |
| `controls` | OrbitControls (must have `.target` and `.update()`) |
| `renderer` | WebGLRenderer (must have `.domElement` for recording) |
| `sceneOrigin` | `{ x, y, z }` default look-at / scene center |
| `startPosition` | `{ x, y, z }` default camera position for new checkpoints |
| `menuContainer` | DOM element to append the record button to (e.g. `.menu-container`) |
| `initialPath` | Optional `{ enabled, loop, speed, checkpoints[] }` to preload a path |
| `propertyLabel` | String used in the recorded video filename (e.g. `'Hart-Bench-Ranch'`) |
| `onRecordStart` | Optional `() => void` — called when recording starts (e.g. dispose/recreate Luma `LumaSplatsThree` to replay particle reveal in the capture) |

## Example

See **indexes/index(Hart-Bench-Ranch-06-08-25).html** for a full integration.

## Copper-Rock

The live **Copper-Rock** app (`Copper-Rock/index.html`) uses its own inline implementation with per-hole paths. This shared module is a single-path version for other properties; it does not replace the Copper-Rock implementation.
