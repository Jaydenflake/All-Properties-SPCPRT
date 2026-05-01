import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { mountUnitMarkers } from './unit-markers.mjs';
import { getPositions, replaceAllPositions } from './unit-positions.mjs';

/**
 * @param {object} ctx
 * @param {import('three').Scene} ctx.scene
 * @param {import('three').PerspectiveCamera} ctx.camera
 * @param {import('three').OrbitControls} ctx.controls
 * @param {import('three').WebGLRenderer} ctx.renderer
 * @param {import('./units-data.mjs').Unit[]} ctx.units
 */
export function initAdminDashboard(ctx) {
  const { scene, camera, controls, renderer, units } = ctx;

  let positions = getPositions();
  const panel = ensurePanel();

  const markers = mountUnitMarkers({
    scene,
    camera,
    renderer,
    mode: 'admin',
    units,
    getPositionsMap: () => positions,
    getOnlyAvailable: () => false,
    onMarkerSelect: (unitNumber) => selectUnit(unitNumber),
  });

  const transform = new TransformControls(camera, renderer.domElement);
  transform.setMode('translate');
  transform.setSize(0.65);
  transform.visible = false;
  scene.add(transform);
  transform.addEventListener('dragging-changed', (ev) => {
    controls.enabled = !ev.value;
  });

  /** @type {string | null} */
  let selected = null;

  function floatOffsetY() {
    return 0.04;
  }

  function applyGroupPositionToMap(unitNumber) {
    const g = markers.getGroup(unitNumber);
    if (!g) return;
    positions[unitNumber] = {
      x: g.position.x,
      y: g.position.y - floatOffsetY(),
      z: g.position.z,
    };
  }

  transform.addEventListener('change', () => {
    if (selected) applyGroupPositionToMap(selected);
    syncInputs();
  });

  function selectUnit(unitNumber) {
    selected = unitNumber;
    markers.setSelected(unitNumber);
    const g = markers.getGroup(unitNumber);
    if (g) {
      transform.attach(g);
      transform.visible = true;
    }
    syncInputs();
    renderList();
  }

  function syncInputs() {
    const g = selected ? markers.getGroup(selected) : null;
    const ix = panel.querySelector('#admin-pos-x');
    const iy = panel.querySelector('#admin-pos-y');
    const iz = panel.querySelector('#admin-pos-z');
    if (!g || !ix || !iy || !iz) return;
    ix.value = String(round4(g.position.x));
    iy.value = String(round4(g.position.y - floatOffsetY()));
    iz.value = String(round4(g.position.z));
  }

  function applyInputs() {
    if (!selected) return;
    const ix = panel.querySelector('#admin-pos-x');
    const iy = panel.querySelector('#admin-pos-y');
    const iz = panel.querySelector('#admin-pos-z');
    const x = Number(ix?.value);
    const y = Number(iy?.value);
    const z = Number(iz?.value);
    if (![x, y, z].every(Number.isFinite)) return;
    markers.setWorldPosition(selected, { x, y, z });
    applyGroupPositionToMap(selected);
    syncInputs();
  }

  function getCurrentPositionsMap() {
    const next = { ...getPositions() };
    for (const u of units) {
      const g = markers.getGroup(u.unitNumber);
      if (g) {
        next[u.unitNumber] = {
          x: g.position.x,
          y: g.position.y - floatOffsetY(),
          z: g.position.z,
        };
      }
    }
    return next;
  }

  function saveAll() {
    positions = getCurrentPositionsMap();
    replaceAllPositions(positions);
    panel.querySelector('#admin-status').textContent = 'Saved to localStorage.';
  }

  function copyJson() {
    const json = JSON.stringify(getCurrentPositionsMap(), null, 2);
    navigator.clipboard.writeText(json).then(
      () => {
        panel.querySelector('#admin-status').textContent = 'JSON copied to clipboard.';
      },
      () => {
        panel.querySelector('#admin-status').textContent = 'Copy failed.';
      }
    );
  }

  function renderList() {
    const ul = panel.querySelector('#admin-unit-list');
    ul.innerHTML = '';
    for (const u of units) {
      const li = document.createElement('button');
      li.type = 'button';
      li.className = 'admin-unit-row' + (selected === u.unitNumber ? ' active' : '');
      li.innerHTML = `<span class="admin-unit-num">Unit ${u.unitNumber}</span><span class="admin-unit-meta">${u.beds}bd · $${u.price}${u.available ? '' : ' · Leased'}</span>`;
      li.addEventListener('click', () => selectUnit(u.unitNumber));
      ul.appendChild(li);
    }
  }

  panel.querySelector('#admin-save').addEventListener('click', saveAll);
  panel.querySelector('#admin-copy').addEventListener('click', copyJson);
  panel.querySelector('#admin-apply-pos').addEventListener('click', applyInputs);
  panel.querySelector('#back-to-viewer').addEventListener('click', () => {
    window.location.href = 'index.html';
  });

  renderList();

  return {
    frame() {
      markers.update();
    },
    dispose() {
      transform.dispose();
      scene.remove(transform);
      markers.dispose();
    },
  };
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

function ensurePanel() {
  let el = document.getElementById('apartments-admin-panel');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'apartments-admin-panel';
  el.className = 'apartments-admin-panel';
  el.innerHTML = `
    <div class="apartments-admin-header">
      <h1>Unit placement</h1>
      <button type="button" id="back-to-viewer" class="admin-link-btn">← Public viewer</button>
    </div>
    <p id="admin-status" class="admin-status">Click a unit below or tap a marker in the 3D view — then drag the gizmo arrows to reposition it.</p>
    <div id="admin-unit-list" class="admin-unit-list"></div>
    <div class="admin-pos-grid">
      <label>X <input id="admin-pos-x" type="number" step="0.001" /></label>
      <label>Y <input id="admin-pos-y" type="number" step="0.001" /></label>
      <label>Z <input id="admin-pos-z" type="number" step="0.001" /></label>
    </div>
    <button type="button" id="admin-apply-pos" class="admin-primary">Apply numbers</button>
    <div class="admin-actions">
      <button type="button" id="admin-save" class="admin-primary">Save positions</button>
      <button type="button" id="admin-copy" class="admin-secondary">Copy positions JSON</button>
    </div>
  `;
  document.body.appendChild(el);
  return el;
}
