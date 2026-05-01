/**
 * Canyon Vista room KML overlay.
 *
 * Loads the generated pixel-coordinate KML, maps it into the viewer's XZ scene
 * bounds, renders selectable room outlines, and exposes a small runtime API for
 * room-number lookup.
 */
import {
  BoxGeometry,
  DoubleSide,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Raycaster,
  Shape,
  ShapeGeometry,
  Vector2,
  Vector3,
} from 'three';

const KML_PIXEL_SCALE = 10000;
const DEFAULT_KML_URL = 'exports/canyon-vista-units.kml';
const DEFAULT_SCENE_Y = -0.052;
const LINE_THICKNESS = 0.012;
const LINE_HEIGHT = 0.004;
const NORMAL_LINE_COLOR = 0xf2f2f2;
const SELECTED_LINE_COLOR = 0xffd047;
const NORMAL_FILL_COLOR = 0xff6b35;
const SELECTED_FILL_COLOR = 0xffd047;

function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}

function placemarkChildren(doc) {
  const byTag = Array.from(doc.getElementsByTagName('Placemark'));
  if (byTag.length) return byTag;
  return Array.from(doc.getElementsByTagNameNS('*', 'Placemark'));
}

function firstTextByTag(root, tag) {
  const direct = root.getElementsByTagName(tag)[0] || root.getElementsByTagNameNS('*', tag)[0];
  return direct ? String(direct.textContent || '').trim() : '';
}

export function parseKmlUnits(kmlText) {
  const doc = new DOMParser().parseFromString(kmlText, 'application/xml');
  const parserError = doc.getElementsByTagName('parsererror')[0];
  if (parserError) throw new Error('Invalid KML XML');

  return placemarkChildren(doc)
    .map((placemark) => {
      const name = firstTextByTag(placemark, 'name');
      const match = name.match(/(\d+)/);
      const unit = match ? Number.parseInt(match[1], 10) : NaN;
      const coordText = firstTextByTag(placemark, 'coordinates');
      const points = coordText
        .split(/\s+/)
        .filter(Boolean)
        .map((item) => {
          const [lon, lat] = item.split(',').map((part) => Number.parseFloat(part));
          return [round6(lon * KML_PIXEL_SCALE), round6(-lat * KML_PIXEL_SCALE)];
        });
      if (points.length > 1) {
        const first = points[0];
        const last = points[points.length - 1];
        if (first[0] === last[0] && first[1] === last[1]) points.pop();
      }
      return { unit, name, corners_px: points };
    })
    .filter((entry) => Number.isFinite(entry.unit) && entry.corners_px.length >= 4)
    .sort((a, b) => a.unit - b.unit);
}

function getImageBounds(units) {
  const xs = [];
  const ys = [];
  units.forEach((unit) => {
    unit.corners_px.forEach(([x, y]) => {
      xs.push(x);
      ys.push(y);
    });
  });
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
  };
}

function getSceneBounds(borderDotPositions = []) {
  const positions = borderDotPositions
    .map((entry) => entry?.position)
    .filter((position) => Number.isFinite(position?.x) && Number.isFinite(position?.z));
  if (!positions.length) {
    return { minX: -1.9, maxX: 0.65, minZ: -1.55, maxZ: 0.95 };
  }
  return {
    minX: Math.min(...positions.map((p) => p.x)),
    maxX: Math.max(...positions.map((p) => p.x)),
    minZ: Math.min(...positions.map((p) => p.z)),
    maxZ: Math.max(...positions.map((p) => p.z)),
  };
}

export function createImageToSceneMapper(units, borderDotPositions = []) {
  const image = getImageBounds(units);
  const scene = getSceneBounds(borderDotPositions);
  const width = Math.max(1, image.maxX - image.minX);
  const height = Math.max(1, image.maxY - image.minY);
  return {
    image,
    scene,
    mapPoint([x, y]) {
      const tx = (x - image.minX) / width;
      const ty = (y - image.minY) / height;
      return [
        round6(scene.minX + tx * (scene.maxX - scene.minX)),
        round6(scene.maxZ - ty * (scene.maxZ - scene.minZ)),
      ];
    },
  };
}

