import { Raycaster, SphereGeometry, MeshBasicMaterial, Mesh, Group, Vector2 } from 'three';

const FLOAT_Y = 0.04;
const BASE_RADIUS = 0.055;
const HOVER_SCALE = 1.18;
const SELECTED_SCALE = 1.3;
const DIST_SCALE_K = 0.028;
const COLOR_AVAILABLE = 0x22c55e;
const COLOR_AVAILABLE_HOVER = 0x4ade80;
const COLOR_UNAVAILABLE = 0x6b7280;
const COLOR_SELECTED = 0xffffff;

/**
 * @param {object} opts
 * @param {import('three').Scene} opts.scene
 * @param {import('three').PerspectiveCamera} opts.camera
 * @param {import('three').WebGLRenderer} opts.renderer
 * @param {'viewer' | 'admin'} opts.mode
 * @param {import('./units-data.mjs').Unit[]} opts.units
 * @param {() => Record<string, { x: number, y: number, z: number }>} opts.getPositionsMap
 * @param {() => boolean} opts.getOnlyAvailable
 * @param {(unit: import('./units-data.mjs').Unit) => void} [opts.onUnitClick]
 * @param {(unitNumber: string) => void} [opts.onMarkerSelect]
 */
export function mountUnitMarkers(opts) {
  const {
    scene,
    camera,
    renderer,
    mode,
    units,
    getPositionsMap,
    getOnlyAvailable,
    onUnitClick,
    onMarkerSelect,
  } = opts;

  /** @type {Map<string, { group: Group, mesh: Mesh, unit: import('./units-data.mjs').Unit }>} */
  const registry = new Map();
  const raycaster = new Raycaster();

  let hoveredKey = null;
  let selectedKey = null;
  let pointerDown = false;
  let downX = 0;
  let downY = 0;

  function visibleForUnit(unit) {
    if (mode === 'admin') return true;
    if (getOnlyAvailable()) return unit.available;
    return true;
  }

  function baseColorFor(unit) {
    if (mode === 'admin' && !unit.available) return COLOR_UNAVAILABLE;
    if (!unit.available) return COLOR_UNAVAILABLE;
    return COLOR_AVAILABLE;
  }

  function showAsInteractive(unit) {
    if (mode === 'admin') return true;
    return unit.available;
  }

  function clearMarkers() {
    for (const { group } of registry.values()) {
      scene.remove(group);
      group.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
      });
    }
    registry.clear();
  }

  function rebuild() {
    clearMarkers();
    const positions = getPositionsMap();
    for (const unit of units) {
      if (!visibleForUnit(unit)) continue;
      const pos = positions[unit.unitNumber];
      if (!pos) continue;

      const group = new Group();
      group.position.set(pos.x, pos.y + FLOAT_Y, pos.z);
      group.userData.unitNumber = unit.unitNumber;

      const geo = new SphereGeometry(BASE_RADIUS, 24, 16);
      const mat = new MeshBasicMaterial({ color: baseColorFor(unit) });
      const mesh = new Mesh(geo, mat);
      mesh.userData.unitNumber = unit.unitNumber;
      group.add(mesh);

      scene.add(group);
      registry.set(unit.unitNumber, { group, mesh, unit });
    }
  }

  function update() {
    for (const { group, mesh, unit } of registry.values()) {
      const d = camera.position.distanceTo(group.position);
      const s = Math.max(0.35, d * DIST_SCALE_K);
      group.scale.setScalar(s);
      const isSelected = unit.unitNumber === selectedKey;
      const hover = unit.unitNumber === hoveredKey && showAsInteractive(unit) && !isSelected;
      if (isSelected) {
        mesh.material.color.setHex(COLOR_SELECTED);
        mesh.scale.setScalar(SELECTED_SCALE);
      } else if (hover) {
        mesh.material.color.setHex(COLOR_AVAILABLE_HOVER);
        mesh.scale.setScalar(HOVER_SCALE);
      } else {
        mesh.material.color.setHex(baseColorFor(unit));
        mesh.scale.setScalar(1);
      }
    }
  }

  const ndc = new Vector2();

  /** @param {PointerEvent} ev */
  function onPointerMove(ev) {
    const rect = renderer.domElement.getBoundingClientRect();
    const x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    const y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    ndc.set(x, y);
    raycaster.setFromCamera(ndc, camera);
    const meshes = [...registry.values()].map((r) => r.mesh);
    const hits = raycaster.intersectObjects(meshes, false);
    let next = null;
    if (hits.length && hits[0].object.userData.unitNumber) {
      const u = registry.get(hits[0].object.userData.unitNumber)?.unit;
      if (u && showAsInteractive(u)) next = u.unitNumber;
    }
    hoveredKey = next;
    renderer.domElement.style.cursor = hoveredKey ? 'pointer' : 'default';
  }

  /** @param {PointerEvent} ev */
  function onPointerDown(ev) {
    pointerDown = true;
    downX = ev.clientX;
    downY = ev.clientY;
  }

  /** @param {PointerEvent} ev */
  function onPointerUp(ev) {
    if (!pointerDown) return;
    pointerDown = false;
    const dx = ev.clientX - downX;
    const dy = ev.clientY - downY;
    if (Math.hypot(dx, dy) > 8) return;
    if (mode === 'viewer' && !onUnitClick) return;
    if (mode === 'admin' && !onMarkerSelect) return;
    const rect = renderer.domElement.getBoundingClientRect();
    const x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    const y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    ndc.set(x, y);
    raycaster.setFromCamera(ndc, camera);
    const meshes = [...registry.values()].map((r) => r.mesh);
    const hits = raycaster.intersectObjects(meshes, false);
    if (!hits.length) return;
    const key = hits[0].object.userData.unitNumber;
    const entry = registry.get(key);
    if (!entry) return;
    if (mode === 'admin' && onMarkerSelect) {
      onMarkerSelect(key);
    } else if (mode === 'viewer' && onUnitClick && entry.unit.available) {
      onUnitClick(entry.unit);
    }
  }

  renderer.domElement.addEventListener('pointermove', onPointerMove);
  renderer.domElement.addEventListener('pointerdown', onPointerDown);
  renderer.domElement.addEventListener('pointerup', onPointerUp);

  rebuild();

  return {
    rebuild,
    update,
    /** @param {string | null} unitNumber */
    setSelected(unitNumber) {
      selectedKey = unitNumber ?? null;
    },
    /** @param {string} unitNumber */
    getGroup(unitNumber) {
      return registry.get(unitNumber)?.group ?? null;
    },
    /** Move marker root (world y should be base position; float offset added here). */
    setWorldPosition(unitNumber, vec) {
      const g = registry.get(unitNumber)?.group;
      if (g) g.position.set(vec.x, vec.y + FLOAT_Y, vec.z);
    },
    getBaseYFromGroup(unitNumber) {
      const g = registry.get(unitNumber)?.group;
      if (!g) return 0;
      return g.position.y - FLOAT_Y;
    },
    dispose() {
      renderer.domElement.removeEventListener('pointermove', onPointerMove);
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      renderer.domElement.removeEventListener('pointerup', onPointerUp);
      clearMarkers();
    },
  };
}
