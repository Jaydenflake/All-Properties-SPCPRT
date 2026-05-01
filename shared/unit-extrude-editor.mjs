/**
 * Canyon Vista — load units.json, extrude translucent slabs, dev-only editor.
 * Expects import map with "three" in the page that loads this module.
 */
import {
  ExtrudeGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  Plane,
  Raycaster,
  Shape,
  SphereGeometry,
  Vector2,
  Vector3,
} from 'three';

const HANDLE_RADIUS = 0.014;
const SLAB_OPACITY = [0.18, 0.14, 0.1];
const DEFAULT_PLACEHOLDER_HEIGHT = 0.2;
const UNIT_JSON_URL = 'units/units.json';

function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}

function makeSlabMaterial(opacity) {
  return new MeshBasicMaterial({
    color: 0x4ade80,
    transparent: true,
    opacity,
    depthWrite: false,
  });
}

function createSlabMesh(cornersXz, bottomY, topY, opacity, unitNumber, floorIndex) {
  const shape = new Shape();
  const c = cornersXz;
  shape.moveTo(c[0][0], -c[0][1]);
  for (let i = 1; i < 4; i++) shape.lineTo(c[i][0], -c[i][1]);
  shape.closePath();
  const depth = Math.max(0.001, topY - bottomY);
  const geom = new ExtrudeGeometry(shape, { depth, bevelEnabled: false });
  geom.rotateX(-Math.PI / 2);
  geom.translate(0, bottomY, 0);
  const mesh = new Mesh(geom, makeSlabMaterial(opacity));
  mesh.renderOrder = 1000;
  mesh.userData.isUnitSlab = true;
  mesh.userData.unitNumber = unitNumber;
  mesh.userData.floorIndex = floorIndex;
  return mesh;
}

function recenterFromCorners(rec) {
  const cx = rec.corners_xz.reduce((s, p) => s + p[0], 0) / 4;
  const cz = rec.corners_xz.reduce((s, p) => s + p[1], 0) / 4;
  rec.center_xz = [round6(cx), round6(cz)];
}