function polygonCenter(points) {
  return points.reduce(
    (acc, point) => {
      acc[0] += point[0] / points.length;
      acc[1] += point[1] / points.length;
      return acc;
    },
    [0, 0]
  );
}

function clonePoint(point) {
  return [round6(point[0]), round6(point[1])];
}

function makeFillMesh(points, y, material) {
  const shape = new Shape();
  shape.moveTo(points[0][0], -points[0][1]);
  for (let i = 1; i < points.length; i += 1) shape.lineTo(points[i][0], -points[i][1]);
  shape.closePath();
  const geometry = new ShapeGeometry(shape);
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(0, y, 0);
  const mesh = new Mesh(geometry, material);
  mesh.renderOrder = 1003;
  mesh.userData.isRoomFill = true;
  return mesh;
}

function makeEdgeMesh(startPoint, endPoint, y, material) {
  const start = new Vector3(startPoint[0], y, startPoint[1]);
  const end = new Vector3(endPoint[0], y, endPoint[1]);
  const direction = new Vector3().subVectors(end, start);
  const length = direction.length();
  const midPoint = new Vector3().addVectors(start, end).multiplyScalar(0.5);
  const geometry = new BoxGeometry(length, LINE_HEIGHT, LINE_THICKNESS);
  const mesh = new Mesh(geometry, material);

  const xAxis = direction.clone().normalize();
  let up = new Vector3(0, 1, 0);
  if (Math.abs(xAxis.dot(up)) > 0.9999) up = new Vector3(0, 0, 1);
  const zAxis = new Vector3().crossVectors(xAxis, up).normalize();
  const yAxis = new Vector3().crossVectors(zAxis, xAxis).normalize();
  const rotation = new Matrix4().makeBasis(xAxis, yAxis, zAxis);
  const translation = new Matrix4().makeTranslation(midPoint.x, midPoint.y, midPoint.z);

  mesh.matrixAutoUpdate = false;
  mesh.matrix.multiplyMatrices(translation, rotation);
  mesh.renderOrder = 1004;
  mesh.userData.isRoomEdge = true;
  return mesh;
}

function applyRoomVisual(room, selected) {
  room.fillMaterial.color.setHex(selected ? SELECTED_FILL_COLOR : NORMAL_FILL_COLOR);
  room.fillMaterial.opacity = selected ? 0.34 : 0.055;
  room.lineMaterial.color.setHex(selected ? SELECTED_LINE_COLOR : NORMAL_LINE_COLOR);
  room.lineMaterial.opacity = selected ? 1 : 0.58;
  room.group.renderOrder = selected ? 1007 : 1002;
}

function buildRoom(unitData, transform, sceneY) {
  const cornersXz = unitData.corners_px.map((point) => transform.mapPoint(point));
  const [cx, cz] = polygonCenter(cornersXz);
  const group = new Group();
  group.name = `room-${unitData.unit}`;
  group.userData.isRoomKmlGroup = true;
  group.userData.roomUnit = unitData.unit;

  const fillMaterial = new MeshBasicMaterial({
    color: NORMAL_FILL_COLOR,
    transparent: true,
    opacity: 0.055,
    depthTest: false,
    depthWrite: false,
    side: DoubleSide,
  });
  const lineMaterial = new MeshBasicMaterial({
    color: NORMAL_LINE_COLOR,
    transparent: true,
    opacity: 0.58,
    depthTest: false,
    depthWrite: false,
  });
  const fillMesh = makeFillMesh(cornersXz, sceneY, fillMaterial);
  fillMesh.userData.roomUnit = unitData.unit;
  group.add(fillMesh);

  cornersXz.forEach((point, idx) => {
    const next = cornersXz[(idx + 1) % cornersXz.length];
    const edge = makeEdgeMesh(point, next, sceneY + 0.004, lineMaterial);
    edge.userData.roomUnit = unitData.unit;
    group.add(edge);
  });

  return {
    unit: unitData.unit,
    sourceName: unitData.name,
    cornersPx: unitData.corners_px,
    cornersXz,
    center: new Vector3(cx, sceneY, cz),
    group,
    fillMaterial,
    lineMaterial,
  };
}

