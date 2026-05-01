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
    group: new Group(),
    raycaster: new Raycaster(),
    ndc: new Vector2(),
    ready: null,
  };
  state.group.name = 'room-kml-overlay';
  scene.add(state.group);

  const input = elements.input || null;
  const statusEl = elements.statusEl || null;
  const clearButton = elements.clearButton || null;
  const panel = elements.panel || null;

  function setStatus(text) {
    if (statusEl) statusEl.textContent = text;
  }

  function focusRoom(room) {
    if (!room || !controls || !camera) return;
    const focusDistance = Math.min(1.35, Math.max(0.72, roomFootprintSize(room) * 4.8));
    controls.target.set(room.center.x, sceneY, room.center.z);
    camera.position.set(
      room.center.x + focusDistance * 0.22,
      sceneY + focusDistance * 1.16,
      room.center.z + focusDistance * 0.38
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
      if (focus && controls) {
        focusRoom(state.selectedRoom);
      }
    } else {
      if (syncInput && input) input.value = '';
      setStatus(`Loaded ${state.rooms.size} rooms`);
      delete document.documentElement.dataset.selectedRoom;
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
    const projected = room.cornersXz.map(([x, z]) => {
      const point = new Vector3(x, sceneY + 0.025, z).project(camera);
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
    controls.target.set(room.center.x, sceneY, room.center.z);
    camera.position.set(
      room.center.x + Math.cos(azimuth) * horizontalDistance,
      sceneY + currentDistance * clampedElevation,
      room.center.z + Math.sin(azimuth) * horizontalDistance
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
      return room ? room.cornersXz.map((point) => [...point]) : null;
    },
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