export function initUnitExtrudeEditor({
  scene,
  camera,
  controls,
  renderer,
  propertyLabel = 'Canyon-Vista',
  unitsJsonUrl = UNIT_JSON_URL,
  elements,
  getParameters = () => ({ developerToolsVisible: true }),
}) {
  const {
    toggle,
    panel,
    statusEl,
    selectedEl,
    cornerSelect,
    vertexX,
    vertexZ,
    groundYInput,
    topYInput,
    sameHeightPrev,
    floorplanTypeInput,
    applyFloorplanCheckbox,
    floorsListEl,
    markFloorTopBtn,
    addManualBtn,
    propagateBtn,
    copyJsonBtn,
  } = elements;

  const state = {
    unitsData: null,
    unitGroups: new Map(),
    active: false,
    selectedUnitKey: null,
    selectedCornerIndex: 0,
    handles: [],
    handleGroup: new Group(),
    drag: {
      active: false,
      pointerId: null,
      cornerIndex: null,
      plane: new Plane(new Vector3(0, 1, 0), 0),
    },
    raycaster: new Raycaster(),
    ndc: new Vector2(),
    scratchVec: new Vector3(),
  };

  scene.add(state.handleGroup);
  state.handleGroup.visible = false;

  function setStatus(msg) {
    if (statusEl) statusEl.textContent = msg;
  }

  function getUnitsArray() {
    if (!state.unitsData || !Array.isArray(state.unitsData.units)) return [];
    return state.unitsData.units;
  }

  function findRec(unitKey) {
    return getUnitsArray().find((u) => String(u.unit) === String(unitKey)) || null;
  }

  function refreshSlabOpacity() {
    state.unitGroups.forEach((group) => {
      group.traverse((child) => {
        if (!child.isMesh || !child.userData.isUnitSlab) return;
        const fi = child.userData.floorIndex ?? 0;
        const op = state.active ? SLAB_OPACITY[Math.min(fi, SLAB_OPACITY.length - 1)] : 0;
        child.material.opacity = op;
      });
    });
  }

  function clearHandles() {
    while (state.handles.length) {
      const m = state.handles.pop();
      state.handleGroup.remove(m);
      m.geometry.dispose();
      m.material.dispose();
    }
    state.handleGroup.visible = false;
  }

  function buildHandlesFor(rec) {
    clearHandles();
    if (!rec || !rec.corners_xz || rec.corners_xz.length < 4) return;
    const gy = Number(rec.ground_y);
    const y = (Number.isFinite(gy) ? gy : -0.13) + 0.02;
    const mat = makeSlabMaterial(1);
    mat.color.setHex(0xffcc00);
    for (let i = 0; i < 4; i++) {
      const [x, z] = rec.corners_xz[i];
      const hm = new Mesh(new SphereGeometry(HANDLE_RADIUS, 12, 12), mat.clone());
      hm.position.set(x, y, z);
      hm.userData.isUnitHandle = true;
      hm.userData.cornerIndex = i;
      hm.userData.unitKey = rec.unit;
      hm.renderOrder = 1001;
      state.handleGroup.add(hm);
      state.handles.push(hm);
    }
    state.handleGroup.visible = state.active && !!rec;
  }

  function rebuildMeshesFor(rec) {
    let group = state.unitGroups.get(String(rec.unit));
    if (!group) {
      group = new Group();
      group.name = `unit-${rec.unit}`;
      scene.add(group);
      state.unitGroups.set(String(rec.unit), group);
    }
    while (group.children.length) {
      const ch = group.children[0];
      group.remove(ch);
      ch.geometry?.dispose();
      ch.material?.dispose();
    }

    const corners = rec.corners_xz;
    if (!corners || corners.length < 4) return group;

    const gy = Number(rec.ground_y);
    const ground = Number.isFinite(gy) ? gy : -0.13;
    const floors = Array.isArray(rec.floors) ? rec.floors : [];

    if (floors.length === 0) {
      const top = ground + DEFAULT_PLACEHOLDER_HEIGHT;
      group.add(createSlabMesh(corners, ground, top, SLAB_OPACITY[0], rec.unit, 0));
    } else {
      let bottom = ground;
      floors.forEach((fl, i) => {
        const top = Number(fl.top_y);
        if (!Number.isFinite(top)) return;
        group.add(
          createSlabMesh(
            corners,
            bottom,
            top,
            SLAB_OPACITY[Math.min(i, SLAB_OPACITY.length - 1)],
            rec.unit,
            i
          )
        );
        bottom = top;
      });
    }

    refreshSlabOpacity();
    return group;
  }

  function selectUnit(unitKey) {
    state.selectedUnitKey = unitKey ? String(unitKey) : null;
    const rec = state.selectedUnitKey ? findRec(state.selectedUnitKey) : null;
    if (selectedEl) {
      selectedEl.textContent = rec ? `Unit: ${rec.unit}` : 'Unit: none';
    }
    if (cornerSelect && rec) {
      cornerSelect.value = String(state.selectedCornerIndex);
    }
    syncInputsFromRec(rec);
    buildHandlesFor(rec);
  }

  function syncInputsFromRec(rec) {
    if (!rec || !rec.corners_xz || rec.corners_xz.length < 4) {
      if (vertexX) vertexX.value = '';
      if (vertexZ) vertexZ.value = '';
      if (groundYInput) groundYInput.value = '';
      if (floorplanTypeInput) floorplanTypeInput.value = '';
      renderFloorList(null);
      return;
    }
    const i = Math.min(Math.max(0, state.selectedCornerIndex), 3);
    const p = rec.corners_xz[i];
    if (vertexX) vertexX.value = p[0];
    if (vertexZ) vertexZ.value = p[1];
    if (groundYInput) groundYInput.value = rec.ground_y;
    if (floorplanTypeInput) floorplanTypeInput.value = rec.floorplan_type || '';
    renderFloorList(rec);
  }

  function renderFloorList(rec) {
    if (!floorsListEl) return;
    floorsListEl.innerHTML = '';
    if (!rec || !rec.floors?.length) {
      floorsListEl.textContent = 'No floors recorded (placeholder slab only).';
      return;
    }
    rec.floors.forEach((fl, idx) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:8px;margin:4px 0;font-size:11px;';
      row.textContent = `Floor ${idx + 1} top: ${fl.top_y}`;
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'lot-editor-action-btn';
      del.textContent = 'Delete';
      del.addEventListener('click', (e) => {
        e.preventDefault();
        rec.floors.splice(idx, 1);
        rebuildMeshesFor(rec);
        renderFloorList(rec);
        setStatus(`Removed floor ${idx + 1} from unit ${rec.unit}`);
      });
      row.appendChild(del);
      floorsListEl.appendChild(row);
    });
  }

  function applyCornerFromInputs() {
    const rec = findRec(state.selectedUnitKey);
    if (!rec) return;
    const x = parseFloat(vertexX?.value);
    const z = parseFloat(vertexZ?.value);
    if (!Number.isFinite(x) || !Number.isFinite(z)) return;
    const i = state.selectedCornerIndex;
    rec.corners_xz[i] = [x, z];
    recenterFromCorners(rec);
    if (applyFloorplanCheckbox?.checked && floorplanTypeInput?.value) {
      const t = floorplanTypeInput.value.trim();
      rec.floorplan_type = t;
      getUnitsArray().forEach((u) => {
        if (u !== rec && String(u.floorplan_type || '') === t) {
          u.corners_xz = rec.corners_xz.map((c) => [...c]);
          u.center_xz = [...rec.center_xz];
          rebuildMeshesFor(u);
        }
      });
    }
    rebuildMeshesFor(rec);
    buildHandlesFor(rec);
  }

  function applyGroundYFromInput() {
    const rec = findRec(state.selectedUnitKey);
    if (!rec || !groundYInput) return;
    const g = parseFloat(groundYInput.value);
    if (!Number.isFinite(g)) return;
    rec.ground_y = g;
    rebuildMeshesFor(rec);
    buildHandlesFor(rec);
  }

  function applyFloorplanFromInput() {
    const rec = findRec(state.selectedUnitKey);
    if (!rec || !floorplanTypeInput) return;
    rec.floorplan_type = floorplanTypeInput.value.trim();
  }

  function pickNDC(event) {
    const rect = renderer.domElement.getBoundingClientRect();
    state.ndc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    state.ndc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  }

  function getHandleIntersects(event) {
    pickNDC(event);
    state.raycaster.setFromCamera(state.ndc, camera);
    return state.raycaster.intersectObjects(state.handles, false);
  }

  function getSlabIntersects(event) {
    pickNDC(event);
    state.raycaster.setFromCamera(state.ndc, camera);
    const slabs = [];
    state.unitGroups.forEach((g) => {
      g.traverse((c) => {
        if (c.userData?.isUnitSlab) slabs.push(c);
      });
    });
    return state.raycaster.intersectObjects(slabs, false);
  }

  function beginDragHandle(event, hit) {
    state.selectedCornerIndex = hit.object.userData.cornerIndex;
    selectUnit(hit.object.userData.unitKey);
    const rec = findRec(state.selectedUnitKey);
    if (!rec) return;
    state.drag.active = true;
    state.drag.pointerId = event.pointerId;
    state.drag.cornerIndex = hit.object.userData.cornerIndex;
    if (cornerSelect) cornerSelect.value = String(state.selectedCornerIndex);
    const gy = Number(rec.ground_y);
    const planeY = Number.isFinite(gy) ? gy : -0.13;
    state.drag.plane.set(new Vector3(0, 1, 0), -planeY);
    syncInputsFromRec(rec);
    setStatus(`Dragging corner ${state.selectedCornerIndex} of unit ${rec.unit}`);
  }

  function updateDrag(event) {
    if (!state.drag.active) return;
    const rec = findRec(state.selectedUnitKey);
    if (!rec) return;
    pickNDC(event);
    state.raycaster.setFromCamera(state.ndc, camera);
    const hit = new Vector3();
    if (!state.raycaster.ray.intersectPlane(state.drag.plane, hit)) return;
    const ci = state.drag.cornerIndex;
    rec.corners_xz[ci] = [hit.x, hit.z];
    recenterFromCorners(rec);
    state.handles[ci]?.position.set(hit.x, rec.ground_y + 0.02, hit.z);
    if (vertexX) vertexX.value = hit.x;
    if (vertexZ) vertexZ.value = hit.z;
    rebuildMeshesFor(rec);
  }

  function endDrag() {
    state.drag.active = false;
    state.drag.pointerId = null;
    state.drag.cornerIndex = null;
  }

  function handlePointerDownCapture(event) {
    if (!state.active) return false;
    if (event.button !== 0) return false;

    const hi = getHandleIntersects(event);
    if (hi.length) {
      beginDragHandle(event, hi[0]);
      event.preventDefault();
      event.stopPropagation();
      return true;
    }

    const si = getSlabIntersects(event);
    if (si.length) {
      const unitNum = si[0].object.userData.unitNumber;
      selectUnit(unitNum);
      event.preventDefault();
      event.stopPropagation();
      return true;
    }

    clearHandles();
    state.selectedUnitKey = null;
    if (selectedEl) selectedEl.textContent = 'Unit: none';
    syncInputsFromRec(null);
    event.preventDefault();
    event.stopPropagation();
    return true;
  }

  function handlePointerMove(event) {
    if (!state.active || !state.drag.active) return;
    if (state.drag.pointerId != null && event.pointerId !== state.drag.pointerId) return;
    updateDrag(event);
    event.preventDefault();
  }

  function handlePointerUp(event) {
    if (!state.drag.active) return;
    if (state.drag.pointerId != null && event.pointerId !== state.drag.pointerId) return;
    endDrag();
    event.preventDefault();
  }

  function handleKeyDown(event) {
    if (!state.active || state.drag.active) return;
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    const rec = findRec(state.selectedUnitKey);
    if (!rec) return;
    const step = event.shiftKey ? 0.01 : 0.001;
    const i = state.selectedCornerIndex;
    const p = rec.corners_xz[i];
    if (event.key === 'ArrowLeft') p[0] -= step;
    if (event.key === 'ArrowRight') p[0] += step;
    if (event.key === 'ArrowUp') p[1] -= step;
    if (event.key === 'ArrowDown') p[1] += step;
    recenterFromCorners(rec);
    rebuildMeshesFor(rec);
    buildHandlesFor(rec);
    syncInputsFromRec(rec);
    event.preventDefault();
  }

  function onMarkFloorTop() {
    const rec = findRec(state.selectedUnitKey);
    if (!rec) {
      setStatus('Select a unit first (click a green slab).');
      return;
    }
    const gy = Number(rec.ground_y);
    const ground = Number.isFinite(gy) ? gy : -0.13;
    let top;
    const floors = rec.floors || (rec.floors = []);
    if (sameHeightPrev?.checked && floors.length >= 1) {
      const lastTop = Number(floors[floors.length - 1].top_y);
      const lastBottom =
        floors.length >= 2 ? Number(floors[floors.length - 2].top_y) : ground;
      top = lastTop + (lastTop - lastBottom);
    } else {
      top = parseFloat(topYInput?.value);
    }
    const bottom = floors.length ? Number(floors[floors.length - 1].top_y) : ground;
    if (!Number.isFinite(top) || top <= bottom) {
      setStatus(`Invalid top_y (must be > ${bottom.toFixed(3)})`);
      return;
    }
    floors.push({ top_y: top });
    rebuildMeshesFor(rec);
    renderFloorList(rec);
    setStatus(`Unit ${rec.unit}: floor top ${top}`);
  }

  function addManualUnit() {
    if (!state.unitsData) state.unitsData = { version: 1, property: 'canyon-vista', units: [] };
    if (!Array.isArray(state.unitsData.units)) state.unitsData.units = [];
    const num = window.prompt('New unit number');
    if (!num || !String(num).trim()) return;
    const t = controls.target;
    const s = 0.04;
    const rec = {
      unit: String(num).trim(),
      corners_xz: [
        [t.x - s, t.z - s],
        [t.x + s, t.z - s],
        [t.x + s, t.z + s],
        [t.x - s, t.z + s],
      ],
      center_xz: [t.x, t.z],
      rotation_deg: 0,
      ground_y: -0.13,
      floorplan_type: '',
      floors: [],
    };
    recenterFromCorners(rec);
    getUnitsArray().push(rec);
    rebuildMeshesFor(rec);
    selectUnit(rec.unit);
    setStatus(`Added manual unit ${rec.unit} at target XZ. Adjust corners.`);
  }

  function propagateCornersByFloorplan() {
    const rec = findRec(state.selectedUnitKey);
    if (!rec) {
      setStatus('Select a unit first.');
      return;
    }
    const t = (floorplanTypeInput?.value || rec.floorplan_type || '').trim();
    if (!t) {
      setStatus('Set floorplan type first.');
      return;
    }
    rec.floorplan_type = t;
    let n = 0;
    getUnitsArray().forEach((u) => {
      if (u !== rec && String(u.floorplan_type || '') === t) {
        u.corners_xz = rec.corners_xz.map((c) => [...c]);
        u.center_xz = [...rec.center_xz];
        rebuildMeshesFor(u);
        n += 1;
      }
    });
    setStatus(`Propagated corners to ${n} other unit(s) with floorplan_type "${t}".`);
  }

  function exportPayload() {
    const units = getUnitsArray().map((u) => {
      if (!u.center_xz || u.center_xz.length < 2) recenterFromCorners(u);
      return {
      unit: String(u.unit),
      corners_xz: u.corners_xz.map((c) => [round6(c[0]), round6(c[1])]),
      center_xz: [round6(u.center_xz[0]), round6(u.center_xz[1])],
      rotation_deg: Number(u.rotation_deg) || 0,
      ground_y: Number(u.ground_y),
      floorplan_type: u.floorplan_type || '',
      floors: (u.floors || []).map((f) => ({ top_y: Number(f.top_y) })),
    };
    });
    return {
      version: state.unitsData?.version ?? 1,
      property: state.unitsData?.property || 'canyon-vista',
      units,
    };
  }

  async function copyUnitsJson() {
    const json = JSON.stringify(exportPayload(), null, 2);
    try {
      await navigator.clipboard.writeText(json);
      setStatus('Copied units JSON to clipboard.');
    } catch {
      window.__unitExportJson = json;
      setStatus('Clipboard failed — see window.__unitExportJson');
    }
  }

  async function loadUnits() {
    try {
      const res = await fetch(unitsJsonUrl, { cache: 'no-store' });
      if (!res.ok) throw new Error(`${res.status}`);
      state.unitsData = await res.json();
    } catch (e) {
      console.warn('unit-extrude-editor: failed to load', unitsJsonUrl, e);
      state.unitsData = { version: 1, property: 'canyon-vista', units: [] };
      setStatus(`No or invalid ${unitsJsonUrl}; use Add unit. (${e.message})`);
    }
    if (!Array.isArray(state.unitsData.units)) {
      state.unitsData.units = [];
    }
    state.unitGroups.forEach((g) => {
      scene.remove(g);
      g.traverse((ch) => {
        ch.geometry?.dispose();
        ch.material?.dispose();
      });
    });
    state.unitGroups.clear();
    getUnitsArray().forEach((rec) => rebuildMeshesFor(rec));
    refreshSlabOpacity();
    setStatus(`Loaded ${getUnitsArray().length} units (${propertyLabel}).`);
  }

  function setEditMode(on) {
    state.active = !!on;
    if (toggle) {
      toggle.classList.toggle('active', state.active);
      toggle.setAttribute('aria-pressed', state.active ? 'true' : 'false');
    }
    if (panel) panel.classList.toggle('active', state.active);
    refreshSlabOpacity();
    if (!state.active) {
      clearHandles();
      state.selectedUnitKey = null;
      if (selectedEl) selectedEl.textContent = 'Unit: none';
      syncInputsFromRec(null);
    } else {
      const rec = findRec(state.selectedUnitKey);
      if (rec) buildHandlesFor(rec);
    }
    setStatus(
      state.active
        ? 'Unit edit mode on — click slabs or drag yellow handles.'
        : 'Unit overlays hidden (opacity 0).'
    );
  }

  function syncToggleVisibility() {
    const vis = getParameters().developerToolsVisible !== false;
    if (toggle && toggle.parentElement) {
      toggle.parentElement.style.display = vis ? '' : 'none';
    }
    if (!vis && state.active) setEditMode(false);
  }

  if (toggle) {
    toggle.addEventListener('click', () => setEditMode(!state.active));
  }
  if (cornerSelect) {
    cornerSelect.addEventListener('change', () => {
      state.selectedCornerIndex = Math.min(3, Math.max(0, parseInt(cornerSelect.value, 10) || 0));
      syncInputsFromRec(findRec(state.selectedUnitKey));
      buildHandlesFor(findRec(state.selectedUnitKey));
    });
  }
  if (vertexX) vertexX.addEventListener('change', applyCornerFromInputs);
  if (vertexZ) vertexZ.addEventListener('change', applyCornerFromInputs);
  if (groundYInput) groundYInput.addEventListener('change', applyGroundYFromInput);
  if (floorplanTypeInput) floorplanTypeInput.addEventListener('change', applyFloorplanFromInput);
  if (markFloorTopBtn) markFloorTopBtn.addEventListener('click', () => onMarkFloorTop());
  if (addManualBtn) addManualBtn.addEventListener('click', () => addManualUnit());
  if (propagateBtn) propagateBtn.addEventListener('click', () => propagateCornersByFloorplan());
  if (copyJsonBtn) copyJsonBtn.addEventListener('click', () => copyUnitsJson());

  window.addEventListener('keydown', handleKeyDown);
  window.addEventListener(
    'pointercancel',
    () => {
      endDrag();
    },
    { passive: true }
  );
  syncToggleVisibility();

  loadUnits();

  const api = {
    handlePointerDownCapture,
    handlePointerMove,
    handlePointerUp,
    reload: loadUnits,
    get isActive() {
      return state.active;
    },
    setEditMode,
    syncToggleVisibility,
  };
  window.__unitEditor = api;
  return api;
}