function rebuildRoomGeometry(room, sceneY) {
  room.group.children.forEach((child) => child.geometry?.dispose?.());
  room.group.clear();
  const [cx, cz] = polygonCenter(room.cornersXz);
  room.center.set(cx, sceneY, cz);
  const fillMesh = makeFillMesh(room.cornersXz, sceneY, room.fillMaterial);
  fillMesh.userData.roomUnit = room.unit;
  groupRenderData(fillMesh, room.unit);
  room.group.add(fillMesh);
  room.cornersXz.forEach((point, idx) => {
    const next = room.cornersXz[(idx + 1) % room.cornersXz.length];
    const edge = makeEdgeMesh(point, next, sceneY + 0.004, room.lineMaterial);
    edge.userData.roomUnit = room.unit;
    groupRenderData(edge, room.unit);
    room.group.add(edge);
  });
}

function groupRenderData(mesh, unit) {
  mesh.userData.roomUnit = unit;
}

function roomFootprintSize(room) {
  const xs = room.cornersXz.map((point) => point[0]);
  const zs = room.cornersXz.map((point) => point[1]);
  return Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs));
}

export function initRoomKmlOverlay({
  scene,
  camera,
  controls,
  renderer,
  kmlUrl = DEFAULT_KML_URL,
  borderDotPositions = [],
  sceneY = DEFAULT_SCENE_Y,
  pauseCameraAutomation = null,
  elements = {},
} = {}) {
  const state = {
    rooms: new Map(),
    selectedRoom: null,
    selectedVertexIndex: 0,
    editorOpen: false,
    editorMode: 'plan',
    floorBaseCenter: { x: 0, z: 0 },
    floorTransform: { centerX: 0, centerZ: 0, rotationDeg: 0, scale: 1 },
    group: new Group(),
    raycaster: new Raycaster(),
    ndc: new Vector2(),
    ready: null,
  };
  state.group.name = 'room-kml-overlay';
  state.group.matrixAutoUpdate = false;
  scene.add(state.group);

  const input = elements.input || null;
  const statusEl = elements.statusEl || null;
  const clearButton = elements.clearButton || null;
  const panel = elements.panel || null;
  const editorToggle = elements.editorToggle || null;
  const editorPanel = elements.editorPanel || null;
  const planTab = elements.planTab || null;
  const vertexTab = elements.vertexTab || null;
  const planPane = elements.planPane || null;
  const vertexPane = elements.vertexPane || null;
  const centerXInput = elements.centerX || null;
  const centerZInput = elements.centerZ || null;
  const rotationInput = elements.rotation || null;
  const scaleInput = elements.scale || null;
  const resetTransformButton = elements.resetTransformButton || null;
  const editorSelectedEl = elements.editorSelectedEl || null;
  const vertexSelect = elements.vertexSelect || null;
  const vertexXInput = elements.vertexX || null;
  const vertexZInput = elements.vertexZ || null;
  const applyVertexButton = elements.applyVertexButton || null;

  function setStatus(text) {
    if (statusEl) statusEl.textContent = text;
  }

  function formatNumber(value) {
    return Number.isFinite(value) ? String(round6(value)) : '';
  }

  function displayedPoint([x, z], y = sceneY) {
    state.group.updateMatrixWorld(true);
    return new Vector3(x, y, z).applyMatrix4(state.group.matrixWorld);
  }

  function displayedCenter(room) {
    return displayedPoint([room.center.x, room.center.z], room.center.y);
  }

  function applyFloorTransform() {
    const { centerX, centerZ, rotationDeg, scale } = state.floorTransform;
    const moveToOrigin = new Matrix4().makeTranslation(-state.floorBaseCenter.x, 0, -state.floorBaseCenter.z);
    const scaleMatrix = new Matrix4().makeScale(scale, 1, scale);
    const rotationMatrix = new Matrix4().makeRotationY((rotationDeg * Math.PI) / 180);
    const moveToCenter = new Matrix4().makeTranslation(centerX, 0, centerZ);
    state.group.matrix.identity();
    state.group.matrix.multiply(moveToCenter).multiply(rotationMatrix).multiply(scaleMatrix).multiply(moveToOrigin);
    state.group.updateMatrixWorld(true);
  }

  function syncPlanInputs() {
    if (centerXInput) centerXInput.value = formatNumber(state.floorTransform.centerX);
    if (centerZInput) centerZInput.value = formatNumber(state.floorTransform.centerZ);
    if (rotationInput) rotationInput.value = formatNumber(state.floorTransform.rotationDeg);
    if (scaleInput) scaleInput.value = formatNumber(state.floorTransform.scale);
  }

  function setFloorTransform(next = {}) {
    const centerX = Number.parseFloat(next.centerX);
    const centerZ = Number.parseFloat(next.centerZ);
    const rotationDeg = Number.parseFloat(next.rotationDeg);
    const scale = Number.parseFloat(next.scale);
    if (Number.isFinite(centerX)) state.floorTransform.centerX = round6(centerX);
    if (Number.isFinite(centerZ)) state.floorTransform.centerZ = round6(centerZ);
    if (Number.isFinite(rotationDeg)) state.floorTransform.rotationDeg = round6(rotationDeg);
    if (Number.isFinite(scale)) state.floorTransform.scale = round6(Math.max(0.05, Math.min(20, scale)));
    applyFloorTransform();
    syncPlanInputs();
    return getFloorTransform();
  }

  function getFloorTransform() {
    return { ...state.floorTransform };
  }

  function resetFloorTransform() {
    state.floorTransform = {
      centerX: state.floorBaseCenter.x,
      centerZ: state.floorBaseCenter.z,
      rotationDeg: 0,
      scale: 1,
    };
    applyFloorTransform();
    syncPlanInputs();
    return getFloorTransform();
  }

  function setEditorOpen(open) {
    state.editorOpen = !!open;
    if (editorPanel) editorPanel.classList.toggle('active', state.editorOpen);
    if (editorToggle) {
      editorToggle.classList.toggle('active', state.editorOpen);
      editorToggle.setAttribute('aria-pressed', state.editorOpen ? 'true' : 'false');
    }
  }

  function setEditorMode(mode) {
    state.editorMode = mode === 'vertex' ? 'vertex' : 'plan';
    if (planTab) planTab.classList.toggle('active', state.editorMode === 'plan');
    if (vertexTab) vertexTab.classList.toggle('active', state.editorMode === 'vertex');
    if (planPane) planPane.classList.toggle('active', state.editorMode === 'plan');
    if (vertexPane) vertexPane.classList.toggle('active', state.editorMode === 'vertex');
  }

  function syncVertexInputs() {
    const room = state.selectedRoom;
    if (editorSelectedEl) editorSelectedEl.textContent = room ? `Unit ${room.unit}` : 'Select a room';
    if (vertexSelect) {
      vertexSelect.innerHTML = '';
      if (room) {
        room.cornersXz.forEach((_, idx) => {
          const option = document.createElement('option');
          option.value = String(idx);
          option.textContent = `Vertex ${idx + 1}`;
          vertexSelect.appendChild(option);
        });
        state.selectedVertexIndex = Math.min(state.selectedVertexIndex, room.cornersXz.length - 1);
        vertexSelect.value = String(state.selectedVertexIndex);
      }
    }
    const vertex = room ? room.cornersXz[state.selectedVertexIndex] : null;
    if (vertexXInput) vertexXInput.value = vertex ? formatNumber(vertex[0]) : '';
    if (vertexZInput) vertexZInput.value = vertex ? formatNumber(vertex[1]) : '';
  }

  function getRoomVertex(unit, vertexIndex = 0) {
    const room = state.rooms.get(Number.parseInt(String(unit), 10));
    const idx = Number.parseInt(String(vertexIndex), 10);
    if (!room || !Number.isFinite(idx) || !room.cornersXz[idx]) return null;
    return clonePoint(room.cornersXz[idx]);
  }

  function updateRoomVertex(unit, vertexIndex, point = {}) {
    const room = state.rooms.get(Number.parseInt(String(unit), 10));
    const idx = Number.parseInt(String(vertexIndex), 10);
    const x = Number.parseFloat(point.x);
    const z = Number.parseFloat(point.z);
    if (!room || !Number.isFinite(idx) || !room.cornersXz[idx] || !Number.isFinite(x) || !Number.isFinite(z)) return null;
    room.cornersXz[idx] = [round6(x), round6(z)];
    rebuildRoomGeometry(room, sceneY);
    applyRoomVisual(room, state.selectedRoom === room);
    syncVertexInputs();
    return getRoomVertex(unit, idx);
  }

  function focusRoom(room) {
    if (!room || !controls || !camera) return;
    const center = displayedCenter(room);
    const focusDistance = Math.min(1.35, Math.max(0.72, roomFootprintSize(room) * state.floorTransform.scale * 4.8));
    controls.target.set(center.x, center.y, center.z);
    camera.position.set(
      center.x + focusDistance * 0.22,
      sceneY + focusDistance * 1.16,
      center.z + focusDistance * 0.38
    );
    controls.update();
  }

  function setSelectedRoom(room, { syncInput = true, focus = true } = {}) {
    if (state.selectedRoom) applyRoomVisual(state.selectedRoom, false);
    state.selectedRoom = room || null;
    if (state.selectedRoom) {
      applyRoomVisual(state.selectedRoom, true);
      if (typeof pauseCameraAutomation === 'function') pauseCameraAutomation();
      if (syncInput && input) input.value = String(state.selectedRoom.unit);
      setStatus(`Room ${state.selectedRoom.unit}`);
      document.documentElement.dataset.selectedRoom = String(state.selectedRoom.unit);
      syncVertexInputs();
      if (focus && controls) {
        focusRoom(state.selectedRoom);
      }
    } else {
      if (syncInput && input) input.value = '';
      setStatus(`Loaded ${state.rooms.size} rooms`);
      delete document.documentElement.dataset.selectedRoom;
      syncVertexInputs();
    }
  }

  function selectRoom(value, options = {}) {
    const unit = Number.parseInt(String(value || '').trim(), 10);
    if (!Number.isFinite(unit)) {
      setSelectedRoom(null, options);
      return false;
    }
    const room = state.rooms.get(unit) || null;
    if (!room) {
      if (state.selectedRoom) applyRoomVisual(state.selectedRoom, false);
      state.selectedRoom = null;
      setStatus(`Room ${unit} not found`);
      delete document.documentElement.dataset.selectedRoom;
      return false;
    }
    setSelectedRoom(room, options);
    return true;
  }

  function getRoomObjects() {
    const objects = [];
    state.rooms.forEach((room) => {
      room.group.traverse((child) => {
        if (child.isMesh) objects.push(child);
      });
    });
    return objects;
  }

  function selectFromPointer(event) {
    if (!state.rooms.size) return false;
    const rect = renderer.domElement.getBoundingClientRect();
    state.ndc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    state.ndc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    state.raycaster.setFromCamera(state.ndc, camera);
    const hits = state.raycaster.intersectObjects(getRoomObjects(), false);
    if (!hits.length) return false;
    const unit = hits[0].object.userData.roomUnit;
    return selectRoom(unit, { syncInput: true, focus: false });
  }

  function getRoomScreenState(unit) {
    const room = state.rooms.get(Number.parseInt(String(unit), 10));
    if (!room || !camera || !renderer?.domElement) return null;
    camera.updateProjectionMatrix?.();
    camera.updateMatrixWorld?.(true);
    const rect = renderer.domElement.getBoundingClientRect();
    const projected = room.cornersXz.map((corner) => {
      const point = displayedPoint(corner, sceneY + 0.025).project(camera);
      return {
        x: round6((point.x + 1) * 0.5 * rect.width),
        y: round6((1 - point.y) * 0.5 * rect.height),
        z: round6(point.z),
        inDepth: point.z > -1 && point.z < 1,
      };
    });
    const visiblePoints = projected.filter((point) => point.inDepth);
    const xs = visiblePoints.map((point) => point.x);
    const ys = visiblePoints.map((point) => point.y);
    const minX = xs.length ? Math.min(...xs) : null;
    const maxX = xs.length ? Math.max(...xs) : null;
    const minY = ys.length ? Math.min(...ys) : null;
    const maxY = ys.length ? Math.max(...ys) : null;
    const intersectsViewport = xs.length > 0 && maxX >= 0 && minX <= rect.width && maxY >= 0 && minY <= rect.height;
    return {
      selected: state.selectedRoom === room,
      visiblePointCount: visiblePoints.length,
      intersectsViewport,
      bounds: xs.length
        ? {
            minX: round6(minX),
            maxX: round6(maxX),
            minY: round6(minY),
            maxY: round6(maxY),
            width: round6(maxX - minX),
            height: round6(maxY - minY),
          }
        : null,
    };
  }

  function orbitSelectedRoomForVerification({ azimuth = 0, elevationRatio = 0.7, distanceScale = 1 } = {}) {
    const room = state.selectedRoom;
    if (!room || !camera || !controls) return null;
    const currentDistance = Math.max(0.58, camera.position.distanceTo(controls.target) * distanceScale);
    const clampedElevation = Math.min(1.1, Math.max(0.35, Number(elevationRatio) || 0.7));
    const horizontalDistance = Math.max(0.28, currentDistance * Math.sqrt(Math.max(0.08, 1 - clampedElevation * clampedElevation)));
    const center = displayedCenter(room);
    controls.target.set(center.x, center.y, center.z);
    camera.position.set(
      center.x + Math.cos(azimuth) * horizontalDistance,
      sceneY + currentDistance * clampedElevation,
      center.z + Math.sin(azimuth) * horizontalDistance
    );
    controls.update();
    return getRoomScreenState(room.unit);
  }

  function handlePointerDown(event) {
    if (selectFromPointer(event)) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  if (panel) {
    ['pointerdown', 'click', 'touchstart'].forEach((eventName) => {
      panel.addEventListener(eventName, (event) => event.stopPropagation(), { passive: true });
    });
  }
  if (editorPanel) {
    ['pointerdown', 'click', 'touchstart'].forEach((eventName) => {
      editorPanel.addEventListener(eventName, (event) => event.stopPropagation(), { passive: true });
    });
  }

  if (editorToggle) {
    editorToggle.addEventListener('click', () => setEditorOpen(!state.editorOpen));
  }
  if (planTab) planTab.addEventListener('click', () => setEditorMode('plan'));
  if (vertexTab) vertexTab.addEventListener('click', () => setEditorMode('vertex'));

  function applyPlanInputs() {
    setFloorTransform({
      centerX: centerXInput?.value,
      centerZ: centerZInput?.value,
      rotationDeg: rotationInput?.value,
      scale: scaleInput?.value,
    });
  }

  [centerXInput, centerZInput, rotationInput, scaleInput].forEach((field) => {
    if (!field) return;
    field.addEventListener('input', applyPlanInputs);
    field.addEventListener('change', applyPlanInputs);
  });
  if (resetTransformButton) resetTransformButton.addEventListener('click', resetFloorTransform);

  if (vertexSelect) {
    vertexSelect.addEventListener('change', () => {
      state.selectedVertexIndex = Number.parseInt(vertexSelect.value, 10) || 0;
      syncVertexInputs();
    });
  }

  function applyVertexInputs() {
    if (!state.selectedRoom) return;
    updateRoomVertex(state.selectedRoom.unit, state.selectedVertexIndex, {
      x: vertexXInput?.value,
      z: vertexZInput?.value,
    });
  }

  [vertexXInput, vertexZInput].forEach((field) => {
    if (!field) return;
    field.addEventListener('input', applyVertexInputs);
    field.addEventListener('change', applyVertexInputs);
  });
  if (applyVertexButton) applyVertexButton.addEventListener('click', applyVertexInputs);

  if (input) {
    input.addEventListener('input', () => {
      const value = input.value.trim();
      if (!value) setSelectedRoom(null);
      else selectRoom(value, { syncInput: false, focus: true });
    });
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      selectRoom(input.value, { syncInput: true, focus: true });
    });
  }
  if (clearButton) {
    clearButton.addEventListener('click', () => setSelectedRoom(null, { syncInput: true, focus: false }));
  }
  renderer.domElement.addEventListener('pointerdown', handlePointerDown, { passive: false, capture: true });

  async function load() {
    setStatus('Loading rooms');
    const res = await fetch(kmlUrl, { cache: 'no-store' });
    if (!res.ok) throw new Error(`KML ${res.status}`);
    const units = parseKmlUnits(await res.text());
    const transform = createImageToSceneMapper(units, borderDotPositions);
    units.forEach((unit) => {
      const room = buildRoom(unit, transform, sceneY);
      state.rooms.set(room.unit, room);
      state.group.add(room.group);
    });
    state.floorBaseCenter = {
      x: round6((transform.scene.minX + transform.scene.maxX) / 2),
      z: round6((transform.scene.minZ + transform.scene.maxZ) / 2),
    };
    state.floorTransform = {
      centerX: state.floorBaseCenter.x,
      centerZ: state.floorBaseCenter.z,
      rotationDeg: 0,
      scale: 1,
    };
    applyFloorTransform();
    syncPlanInputs();
    setEditorMode('plan');
    syncVertexInputs();
    document.documentElement.dataset.roomOverlayReady = 'true';
    setStatus(`Loaded ${state.rooms.size} rooms`);
    return state.rooms.size;
  }

  state.ready = load().catch((error) => {
    console.warn('room-kml-overlay failed to load', error);
    setStatus('Rooms unavailable');
    throw error;
  });

  const api = {
    ready: state.ready,
    selectRoom,
    getSelectedRoom() {
      return state.selectedRoom ? state.selectedRoom.unit : null;
    },
    roomCount() {
      return state.rooms.size;
    },
    getRoomUnits() {
      return Array.from(state.rooms.keys()).sort((a, b) => a - b);
    },
    getRoomBounds(unit) {
      const room = state.rooms.get(Number.parseInt(String(unit), 10));
      return room ? room.cornersXz.map((point) => {
        const displayed = displayedPoint(point);
        return [round6(displayed.x), round6(displayed.z)];
      }) : null;
    },
    getRoomVertex,
    updateRoomVertex,
    getFloorTransform,
    setFloorTransform,
    resetFloorTransform,
    setEditorOpen,
    setEditorMode,
    getRoomScreenState(unit) {
      return getRoomScreenState(unit);
    },
    getRoomVisualState(unit) {
      const room = state.rooms.get(Number.parseInt(String(unit), 10));
      if (!room) return null;
      return {
        selected: state.selectedRoom === room,
        fillOpacity: round6(room.fillMaterial.opacity),
        lineOpacity: round6(room.lineMaterial.opacity),
        fillColor: room.fillMaterial.color.getHexString(),
        lineColor: room.lineMaterial.color.getHexString(),
      };
    },
    orbitSelectedRoomForVerification,
    dispose() {
      renderer.domElement.removeEventListener('pointerdown', handlePointerDown, { capture: true });
      scene.remove(state.group);
      state.group.traverse((child) => {
        child.geometry?.dispose?.();
        child.material?.dispose?.();
      });
      state.rooms.clear();
    },
  };
  window.__roomKmlOverlay = api;
  return api;
}
