/**
 * Canyon Vista room KML overlay.
 *
 * Loads the generated pixel-coordinate KML, maps it into the viewer's XZ scene
 * bounds, renders selectable room outlines, and exposes a small runtime API for
 * room-number lookup.
 */
import {
  BoxGeometry,
  CanvasTexture,
  DoubleSide,
  ExtrudeGeometry,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Plane,
  Raycaster,
  Shape,
  ShapeGeometry,
  Sprite,
  SpriteMaterial,
  SphereGeometry,
  Vector2,
  Vector3,
} from 'three';

const KML_PIXEL_SCALE = 10000;
const DEFAULT_KML_URL = 'exports/canyon-vista-units.kml';
const DEFAULT_REPO_TRANSFORM_URL = 'exports/canyon-vista-floor-plan-transform.json';
const DEFAULT_STACK_ASSET_URL = 'assets/canyon-vista-floorplan-cubes.json';
const SAVE_TRANSFORM_ENDPOINT = '/__codex/canyon-vista-floor-plan-transform';
const SAVE_STACK_ASSET_ENDPOINT = '/__codex/canyon-vista-floorplan-cubes';
const DEFAULT_SCENE_Y = -0.052;
const FLOOR_TRANSFORM_STORAGE_KEY = 'canyon-vista:room-kml-overlay:floor-transform:v1';
const LINE_THICKNESS = 0.012;
const LINE_HEIGHT = 0.004;
const NORMAL_LINE_COLOR = 0xf2f2f2;
const SELECTED_LINE_COLOR = 0xffd047;
const NORMAL_FILL_COLOR = 0xff6b35;
const SELECTED_FILL_COLOR = 0xffd047;
const STACK_CUBE_COLOR = 0xffffff;
const STACK_CUBE_OPACITY = 0;
const SELECTED_STACK_CUBE_COLOR = 0x72f59b;
const DEFAULT_SELECTED_STACK_CUBE_OPACITY = 0.42;
const FOCUSED_STACK_SIBLING_OPACITY = 0.065;
const FOCUSED_STACK_SIBLING_LABEL_OPACITY = 0.065;
const STACK_UNIT_DOUBLE_TAP_MS = 420;
const STACK_UNIT_DOUBLE_TAP_PX = 28;
const DEFAULT_FLOOR_ROTATION_DEG = 0;
const DEFAULT_FLOOR_FLIP_X = true;
const PLAN_GIZMO_MOVE_COLOR = 0xffd047;
const PLAN_GIZMO_HEIGHT_COLOR = 0x72f59b;
const PLAN_GIZMO_SCALE_COLOR = 0x36d6ff;
const PLAN_GIZMO_ROTATE_COLOR = 0xff7ad9;
const PLAN_GIZMO_EDGE_COLOR = 0xffffff;
const PLAN_GIZMO_HANDLE_RADIUS = 0.04;
const PLAN_GIZMO_Y_OFFSET = 0.072;
const VERTEX_HANDLE_COLOR = 0x36d6ff;
const SELECTED_VERTEX_HANDLE_COLOR = 0xffd047;
const VERTEX_HANDLE_RADIUS = 0.026;

function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}

function normalizeDegrees(degrees) {
  let value = degrees % 360;
  if (value > 180) value -= 360;
  if (value < -180) value += 360;
  return round6(value);
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

function makeVertexHandleMesh(unit, vertexIndex, point, sceneY, selected) {
  const geometry = new SphereGeometry(VERTEX_HANDLE_RADIUS, 18, 10);
  const material = new MeshBasicMaterial({
    color: selected ? SELECTED_VERTEX_HANDLE_COLOR : VERTEX_HANDLE_COLOR,
    transparent: true,
    opacity: 0.96,
    depthTest: false,
    depthWrite: false,
  });
  const mesh = new Mesh(geometry, material);
  mesh.position.set(point[0], sceneY + 0.038, point[1]);
  mesh.scale.setScalar(selected ? 1.45 : 1.08);
  mesh.renderOrder = 1012;
  mesh.userData.isVertexHandle = true;
  mesh.userData.roomUnit = unit;
  mesh.userData.vertexIndex = vertexIndex;
  return mesh;
}

function makeStackCubeMesh(cornersXz, bottomY, topY, unitNumber, levelBase) {
  const shape = new Shape();
  shape.moveTo(cornersXz[0][0], -cornersXz[0][1]);
  for (let i = 1; i < cornersXz.length; i += 1) shape.lineTo(cornersXz[i][0], -cornersXz[i][1]);
  shape.closePath();
  const depth = Math.max(0.001, topY - bottomY);
  const geometry = new ExtrudeGeometry(shape, { depth, bevelEnabled: false });
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(0, bottomY, 0);
  const material = new MeshBasicMaterial({
    color: STACK_CUBE_COLOR,
    transparent: true,
    opacity: STACK_CUBE_OPACITY,
    depthTest: false,
    depthWrite: false,
    side: DoubleSide,
  });
  const mesh = new Mesh(geometry, material);
  mesh.renderOrder = 1180;
  mesh.userData.isFloorPlanCube = true;
  mesh.userData.unitNumber = unitNumber;
  mesh.userData.levelBase = levelBase;
  return mesh;
}

function makeUnitLabelTexture(text, { hover = false } = {}) {
  // Match the on-screen waypoint pill (`.tapdot-label-bubble`):
  //   - fully rounded ("border-radius: 9999px")
  //   - neutral glass surface matching `rgba(255,255,255,0.25)` over a
  //     `backdrop-filter: blur(20px)`; canvases can't backdrop-blur, so keep
  //     the texture neutral and fully opaque instead of tinting it sage
  //   - subtle diagonal highlight ring matching the CSS ::before gradient
  //   - white text in -apple-system / SF Pro / Helvetica Neue, weight 600
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const pillX = 14;
  const pillY = 30;
  const pillW = canvas.width - pillX * 2;
  const pillH = canvas.height - pillY * 2 + 0;
  const pillR = pillH / 2;

  ctx.fillStyle = 'rgba(34, 38, 44, 0.58)';
  roundRect(ctx, pillX, pillY, pillW, pillH, pillR);
  ctx.fill();

  ctx.fillStyle = 'rgba(255, 255, 255, 0.24)';
  roundRect(ctx, pillX, pillY, pillW, pillH, pillR);
  ctx.fill();

  const borderGrad = ctx.createLinearGradient(pillX, pillY, pillX + pillW, pillY + pillH);
  borderGrad.addColorStop(0, 'rgba(255, 255, 255, 0.46)');
  borderGrad.addColorStop(0.41, 'rgba(255, 255, 255, 0)');
  borderGrad.addColorStop(0.57, 'rgba(255, 255, 255, 0)');
  borderGrad.addColorStop(1, 'rgba(255, 255, 255, 0.46)');
  ctx.strokeStyle = borderGrad;
  ctx.lineWidth = 2;
  roundRect(ctx, pillX + 1, pillY + 1, pillW - 2, pillH - 2, pillR - 1);
  ctx.stroke();

  ctx.fillStyle = 'rgba(255, 255, 255, 0.96)';
  ctx.font = '600 36px -apple-system, "SF Pro Display", "Helvetica Neue", Helvetica, Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(text), hover ? canvas.width / 2 - 18 : canvas.width / 2, canvas.height / 2 + 1);

  if (hover) {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.beginPath();
    ctx.arc(canvas.width - 52, canvas.height / 2, 18, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.94)';
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(canvas.width - 58, canvas.height / 2 - 9);
    ctx.lineTo(canvas.width - 48, canvas.height / 2);
    ctx.lineTo(canvas.width - 58, canvas.height / 2 + 9);
    ctx.stroke();
  }

  return new CanvasTexture(canvas);
}

function makeUnitLabelSprite(text) {
  const texture = makeUnitLabelTexture(text);
  const hoverTexture = makeUnitLabelTexture(text, { hover: true });
  const material = new SpriteMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false });
  const sprite = new Sprite(material);
  sprite.scale.set(0.16, 0.08, 1);
  sprite.renderOrder = 1400;
  sprite.userData.isFloorPlanCubeLabel = true;
  sprite.userData.texture = texture;
  sprite.userData.hoverTexture = hoverTexture;
  return sprite;
}

function roundRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

function makePlanGizmoHandle(kind, point, sceneY, cornerIndex = -1) {
  const geometry = new SphereGeometry(PLAN_GIZMO_HANDLE_RADIUS, 20, 12);
  const material = new MeshBasicMaterial({
    color: kind === 'height'
      ? PLAN_GIZMO_HEIGHT_COLOR
      : kind === 'rotate'
        ? PLAN_GIZMO_ROTATE_COLOR
        : kind === 'scale'
          ? PLAN_GIZMO_SCALE_COLOR
          : PLAN_GIZMO_MOVE_COLOR,
    transparent: true,
    opacity: 0.96,
    depthTest: false,
    depthWrite: false,
  });
  const mesh = new Mesh(geometry, material);
  mesh.position.set(point[0], sceneY + PLAN_GIZMO_Y_OFFSET, point[1]);
  mesh.renderOrder = 1014;
  mesh.userData.isPlanGizmoHandle = true;
  mesh.userData.planGizmoKind = kind;
  mesh.userData.cornerIndex = cornerIndex;
  return mesh;
}

function makePlanGizmoEdge(startPoint, endPoint, sceneY) {
  const material = new MeshBasicMaterial({
    color: PLAN_GIZMO_EDGE_COLOR,
    transparent: true,
    opacity: 0.66,
    depthTest: false,
    depthWrite: false,
  });
  const edge = makeEdgeMesh(startPoint, endPoint, sceneY + PLAN_GIZMO_Y_OFFSET * 0.62, material);
  edge.renderOrder = 1013;
  edge.userData.isPlanGizmoEdge = true;
  return edge;
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
  repoTransformUrl = DEFAULT_REPO_TRANSFORM_URL,
  stackAssetUrl = DEFAULT_STACK_ASSET_URL,
  borderDotPositions = [],
  sceneY = DEFAULT_SCENE_Y,
  pauseCameraAutomation = null,
  onStackUnitClick = null,
  elements = {},
} = {}) {
  const state = {
    rooms: new Map(),
    selectedRoom: null,
    selectedVertexIndex: 0,
    editorOpen: false,
    editorMode: 'plan',
    planGizmoMode: 'move',
    planScaleMode: 'all',
    floorBaseCenter: { x: 0, z: 0 },
    floorTransform: {
      centerX: 0,
      centerY: 0,
      centerZ: 0,
      rotationDeg: DEFAULT_FLOOR_ROTATION_DEG,
      scale: 1,
      scaleX: 1,
      scaleZ: 1,
      flipX: DEFAULT_FLOOR_FLIP_X,
    },
    group: new Group(),
    floorPlanVisible: false,
    stackGroup: new Group(),
    stackGizmoGroup: new Group(),
    stackHeightHandle: null,
    stackVisible: true,
    selectedStackUnit: null,
    selectedStackUnits: new Set(),
    focusedStackUnit: null,
    hoveredStackUnit: null,
    lastStackTap: null,
    selectedStackCubeOpacity: DEFAULT_SELECTED_STACK_CUBE_OPACITY,
    stackAsset: { version: 1, property: 'canyon-vista', levels: [] },
    planGizmoGroup: new Group(),
    planGizmoHandles: [],
    vertexHandleGroup: new Group(),
    vertexHandles: [],
    drag: null,
    floorDragPlane: new Plane(new Vector3(0, 1, 0), -sceneY),
    floorDragPoint: new Vector3(),
    groupInverseMatrix: new Matrix4(),
    raycaster: new Raycaster(),
    ndc: new Vector2(),
    ready: null,
  };
  state.group.name = 'room-kml-overlay';
  state.stackGroup.name = 'canyon-vista-floorplan-cubes';
  state.stackGizmoGroup.name = 'canyon-vista-stack-height-gizmo';
  state.planGizmoGroup.name = 'room-kml-plan-gizmo';
  state.vertexHandleGroup.name = 'room-kml-vertex-handles';
  state.group.matrixAutoUpdate = false;
  state.group.add(state.planGizmoGroup);
  state.group.add(state.vertexHandleGroup);
  scene.add(state.group);
  scene.add(state.stackGroup);
  scene.add(state.stackGizmoGroup);

  const input = elements.input || null;
  const statusEl = elements.statusEl || null;
  const clearButton = elements.clearButton || null;
  const stackSearchPanel = elements.stackSearchPanel || null;
  const stackSearchInput = elements.stackSearchInput || null;
  const stackSearchClearButton = elements.stackSearchClearButton || null;
  const stackSearchDropdown = elements.stackSearchDropdown || null;
  const panel = elements.panel || null;
  const editorToggle = elements.editorToggle || null;
  const editorPanel = elements.editorPanel || null;
  const planTab = elements.planTab || null;
  const vertexTab = elements.vertexTab || null;
  const planPane = elements.planPane || null;
  const vertexPane = elements.vertexPane || null;
  const centerXInput = elements.centerX || null;
  const centerYInput = elements.centerY || null;
  const centerZInput = elements.centerZ || null;
  const rotationInput = elements.rotation || null;
  const scaleInput = elements.scale || null;
  const scaleXInput = elements.scaleX || null;
  const scaleZInput = elements.scaleZ || null;
  const flipXInput = elements.flipX || null;
  const saveTransformButton = elements.saveTransformButton || null;
  const resetTransformButton = elements.resetTransformButton || null;
  const toggleFloorPlanVisibleButton = elements.toggleFloorPlanVisibleButton || null;
  const stackBaseInput = elements.stackBaseInput || null;
  const stackHeightInput = elements.stackHeightInput || null;
  const stackBottomInput = elements.stackBottomInput || null;
  const stackTopInput = elements.stackTopInput || null;
  const addStackLevelButton = elements.addStackLevelButton || null;
  const updateStackLevelButton = elements.updateStackLevelButton || null;
  const usePlanYForStackButton = elements.usePlanYForStackButton || null;
  const toggleStackVisibleButton = elements.toggleStackVisibleButton || null;
  const saveStackAssetButton = elements.saveStackAssetButton || null;
  const clearStackAssetButton = elements.clearStackAssetButton || null;
  const gizmoMoveButton = elements.gizmoMoveButton || null;
  const gizmoScaleButton = elements.gizmoScaleButton || null;
  const gizmoRotateButton = elements.gizmoRotateButton || null;
  const scaleAllButton = elements.scaleAllButton || null;
  const scaleXButton = elements.scaleXButton || null;
  const scaleZButton = elements.scaleZButton || null;
  const editorSelectedEl = elements.editorSelectedEl || null;
  const vertexSelect = elements.vertexSelect || null;
  const vertexXInput = elements.vertexX || null;
  const vertexZInput = elements.vertexZ || null;
  const applyVertexButton = elements.applyVertexButton || null;
  const planEditorShell = editorPanel?.closest?.('.floor-plan-panel') || editorPanel;
  const planEditorObserver = planEditorShell && typeof MutationObserver !== 'undefined'
    ? new MutationObserver(() => syncPlanGizmo())
    : null;

  if (planEditorObserver) {
    planEditorObserver.observe(planEditorShell, { attributes: true, attributeFilter: ['class', 'style'] });
  }

  function setStatus(text) {
    if (statusEl) statusEl.textContent = text;
  }

  function formatNumber(value) {
    return Number.isFinite(value) ? String(round6(value)) : '';
  }

  function isPlanEditorVisible() {
    if (!planEditorShell) return true;
    const shellIsFloorPanel = planEditorShell.classList.contains('floor-plan-panel');
    return shellIsFloorPanel ? planEditorShell.classList.contains('active') : planEditorShell.classList.contains('active');
  }

  function displayedPoint([x, z], y = sceneY) {
    state.group.updateMatrixWorld(true);
    return new Vector3(x, y, z).applyMatrix4(state.group.matrixWorld);
  }

  function displayedCenter(room) {
    return displayedPoint([room.center.x, room.center.z], room.center.y);
  }

  function setPointerNdc(event) {
    const rect = renderer.domElement.getBoundingClientRect();
    state.ndc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    state.ndc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  }

  function capturePointer(pointerId) {
    try {
      renderer.domElement.setPointerCapture?.(pointerId);
    } catch {
      // Verification can use synthetic pointer ids that are not active browser pointers.
    }
  }

  function releasePointer(pointerId) {
    try {
      renderer.domElement.releasePointerCapture?.(pointerId);
    } catch {
      // Matching capture can fail for synthetic verification pointers.
    }
  }

  function applyFloorTransform() {
    const { centerX, centerY, centerZ, rotationDeg, scale, scaleX, scaleZ, flipX } = state.floorTransform;
    const moveToOrigin = new Matrix4().makeTranslation(-state.floorBaseCenter.x, 0, -state.floorBaseCenter.z);
    const scaleMatrix = new Matrix4().makeScale(scale * scaleX * (flipX ? -1 : 1), 1, scale * scaleZ);
    const rotationMatrix = new Matrix4().makeRotationY((rotationDeg * Math.PI) / 180);
    const moveToCenter = new Matrix4().makeTranslation(centerX, centerY, centerZ);
    state.group.matrix.identity();
    state.group.matrix.multiply(moveToCenter).multiply(rotationMatrix).multiply(scaleMatrix).multiply(moveToOrigin);
    state.group.updateMatrixWorld(true);
  }

  function getPlanBaseInverseMatrix() {
    const { centerX, centerY, centerZ, rotationDeg } = state.floorTransform;
    const moveToOrigin = new Matrix4().makeTranslation(-state.floorBaseCenter.x, 0, -state.floorBaseCenter.z);
    const rotationMatrix = new Matrix4().makeRotationY((rotationDeg * Math.PI) / 180);
    const moveToCenter = new Matrix4().makeTranslation(centerX, centerY, centerZ);
    const matrix = new Matrix4().identity().multiply(moveToCenter).multiply(rotationMatrix).multiply(moveToOrigin);
    return matrix.invert();
  }

  function planBaseLocalFromWorld(point) {
    return point.clone().applyMatrix4(getPlanBaseInverseMatrix());
  }

  function clearPlanGizmo() {
    state.planGizmoGroup.children.forEach((child) => {
      child.geometry?.dispose?.();
      child.material?.dispose?.();
    });
    state.planGizmoGroup.clear();
    state.planGizmoHandles = [];
  }

  function getFloorBounds() {
    const xs = [];
    const zs = [];
    state.rooms.forEach((room) => {
      room.cornersXz.forEach(([x, z]) => {
        xs.push(x);
        zs.push(z);
      });
    });
    if (!xs.length || !zs.length) {
      const { x, z } = state.floorBaseCenter;
      return { minX: x - 0.2, maxX: x + 0.2, minZ: z - 0.2, maxZ: z + 0.2 };
    }
    const pad = Math.max(0.08, Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs)) * 0.035);
    return {
      minX: Math.min(...xs) - pad,
      maxX: Math.max(...xs) + pad,
      minZ: Math.min(...zs) - pad,
      maxZ: Math.max(...zs) + pad,
    };
  }

  function syncPlanGizmo() {
    clearPlanGizmo();
    state.planGizmoGroup.visible = state.editorMode === 'plan' && state.rooms.size > 0 && isPlanEditorVisible();
    if (!state.planGizmoGroup.visible) return;

    const bounds = getFloorBounds();
    const corners = [
      [bounds.minX, bounds.minZ],
      [bounds.maxX, bounds.minZ],
      [bounds.maxX, bounds.maxZ],
      [bounds.minX, bounds.maxZ],
    ];

    corners.forEach((corner, idx) => {
      const next = corners[(idx + 1) % corners.length];
      state.planGizmoGroup.add(makePlanGizmoEdge(corner, next, sceneY));
    });

    if (state.planGizmoMode === 'scale') {
      const scaleHandles = state.planScaleMode === 'x'
        ? [
            { point: [bounds.minX, (bounds.minZ + bounds.maxZ) / 2], axis: 'x', index: 0 },
            { point: [bounds.maxX, (bounds.minZ + bounds.maxZ) / 2], axis: 'x', index: 1 },
          ]
        : state.planScaleMode === 'z'
          ? [
              { point: [(bounds.minX + bounds.maxX) / 2, bounds.minZ], axis: 'z', index: 0 },
              { point: [(bounds.minX + bounds.maxX) / 2, bounds.maxZ], axis: 'z', index: 1 },
            ]
          : corners.map((corner, idx) => ({ point: corner, axis: 'all', index: idx }));

      scaleHandles.forEach((handleSpec) => {
        const handle = makePlanGizmoHandle('scale', handleSpec.point, sceneY, handleSpec.index);
        handle.userData.planScaleAxis = handleSpec.axis;
        state.planGizmoHandles.push(handle);
        state.planGizmoGroup.add(handle);
      });
      return;
    }

    if (state.planGizmoMode === 'rotate') {
      const topCenter = [(bounds.minX + bounds.maxX) / 2, bounds.minZ - Math.max(0.12, bounds.maxZ - bounds.minZ) * 0.12];
      const handle = makePlanGizmoHandle('rotate', topCenter, sceneY, 0);
      handle.scale.set(1.35, 1.35, 1.35);
      state.planGizmoHandles.push(handle);
      state.planGizmoGroup.add(handle);
      return;
    }

    const handle = makePlanGizmoHandle(
      'move',
      [(bounds.minX + bounds.maxX) / 2, (bounds.minZ + bounds.maxZ) / 2],
      sceneY
    );
    handle.scale.set(1.25, 1.25, 1.25);
    state.planGizmoHandles.push(handle);
    state.planGizmoGroup.add(handle);

    const heightHandle = makePlanGizmoHandle(
      'height',
      [(bounds.minX + bounds.maxX) / 2, (bounds.minZ + bounds.maxZ) / 2],
      sceneY + 0.18
    );
    heightHandle.scale.set(1.12, 1.12, 1.12);
    state.planGizmoHandles.push(heightHandle);
    state.planGizmoGroup.add(heightHandle);
  }

  function clearVertexHandles() {
    state.vertexHandles.forEach((handle) => {
      handle.geometry?.dispose?.();
      handle.material?.dispose?.();
    });
    state.vertexHandleGroup.clear();
    state.vertexHandles = [];
  }

  function syncVertexHandles() {
    clearVertexHandles();
    const room = state.selectedRoom;
    if (state.editorMode !== 'vertex' || !room) return;
    room.cornersXz.forEach((point, idx) => {
      const handle = makeVertexHandleMesh(room.unit, idx, point, sceneY, idx === state.selectedVertexIndex);
      state.vertexHandles.push(handle);
      state.vertexHandleGroup.add(handle);
    });
  }

  function syncPlanInputs() {
    if (centerXInput) centerXInput.value = formatNumber(state.floorTransform.centerX);
    if (centerYInput) centerYInput.value = formatNumber(state.floorTransform.centerY);
    if (centerZInput) centerZInput.value = formatNumber(state.floorTransform.centerZ);
    if (rotationInput) rotationInput.value = formatNumber(state.floorTransform.rotationDeg);
    if (scaleInput) scaleInput.value = formatNumber(state.floorTransform.scale);
    if (scaleXInput) scaleXInput.value = formatNumber(state.floorTransform.scaleX);
    if (scaleZInput) scaleZInput.value = formatNumber(state.floorTransform.scaleZ);
    if (flipXInput) flipXInput.checked = !!state.floorTransform.flipX;
  }

  function setFloorTransform(next = {}) {
    const centerX = Number.parseFloat(next.centerX);
    const centerY = Number.parseFloat(next.centerY);
    const centerZ = Number.parseFloat(next.centerZ);
    const rotationDeg = Number.parseFloat(next.rotationDeg);
    const scale = Number.parseFloat(next.scale);
    const scaleX = Number.parseFloat(next.scaleX);
    const scaleZ = Number.parseFloat(next.scaleZ);
    if (Number.isFinite(centerX)) state.floorTransform.centerX = round6(centerX);
    if (Number.isFinite(centerY)) state.floorTransform.centerY = round6(Math.max(-5, Math.min(5, centerY)));
    if (Number.isFinite(centerZ)) state.floorTransform.centerZ = round6(centerZ);
    if (Number.isFinite(rotationDeg)) state.floorTransform.rotationDeg = normalizeDegrees(rotationDeg);
    if (Number.isFinite(scale)) state.floorTransform.scale = round6(Math.max(0.05, Math.min(20, scale)));
    if (Number.isFinite(scaleX)) state.floorTransform.scaleX = round6(Math.max(0.05, Math.min(20, scaleX)));
    if (Number.isFinite(scaleZ)) state.floorTransform.scaleZ = round6(Math.max(0.05, Math.min(20, scaleZ)));
    if (typeof next.flipX === 'boolean') {
      state.floorTransform.flipX = next.flipX;
    } else if (typeof next.flipX === 'string') {
      state.floorTransform.flipX = ['1', 'true', 'on', 'yes'].includes(next.flipX.toLowerCase());
    }
    applyFloorTransform();
    syncPlanInputs();
    return getFloorTransform();
  }

  function getFloorTransform() {
    return { ...state.floorTransform };
  }

  function syncFloorPlanVisibility() {
    state.rooms.forEach((room) => {
      room.group.visible = state.floorPlanVisible;
    });
    if (toggleFloorPlanVisibleButton) {
      toggleFloorPlanVisibleButton.textContent = state.floorPlanVisible ? 'Hide 2D floorplan' : 'Show 2D floorplan';
      toggleFloorPlanVisibleButton.classList.toggle('active', state.floorPlanVisible);
      toggleFloorPlanVisibleButton.setAttribute('aria-pressed', state.floorPlanVisible ? 'true' : 'false');
    }
  }

  function toggleFloorPlanVisibility() {
    state.floorPlanVisible = !state.floorPlanVisible;
    syncFloorPlanVisibility();
    setStatus(state.floorPlanVisible ? '2D floorplan visible' : '2D floorplan hidden');
    return state.floorPlanVisible;
  }

  function disposeStackGroup() {
    state.stackGroup.traverse((child) => {
      child.geometry?.dispose?.();
      child.material?.map?.dispose?.();
      child.material?.dispose?.();
      child.userData?.texture?.dispose?.();
      child.userData?.hoverTexture?.dispose?.();
    });
    state.stackGroup.clear();
  }

  function clearStackGizmo() {
    state.stackGizmoGroup.children.forEach((child) => {
      child.geometry?.dispose?.();
      child.material?.dispose?.();
    });
    state.stackGizmoGroup.clear();
    state.stackHeightHandle = null;
  }

  function polygonAverage(points) {
    return points.reduce(
      (acc, point) => {
        acc[0] += point[0] / points.length;
        acc[1] += point[1] / points.length;
        return acc;
      },
      [0, 0]
    );
  }

  function renderStackAsset(asset = state.stackAsset) {
    disposeStackGroup();
    state.stackAsset = {
      version: 1,
      property: 'canyon-vista',
      levels: Array.isArray(asset?.levels) ? asset.levels : [],
    };

    state.stackAsset.levels.forEach((level) => {
      const bottomY = Number(level.bottomY);
      const topY = Number(level.topY);
      if (!Number.isFinite(bottomY) || !Number.isFinite(topY)) return;
      (level.units || []).forEach((unit) => {
        const corners = unit.cornersXz || unit.corners_xz;
        if (!Array.isArray(corners) || corners.length < 3) return;
        const label = String(unit.unit);
        const mesh = makeStackCubeMesh(corners, bottomY, topY, label, level.base);
        if (state.selectedStackUnits.has(label)) {
          const focused = state.focusedStackUnit && state.selectedStackUnits.has(state.focusedStackUnit);
          const dimmed = focused && state.focusedStackUnit !== label;
          mesh.material.color.setHex(SELECTED_STACK_CUBE_COLOR);
          mesh.material.opacity = dimmed ? FOCUSED_STACK_SIBLING_OPACITY : state.selectedStackCubeOpacity;
          mesh.renderOrder = dimmed ? 1188 : 1190;
        }
        state.stackGroup.add(mesh);
        const [cx, cz] = polygonAverage(corners);
        const sprite = makeUnitLabelSprite(label);
        sprite.position.set(cx, topY + 0.018, cz);
        sprite.visible = state.selectedStackUnits.has(label);
        if (sprite.visible) {
          const focused = state.focusedStackUnit && state.selectedStackUnits.has(state.focusedStackUnit);
          const dimmed = focused && state.focusedStackUnit !== label;
          sprite.material.opacity = dimmed ? FOCUSED_STACK_SIBLING_LABEL_OPACITY : 1;
          sprite.renderOrder = dimmed ? 1390 : 1400;
        }
        sprite.userData.unitNumber = label;
        state.stackGroup.add(sprite);
      });
    });
    syncStackVisibility();
    syncStackHeightGizmo();
    renderStackSearchDropdown(false);
  }

  function getStackCubeObjects() {
    const cubes = [];
    state.stackGroup.traverse((child) => {
      if (child.isMesh && child.userData?.isFloorPlanCube) cubes.push(child);
    });
    return cubes;
  }

  function getStackSelectableObjects() {
    const objects = [];
    state.stackGroup.traverse((child) => {
      if (
        (child.isMesh && child.userData?.isFloorPlanCube)
        || (child.isSprite && child.userData?.isFloorPlanCubeLabel)
      ) {
        objects.push(child);
      }
    });
    return objects;
  }

  function syncStackSelection() {
    const hasFocusedUnit = state.focusedStackUnit && state.selectedStackUnits.has(state.focusedStackUnit);
    state.stackGroup.traverse((child) => {
      if (child.isMesh && child.userData?.isFloorPlanCube) {
        const unitNumber = String(child.userData.unitNumber);
        const selected = state.selectedStackUnits.has(unitNumber);
        const dimmed = selected && hasFocusedUnit && state.focusedStackUnit !== unitNumber;
        child.material.color.setHex(selected ? SELECTED_STACK_CUBE_COLOR : STACK_CUBE_COLOR);
        child.material.opacity = selected
          ? (dimmed ? FOCUSED_STACK_SIBLING_OPACITY : state.selectedStackCubeOpacity)
          : STACK_CUBE_OPACITY;
        child.renderOrder = selected ? (dimmed ? 1188 : 1190) : 1180;
      } else if (child.isSprite && child.userData?.isFloorPlanCubeLabel) {
        const unitNumber = String(child.userData.unitNumber);
        const selected = state.selectedStackUnits.has(unitNumber);
        const dimmed = selected && hasFocusedUnit && state.focusedStackUnit !== unitNumber;
        child.visible = selected;
        child.material.opacity = selected ? (dimmed ? FOCUSED_STACK_SIBLING_LABEL_OPACITY : 1) : 0;
        child.material.map = state.hoveredStackUnit === unitNumber
          ? child.userData.hoverTexture
          : child.userData.texture;
        child.material.needsUpdate = true;
        child.renderOrder = dimmed ? 1390 : 1400;
      }
    });
  }

  function setHoveredStackUnit(unitNumber = null) {
    const next = unitNumber == null ? null : String(unitNumber).trim();
    const valid = next && state.selectedStackUnits.has(next) ? next : null;
    if (state.hoveredStackUnit === valid) return state.hoveredStackUnit;
    state.hoveredStackUnit = valid;
    renderer.domElement.style.cursor = valid ? 'pointer' : '';
    syncStackSelection();
    return state.hoveredStackUnit;
  }

  function setFocusedStackUnit(unitNumber = null) {
    const next = unitNumber == null ? null : String(unitNumber).trim();
    state.focusedStackUnit = next && state.selectedStackUnits.has(next) ? next : null;
    syncStackSelection();
    return state.focusedStackUnit;
  }

  function setSelectedStackCubeOpacity(opacity) {
    const next = Number(opacity);
    if (!Number.isFinite(next)) return state.selectedStackCubeOpacity;
    state.selectedStackCubeOpacity = Math.min(0.95, Math.max(0.05, next));
    syncStackSelection();
    return state.selectedStackCubeOpacity;
  }

  function getStackVolumeForUnit(unitNumber) {
    const target = String(unitNumber);
    for (const level of state.stackAsset.levels || []) {
      const bottomY = Number(level.bottomY);
      const topY = Number(level.topY);
      if (!Number.isFinite(bottomY) || !Number.isFinite(topY)) continue;
      for (const unit of level.units || []) {
        const label = String(unit.unit);
        const corners = unit.cornersXz || unit.corners_xz;
        if (label === target && Array.isArray(corners) && corners.length >= 3) {
          return { unit: label, cornersXz: corners, bottomY, topY };
        }
      }
    }
    return null;
  }

  function getStackVolumeCenter(volume) {
    const corners = Array.isArray(volume?.cornersXz) ? volume.cornersXz : [];
    if (!corners.length) return null;
    const totals = corners.reduce((sum, corner) => {
      sum.x += Number(corner[0]) || 0;
      sum.z += Number(corner[1]) || 0;
      return sum;
    }, { x: 0, z: 0 });
    const bottomY = Number(volume.bottomY);
    const topY = Number(volume.topY);
    if (!Number.isFinite(bottomY) || !Number.isFinite(topY)) return null;
    return new Vector3(
      totals.x / corners.length,
      (bottomY + topY) / 2,
      totals.z / corners.length
    );
  }

  function getStackVolumePoints(volume) {
    const corners = Array.isArray(volume?.cornersXz) ? volume.cornersXz : [];
    const bottomY = Number(volume?.bottomY);
    const topY = Number(volume?.topY);
    if (!corners.length || !Number.isFinite(bottomY) || !Number.isFinite(topY)) return [];
    return corners.flatMap((corner) => {
      const x = Number(corner[0]);
      const z = Number(corner[1]);
      if (!Number.isFinite(x) || !Number.isFinite(z)) return [];
      return [new Vector3(x, bottomY, z), new Vector3(x, topY, z)];
    });
  }

  function getStackAssetBounds() {
    const points = (state.stackAsset.levels || [])
      .flatMap((level) => (level.units || []).flatMap((unit) => getStackVolumePoints({
        cornersXz: unit.cornersXz || unit.corners_xz,
        bottomY: level.bottomY,
        topY: level.topY,
      })));
    if (!points.length) return null;
    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    const zs = points.map((point) => point.z);
    return {
      minX: Math.min(...xs),
      maxX: Math.max(...xs),
      minY: Math.min(...ys),
      maxY: Math.max(...ys),
      minZ: Math.min(...zs),
      maxZ: Math.max(...zs),
    };
  }

  function getAllStackAssetPoints() {
    return (state.stackAsset.levels || [])
      .flatMap((level) => (level.units || []).flatMap((unit) => getStackVolumePoints({
        cornersXz: unit.cornersXz || unit.corners_xz,
        bottomY: level.bottomY,
        topY: level.topY,
      })));
  }

  function crossXz(origin, a, b) {
    return ((a.x - origin.x) * (b.z - origin.z)) - ((a.z - origin.z) * (b.x - origin.x));
  }

  function buildConvexHullXz(points) {
    const unique = Array.from(new Map(points
      .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.z))
      .map((point) => [`${round6(point.x)},${round6(point.z)}`, { x: point.x, z: point.z }])).values())
      .sort((a, b) => (a.x === b.x ? a.z - b.z : a.x - b.x));
    if (unique.length <= 2) return unique;
    const lower = [];
    unique.forEach((point) => {
      while (lower.length >= 2 && crossXz(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) lower.pop();
      lower.push(point);
    });
    const upper = [];
    for (let index = unique.length - 1; index >= 0; index -= 1) {
      const point = unique[index];
      while (upper.length >= 2 && crossXz(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) upper.pop();
      upper.push(point);
    }
    lower.pop();
    upper.pop();
    return lower.concat(upper);
  }

  function distanceToSegmentXz(point, a, b) {
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const lengthSq = (dx * dx) + (dz * dz);
    if (lengthSq < 0.000001) return Math.hypot(point.x - a.x, point.z - a.z);
    const t = Math.max(0, Math.min(1, (((point.x - a.x) * dx) + ((point.z - a.z) * dz)) / lengthSq));
    const projectedX = a.x + (t * dx);
    const projectedZ = a.z + (t * dz);
    return Math.hypot(point.x - projectedX, point.z - projectedZ);
  }

  function distanceToHullXz(point, hull) {
    if (!Array.isArray(hull) || !hull.length) return 0;
    if (hull.length === 1) return Math.hypot(point.x - hull[0].x, point.z - hull[0].z);
    return hull.reduce((minDistance, corner, index) => {
      const nextCorner = hull[(index + 1) % hull.length];
      return Math.min(minDistance, distanceToSegmentXz(point, corner, nextCorner));
    }, Infinity);
  }

  function getStackFrameForUnits(unitNumbers = []) {
    const selectedVolumes = (Array.isArray(unitNumbers) ? unitNumbers : [unitNumbers])
      .map((unitNumber) => String(unitNumber || '').trim())
      .filter(Boolean)
      .map((unitNumber) => getStackVolumeForUnit(unitNumber))
      .filter(Boolean);
    const centers = selectedVolumes.map(getStackVolumeCenter).filter(Boolean);
    if (!centers.length) return null;
    const center = centers.reduce((sum, point) => sum.add(point), new Vector3()).multiplyScalar(1 / centers.length);
    const points = selectedVolumes.flatMap(getStackVolumePoints);
    const radius = points.reduce((max, point) => Math.max(max, point.distanceTo(center)), 0);
    const assetPoints = getAllStackAssetPoints();
    const bounds = getStackAssetBounds();
    const assetCenter = bounds
      ? new Vector3(
        (bounds.minX + bounds.maxX) / 2,
        (bounds.minY + bounds.maxY) / 2,
        (bounds.minZ + bounds.maxZ) / 2
      )
      : new Vector3(0, center.y, 0);
    const radial = new Vector3(center.x - assetCenter.x, 0, center.z - assetCenter.z);
    const assetRadius = bounds
      ? Math.max(
        Math.hypot(bounds.maxX - assetCenter.x, bounds.maxZ - assetCenter.z),
        Math.hypot(bounds.minX - assetCenter.x, bounds.minZ - assetCenter.z),
        0.001
      )
      : 1;
    const normalizedRadialDistance = radial.length() / assetRadius;
    if (radial.lengthSq() < 0.0001) radial.set(0, 0, -1);
    radial.normalize();
    const hull = buildConvexHullXz(assetPoints);
    const hullDistanceNorm = distanceToHullXz({ x: center.x, z: center.z }, hull) / assetRadius;
    const centerHullDistanceNorms = centers.map((point) => distanceToHullXz({ x: point.x, z: point.z }, hull) / assetRadius);
    const interiorThreshold = 0.09;
    const strongInteriorThreshold = 0.15;
    const interiorCenterCount = centerHullDistanceNorms.filter((distance) => distance > interiorThreshold).length;
    const interiorShare = centerHullDistanceNorms.length ? interiorCenterCount / centerHullDistanceNorms.length : 0;
    const averageHullDistanceNorm = centerHullDistanceNorms.length
      ? centerHullDistanceNorms.reduce((sum, distance) => sum + distance, 0) / centerHullDistanceNorms.length
      : hullDistanceNorm;
    const interior = centers.length <= 3
      ? (hullDistanceNorm > interiorThreshold || averageHullDistanceNorm > interiorThreshold)
      : (interiorShare >= 0.58 || (hullDistanceNorm > strongInteriorThreshold && averageHullDistanceNorm > interiorThreshold));
    return {
      x: round6(center.x),
      y: round6(center.y),
      z: round6(center.z),
      count: centers.length,
      radius: round6(radius),
      assetCenter: {
        x: round6(assetCenter.x),
        y: round6(assetCenter.y),
        z: round6(assetCenter.z),
      },
      assetTopY: bounds ? round6(bounds.maxY) : round6(center.y),
      radialDirection: {
        x: round6(radial.x),
        z: round6(radial.z),
      },
      normalizedRadialDistance: round6(normalizedRadialDistance),
      hullDistance: round6(hullDistanceNorm * assetRadius),
      hullDistanceNorm: round6(hullDistanceNorm),
      interiorShare: round6(interiorShare),
      viewSide: interior ? 'interior' : 'exterior',
    };
  }

  function getSelectedStackFrame() {
    return getStackFrameForUnits(Array.from(state.selectedStackUnits));
  }

  function getSelectedStackCenter() {
    return getSelectedStackFrame();
  }

  function selectStackUnits(unitNumbers = [], { statusText = null } = {}) {
    const selected = new Set(
      (Array.isArray(unitNumbers) ? unitNumbers : [unitNumbers])
        .map((unitNumber) => String(unitNumber || '').trim())
        .filter(Boolean)
    );
    state.selectedStackUnits = selected;
    state.selectedStackUnit = selected.size === 1 ? Array.from(selected)[0] : null;
    state.focusedStackUnit = null;
    state.hoveredStackUnit = null;
    state.lastStackTap = null;
    syncStackSelection();
    if (stackSearchInput) stackSearchInput.value = state.selectedStackUnit || '';
    renderStackSearchDropdown(false);
    if (statusText) setStatus(statusText);
    else if (selected.size) setStatus(`Highlighted ${selected.size} 3D unit${selected.size === 1 ? '' : 's'}`);
    return selected.size;
  }

  function clearStackSelection({ statusText = 'Cleared 3D unit highlights' } = {}) {
    return selectStackUnits([], { statusText });
  }

  function selectStackUnit(unitNumber) {
    return selectStackUnits(unitNumber == null ? [] : [unitNumber], {
      statusText: unitNumber == null ? 'Cleared 3D unit highlights' : `Selected 3D unit ${unitNumber}`,
    }) > 0;
  }

  function getStackUnitNumbers() {
    return state.stackAsset.levels
      .flatMap((level) => level.units || [])
      .map((unit) => String(unit.unit))
      .filter(Boolean)
      .sort((a, b) => Number(a) - Number(b));
  }

  function renderStackSearchDropdown(open = true) {
    if (!stackSearchDropdown) return;
    const query = (stackSearchInput?.value || '').trim();
    const units = getStackUnitNumbers();
    const matches = (query ? units.filter((unit) => unit.includes(query)) : units).slice(0, 150);
    stackSearchDropdown.innerHTML = '';
    matches.forEach((unit) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'stack-unit-option';
      button.textContent = unit;
      button.setAttribute('role', 'option');
      button.classList.toggle('active', state.selectedStackUnits.has(unit));
      button.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        selectStackUnit(unit);
      });
      stackSearchDropdown.appendChild(button);
    });
    stackSearchDropdown.classList.toggle('active', !!open && matches.length > 0);
  }

  function selectStackSearchValue() {
    const value = (stackSearchInput?.value || '').trim();
    if (!value) return false;
    const units = getStackUnitNumbers();
    const exact = units.find((unit) => unit === value);
    const partial = units.find((unit) => unit.includes(value));
    const selected = exact || partial;
    if (!selected) {
      setStatus(`3D unit ${value} not found`);
      renderStackSearchDropdown(true);
      return false;
    }
    selectStackUnit(selected);
    return true;
  }

  function syncStackVisibility() {
    state.stackGroup.visible = state.stackVisible;
    state.stackGizmoGroup.visible = state.stackVisible;
    if (toggleStackVisibleButton) {
      toggleStackVisibleButton.textContent = state.stackVisible ? 'Hide 3D asset' : 'Show 3D asset';
      toggleStackVisibleButton.classList.toggle('active', state.stackVisible);
      toggleStackVisibleButton.setAttribute('aria-pressed', state.stackVisible ? 'true' : 'false');
    }
  }

  function toggleStackVisibility() {
    state.stackVisible = !state.stackVisible;
    syncStackVisibility();
    setStatus(state.stackVisible ? '3D asset visible' : '3D asset hidden');
    return state.stackVisible;
  }

  function nextStackBase() {
    const bases = new Set(state.stackAsset.levels.map((level) => Number(level.base)).filter(Number.isFinite));
    for (let base = 100; base <= 500; base += 100) {
      if (!bases.has(base)) return base;
    }
    return 500;
  }

  function getDisplayedFloorPlaneY() {
    return round6(displayedPoint([state.floorBaseCenter.x, state.floorBaseCenter.z], sceneY).y);
  }

  function findStackLevel(baseValue = stackBaseInput?.value) {
    const base = Number.parseInt(baseValue || '', 10);
    if (!Number.isFinite(base)) return null;
    return state.stackAsset.levels.find((level) => Number(level.base) === base) || null;
  }

  function sortedStackLevels() {
    return [...state.stackAsset.levels].sort((a, b) => Number(a.base) - Number(b.base));
  }

  function stackLevelCenter(level) {
    const firstUnit = level?.units?.[0];
    const corners = firstUnit?.cornersXz || firstUnit?.corners_xz;
    if (Array.isArray(corners) && corners.length) {
      return polygonAverage(corners);
    }
    return [state.floorTransform.centerX, state.floorTransform.centerZ];
  }

  function syncStackHeightGizmo() {
    clearStackGizmo();
    const level = findStackLevel();
    if (!level || !isPlanEditorVisible()) return;
    const [cx, cz] = stackLevelCenter(level);
    const handle = makePlanGizmoHandle('height', [cx, cz], Number(level.topY) - PLAN_GIZMO_Y_OFFSET, 0);
    handle.scale.set(1.35, 1.35, 1.35);
    handle.userData.isStackHeightHandle = true;
    handle.userData.stackBase = Number(level.base);
    state.stackHeightHandle = handle;
    state.stackGizmoGroup.add(handle);
  }

  function syncStackInputs(level = findStackLevel()) {
    if (!level) {
      const planY = getDisplayedFloorPlaneY();
      if (stackBottomInput) stackBottomInput.value = formatNumber(planY);
      if (stackTopInput && stackHeightInput) {
        const height = Number.parseFloat(stackHeightInput.value || '0.22');
        stackTopInput.value = formatNumber(planY + (Number.isFinite(height) ? height : 0.22));
      }
      return;
    }
    const bottom = Number(level.bottomY);
    const top = Number(level.topY);
    if (stackBottomInput) stackBottomInput.value = Number.isFinite(bottom) ? formatNumber(bottom) : '';
    if (stackTopInput) stackTopInput.value = Number.isFinite(top) ? formatNumber(top) : '';
    if (stackHeightInput && Number.isFinite(bottom) && Number.isFinite(top)) {
      stackHeightInput.value = formatNumber(top - bottom);
    }
  }

  function getDisplayedRoomCorners(room, y = sceneY) {
    return room.cornersXz.map((point) => {
      const displayed = displayedPoint(point, y);
      return [round6(displayed.x), round6(displayed.z)];
    });
  }

  function addStackLevelFromCurrentPlan() {
    const base = Number.parseInt(stackBaseInput?.value || String(nextStackBase()), 10);
    const height = Number.parseFloat(stackHeightInput?.value || '0.22');
    if (!Number.isFinite(base) || base < 100 || base > 500 || base % 100 !== 0) {
      setStatus('Use a level base of 100, 200, 300, 400, or 500');
      return null;
    }
    if (!Number.isFinite(height) || height <= 0) {
      setStatus('Enter a valid extrusion height');
      return null;
    }

    const existing = state.stackAsset.levels.findIndex((level) => Number(level.base) === base);
    const lowerLevels = state.stackAsset.levels
      .filter((level) => Number(level.base) < base && Number.isFinite(Number(level.topY)))
      .sort((a, b) => Number(b.base) - Number(a.base));
    const typedBottom = Number.parseFloat(stackBottomInput?.value || '');
    const bottomY = round6(
      lowerLevels[0]
        ? Number(lowerLevels[0].topY)
        : Number.isFinite(typedBottom)
          ? typedBottom
          : getDisplayedFloorPlaneY()
    );
    const topY = round6(bottomY + height);
    const units = Array.from(state.rooms.values())
      .sort((a, b) => a.unit - b.unit)
      .map((room) => ({
        unit: String(base + room.unit),
        sourceUnit: room.unit,
        cornersXz: getDisplayedRoomCorners(room, sceneY),
      }));

    const level = { base, bottomY, topY, height: round6(height), units };
    if (existing >= 0) state.stackAsset.levels.splice(existing, 1, level);
    else state.stackAsset.levels.push(level);
    state.stackAsset.levels.sort((a, b) => Number(a.base) - Number(b.base));
    renderStackAsset(state.stackAsset);
    if (stackBaseInput) stackBaseInput.value = String(nextStackBase());
    syncStackInputs();
    setStatus(`Extruded ${units.length} cubes for level ${base}`);
    return level;
  }

  function updateStackLevelHeight() {
    const level = findStackLevel();
    if (!level) {
      setStatus('Extrude or select a stack level first');
      return null;
    }
    const bottom = Number.parseFloat(stackBottomInput?.value || '');
    const topInput = Number.parseFloat(stackTopInput?.value || '');
    const heightInput = Number.parseFloat(stackHeightInput?.value || '');
    if (!Number.isFinite(bottom)) {
      setStatus('Enter a valid Bottom Y');
      return null;
    }
    const top = Number.isFinite(topInput)
      ? topInput
      : Number.isFinite(heightInput)
        ? bottom + heightInput
        : NaN;
    if (!Number.isFinite(top) || top <= bottom) {
      setStatus('Top Y must be above Bottom Y');
      return null;
    }
    level.bottomY = round6(bottom);
    level.topY = round6(top);
    level.height = round6(top - bottom);
    cascadeStackLevelsFrom(level.base);
    renderStackAsset(state.stackAsset);
    syncStackInputs(level);
    setStatus(`Updated level ${level.base} height`);
    return level;
  }

  function setSelectedStackBottomToPlan() {
    const planY = getDisplayedFloorPlaneY();
    const currentHeight = Number.parseFloat(stackHeightInput?.value || '');
    if (stackBottomInput) stackBottomInput.value = formatNumber(planY);
    if (stackTopInput) stackTopInput.value = formatNumber(planY + (Number.isFinite(currentHeight) ? currentHeight : 0.22));
    setStatus('Set stack bottom to current floor plan Y');
  }

  function cascadeStackLevelsFrom(base) {
    const levels = sortedStackLevels();
    const startIndex = levels.findIndex((level) => Number(level.base) === Number(base));
    if (startIndex < 0) return;
    for (let i = startIndex + 1; i < levels.length; i += 1) {
      const prev = levels[i - 1];
      const level = levels[i];
      const height = Number(level.height) || Math.max(0.001, Number(level.topY) - Number(level.bottomY)) || 0.22;
      level.bottomY = round6(Number(prev.topY));
      level.topY = round6(level.bottomY + height);
      level.height = round6(height);
    }
  }

  function setStackLevelTopFromGizmo(base, topY) {
    const level = findStackLevel(base);
    if (!level) return null;
    const bottom = Number(level.bottomY);
    const nextTop = round6(Math.max(bottom + 0.001, topY));
    level.topY = nextTop;
    level.height = round6(nextTop - bottom);
    cascadeStackLevelsFrom(level.base);
    renderStackAsset(state.stackAsset);
    syncStackInputs(level);
    setStatus(`Adjusted level ${level.base} top`);
    return level;
  }

  async function readRepoStackAsset() {
    try {
      const res = await fetch(stackAssetUrl, { cache: 'no-store' });
      if (!res.ok) return null;
      const parsed = await res.json();
      if (!parsed || typeof parsed !== 'object') return null;
      return parsed;
    } catch {
      return null;
    }
  }

  async function saveStackAsset() {
    try {
      const payload = {
        version: 1,
        property: 'canyon-vista',
        saved_at: new Date().toISOString(),
        levels: state.stackAsset.levels,
      };
      const res = await fetch(SAVE_STACK_ASSET_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setStatus('Saved 3D floorplan asset to repo');
      return true;
    } catch (error) {
      console.warn('room-kml-overlay: stack asset save failed', error);
      setStatus('3D asset save unavailable');
      return false;
    }
  }

  function clearStackAsset() {
    state.stackAsset = { version: 1, property: 'canyon-vista', levels: [] };
    state.selectedStackUnit = null;
    state.selectedStackUnits = new Set();
    state.focusedStackUnit = null;
    state.hoveredStackUnit = null;
    state.lastStackTap = null;
    renderer.domElement.style.cursor = '';
    if (stackSearchInput) stackSearchInput.value = '';
    disposeStackGroup();
    clearStackGizmo();
    syncStackVisibility();
    if (stackBaseInput) stackBaseInput.value = '100';
    syncStackInputs();
    renderStackSearchDropdown(false);
    setStatus('Cleared generated 3D stack');
  }

  function readSavedFloorTransform() {
    try {
      const raw = window.localStorage?.getItem(FLOOR_TRANSFORM_STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      return parsed;
    } catch {
      return null;
    }
  }

  async function readRepoFloorTransform() {
    try {
      const res = await fetch(repoTransformUrl, { cache: 'no-store' });
      if (!res.ok) return null;
      const parsed = await res.json();
      if (!parsed || typeof parsed !== 'object') return null;
      return parsed.transform && typeof parsed.transform === 'object' ? parsed.transform : parsed;
    } catch {
      return null;
    }
  }

  function saveFloorTransformToLocalStorage() {
    try {
      window.localStorage?.setItem(FLOOR_TRANSFORM_STORAGE_KEY, JSON.stringify(getFloorTransform()));
      return true;
    } catch (error) {
      console.warn('room-kml-overlay: failed to save floor transform', error);
      return false;
    }
  }

  async function saveFloorTransform() {
    const transform = getFloorTransform();
    saveFloorTransformToLocalStorage();

    try {
      const res = await fetch(SAVE_TRANSFORM_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          property: 'canyon-vista',
          saved_at: new Date().toISOString(),
          transform,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setStatus('Saved floor plan position to repo');
      return true;
    } catch (error) {
      console.warn('room-kml-overlay: repo save failed', error);
      setStatus('Saved in browser only; repo save unavailable');
      return false;
    }
  }

  function clearSavedFloorTransform() {
    try {
      window.localStorage?.removeItem(FLOOR_TRANSFORM_STORAGE_KEY);
    } catch {
      // localStorage can be blocked in privacy-restricted browser contexts.
    }
  }

  function resetFloorTransform() {
    state.floorTransform = {
      centerX: state.floorBaseCenter.x,
      centerY: 0,
      centerZ: state.floorBaseCenter.z,
      rotationDeg: DEFAULT_FLOOR_ROTATION_DEG,
      scale: 1,
      scaleX: 1,
      scaleZ: 1,
      flipX: DEFAULT_FLOOR_FLIP_X,
    };
    applyFloorTransform();
    syncPlanInputs();
    clearSavedFloorTransform();
    setStatus('Reset floor plan position');
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
    syncPlanGizmo();
    syncVertexHandles();
    if (state.editorMode === 'vertex' && state.selectedRoom) focusRoomTopDown(state.selectedRoom);
  }

  function setPlanGizmoMode(mode) {
    state.planGizmoMode = ['scale', 'rotate'].includes(mode) ? mode : 'move';
    if (gizmoMoveButton) {
      gizmoMoveButton.classList.toggle('active', state.planGizmoMode === 'move');
      gizmoMoveButton.setAttribute('aria-pressed', state.planGizmoMode === 'move' ? 'true' : 'false');
    }
    if (gizmoScaleButton) {
      gizmoScaleButton.classList.toggle('active', state.planGizmoMode === 'scale');
      gizmoScaleButton.setAttribute('aria-pressed', state.planGizmoMode === 'scale' ? 'true' : 'false');
    }
    if (gizmoRotateButton) {
      gizmoRotateButton.classList.toggle('active', state.planGizmoMode === 'rotate');
      gizmoRotateButton.setAttribute('aria-pressed', state.planGizmoMode === 'rotate' ? 'true' : 'false');
    }
    syncPlanGizmo();
    setStatus(
      state.planGizmoMode === 'scale'
        ? planScaleStatusText()
        : state.planGizmoMode === 'rotate'
          ? 'Rotate floor plan with pink handle'
          : 'Move floor plan with yellow X/Z handle or green Y handle'
    );
  }

  function planScaleStatusText() {
    if (state.planScaleMode === 'x') return 'Stretch floor plan width with side handles';
    if (state.planScaleMode === 'z') return 'Stretch floor plan depth with front/back handles';
    return 'Scale whole floor plan with corner handles';
  }

  function setPlanScaleMode(mode) {
    state.planScaleMode = ['x', 'z'].includes(mode) ? mode : 'all';
    if (scaleAllButton) {
      scaleAllButton.classList.toggle('active', state.planScaleMode === 'all');
      scaleAllButton.setAttribute('aria-pressed', state.planScaleMode === 'all' ? 'true' : 'false');
    }
    if (scaleXButton) {
      scaleXButton.classList.toggle('active', state.planScaleMode === 'x');
      scaleXButton.setAttribute('aria-pressed', state.planScaleMode === 'x' ? 'true' : 'false');
    }
    if (scaleZButton) {
      scaleZButton.classList.toggle('active', state.planScaleMode === 'z');
      scaleZButton.setAttribute('aria-pressed', state.planScaleMode === 'z' ? 'true' : 'false');
    }
    syncPlanGizmo();
    if (state.planGizmoMode === 'scale') setStatus(planScaleStatusText());
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
    syncVertexHandles();
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
    syncPlanGizmo();
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

  function focusRoomTopDown(room) {
    if (!room || !controls || !camera) return;
    const center = displayedCenter(room);
    const focusDistance = Math.min(2.2, Math.max(1.05, roomFootprintSize(room) * state.floorTransform.scale * 7.2));
    controls.target.set(center.x, center.y, center.z);
    camera.position.set(center.x + 0.002, sceneY + focusDistance, center.z + 0.002);
    controls.update();

    const rect = renderer.domElement.getBoundingClientRect();
    const desiredX = rect.width < 720 ? 0.82 : 0.58;
    const desiredNdc = new Vector2(desiredX * 2 - 1, -(0.55 * 2 - 1));
    state.raycaster.setFromCamera(desiredNdc, camera);
    if (state.raycaster.ray.intersectPlane(state.floorDragPlane, state.floorDragPoint)) {
      const offset = new Vector3().subVectors(center, state.floorDragPoint);
      controls.target.add(offset);
      camera.position.add(offset);
      controls.update();
    }
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
        if (state.editorMode === 'vertex') focusRoomTopDown(state.selectedRoom);
        else focusRoom(state.selectedRoom);
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

  function pickVertexHandle(event) {
    if (state.editorMode !== 'vertex' || !state.selectedRoom || !state.vertexHandles.length) return null;
    setPointerNdc(event);
    state.raycaster.setFromCamera(state.ndc, camera);
    const hits = state.raycaster.intersectObjects(state.vertexHandles, false);
    return hits[0]?.object || null;
  }

  function pickPlanGizmoHandle(event) {
    if (state.editorMode !== 'plan' || !state.planGizmoHandles.length) return null;
    setPointerNdc(event);
    state.raycaster.setFromCamera(state.ndc, camera);
    const hits = state.raycaster.intersectObjects(state.planGizmoHandles, false);
    return hits[0]?.object || null;
  }

  function pickStackHeightHandle(event) {
    if (!state.stackHeightHandle) return null;
    setPointerNdc(event);
    state.raycaster.setFromCamera(state.ndc, camera);
    const hits = state.raycaster.intersectObject(state.stackHeightHandle, false);
    return hits[0]?.object || null;
  }

  function beginStackHeightDrag(event) {
    const handle = pickStackHeightHandle(event);
    if (!handle) return false;
    const level = findStackLevel(handle.userData.stackBase);
    if (!level) return false;
    if (typeof pauseCameraAutomation === 'function') pauseCameraAutomation();
    state.drag = {
      type: 'stack-height',
      pointerId: event.pointerId,
      previousControlsEnabled: controls ? controls.enabled : undefined,
      stackBase: Number(level.base),
      startScreenY: event.clientY,
      startTopY: Number(level.topY),
    };
    if (controls) controls.enabled = false;
    capturePointer(event.pointerId);
    renderer.domElement.style.cursor = 'ns-resize';
    setStatus(`Dragging level ${level.base} top`);
    return true;
  }

  function moveStackHeightDrag(event) {
    if (!state.drag || state.drag.type !== 'stack-height') return false;
    const rect = renderer.domElement.getBoundingClientRect();
    const anchor = controls?.target || new Vector3();
    const pixelDelta = state.drag.startScreenY - event.clientY;
    const unitsPerPixel = Math.max(0.0008, camera.position.distanceTo(anchor) / Math.max(500, rect.height) * 0.72);
    setStackLevelTopFromGizmo(state.drag.stackBase, state.drag.startTopY + pixelDelta * unitsPerPixel);
    return true;
  }

  function endStackHeightDrag(event = {}) {
    if (!state.drag || state.drag.type !== 'stack-height') return false;
    if (controls && typeof state.drag.previousControlsEnabled === 'boolean') {
      controls.enabled = state.drag.previousControlsEnabled;
    }
    if (Number.isFinite(event.pointerId)) releasePointer(event.pointerId);
    state.drag = null;
    renderer.domElement.style.cursor = '';
    setStatus('Stack height adjusted');
    return true;
  }

  function beginPlanGizmoDrag(event) {
    const handle = pickPlanGizmoHandle(event);
    if (!handle) return false;
    setPointerNdc(event);
    state.raycaster.setFromCamera(state.ndc, camera);
    const handleKind = handle.userData.planGizmoKind;
    if (handleKind === 'height') {
      state.floorDragPoint.copy(handle.getWorldPosition(new Vector3()));
    } else if (!state.raycaster.ray.intersectPlane(state.floorDragPlane, state.floorDragPoint)) {
      return false;
    }
    if (typeof pauseCameraAutomation === 'function') pauseCameraAutomation();

    const scaleAxis = handle.userData.planScaleAxis || state.planScaleMode || 'all';
    const kind = handleKind === 'scale'
      ? `plan-scale-${scaleAxis}`
      : handleKind === 'rotate'
        ? 'plan-rotate'
        : handleKind === 'height'
          ? 'plan-height'
          : 'plan-move';
    const center = new Vector3(state.floorTransform.centerX, sceneY + state.floorTransform.centerY, state.floorTransform.centerZ);
    const startAngleRad = Math.atan2(state.floorDragPoint.z - center.z, state.floorDragPoint.x - center.x);
    const startLocal = planBaseLocalFromWorld(state.floorDragPoint);
    const startLocalDx = startLocal.x - state.floorBaseCenter.x;
    const startLocalDz = startLocal.z - state.floorBaseCenter.z;
    const startDistance = Math.hypot(state.floorDragPoint.x - center.x, state.floorDragPoint.z - center.z);
    state.drag = {
      type: kind,
      pointerId: event.pointerId,
      previousControlsEnabled: controls ? controls.enabled : undefined,
      startPoint: state.floorDragPoint.clone(),
      startScreenY: event.clientY,
      startCenter: { x: state.floorTransform.centerX, y: state.floorTransform.centerY, z: state.floorTransform.centerZ },
      startRotationDeg: state.floorTransform.rotationDeg,
      startScale: state.floorTransform.scale,
      startScaleX: state.floorTransform.scaleX,
      startScaleZ: state.floorTransform.scaleZ,
      scaleCenter: center,
      startDistance: Math.max(0.001, startDistance),
      startLocalDx,
      startLocalDz,
      startLocalDistance: Math.max(0.001, Math.hypot(startLocalDx, startLocalDz)),
    };
    if (controls) controls.enabled = false;
    capturePointer(event.pointerId);
    state.drag.startAngleRad = startAngleRad;
    renderer.domElement.style.cursor = kind === 'plan-height' ? 'ns-resize' : kind === 'plan-rotate' ? 'grab' : kind.startsWith('plan-scale') ? 'nesw-resize' : 'grabbing';
    setStatus(
      kind === 'plan-height'
        ? 'Moving floor plan up/down'
        : kind === 'plan-rotate'
          ? 'Rotating floor plan'
          : kind.startsWith('plan-scale')
            ? 'Scaling floor plan'
            : 'Moving floor plan'
    );
    return true;
  }

  function movePlanGizmoDrag(event) {
    if (!state.drag || !['plan-move', 'plan-height', 'plan-scale-all', 'plan-scale-x', 'plan-scale-z', 'plan-rotate'].includes(state.drag.type)) return false;

    if (state.drag.type === 'plan-height') {
      const rect = renderer.domElement.getBoundingClientRect();
      const pixelDelta = state.drag.startScreenY - event.clientY;
      const unitsPerPixel = Math.max(0.0008, camera.position.distanceTo(controls?.target || state.drag.scaleCenter) / Math.max(500, rect.height) * 0.72);
      setFloorTransform({ centerY: state.drag.startCenter.y + pixelDelta * unitsPerPixel });
      return true;
    }

    setPointerNdc(event);
    state.raycaster.setFromCamera(state.ndc, camera);
    state.floorDragPlane.set(new Vector3(0, 1, 0), -(sceneY + state.drag.startCenter.y));
    if (!state.raycaster.ray.intersectPlane(state.floorDragPlane, state.floorDragPoint)) return false;

    if (state.drag.type === 'plan-rotate') {
      const angleRad = Math.atan2(
        state.floorDragPoint.z - state.drag.scaleCenter.z,
        state.floorDragPoint.x - state.drag.scaleCenter.x
      );
      const deltaDeg = ((angleRad - state.drag.startAngleRad) * 180) / Math.PI;
      setFloorTransform({ rotationDeg: state.drag.startRotationDeg + deltaDeg });
      return true;
    }

    if (state.drag.type === 'plan-scale-all') {
      const currentLocal = planBaseLocalFromWorld(state.floorDragPoint);
      const distance = Math.hypot(
        currentLocal.x - state.floorBaseCenter.x,
        currentLocal.z - state.floorBaseCenter.z
      );
      const ratio = Math.max(0.05, distance / state.drag.startLocalDistance);
      setFloorTransform({ scale: state.drag.startScale * ratio });
      return true;
    }

    if (state.drag.type === 'plan-scale-x') {
      const currentLocal = planBaseLocalFromWorld(state.floorDragPoint);
      const currentDx = currentLocal.x - state.floorBaseCenter.x;
      const ratio = Math.max(0.05, Math.abs(currentDx) / Math.max(0.001, Math.abs(state.drag.startLocalDx)));
      setFloorTransform({ scaleX: state.drag.startScaleX * ratio });
      return true;
    }

    if (state.drag.type === 'plan-scale-z') {
      const currentLocal = planBaseLocalFromWorld(state.floorDragPoint);
      const currentDz = currentLocal.z - state.floorBaseCenter.z;
      const ratio = Math.max(0.05, Math.abs(currentDz) / Math.max(0.001, Math.abs(state.drag.startLocalDz)));
      setFloorTransform({ scaleZ: state.drag.startScaleZ * ratio });
      return true;
    }

    const dx = state.floorDragPoint.x - state.drag.startPoint.x;
    const dz = state.floorDragPoint.z - state.drag.startPoint.z;
    setFloorTransform({
      centerX: state.drag.startCenter.x + dx,
      centerZ: state.drag.startCenter.z + dz,
    });
    return true;
  }

  function endPlanGizmoDrag(event = {}) {
    if (!state.drag || !['plan-move', 'plan-height', 'plan-scale-all', 'plan-scale-x', 'plan-scale-z', 'plan-rotate'].includes(state.drag.type)) return false;
    if (controls && typeof state.drag.previousControlsEnabled === 'boolean') {
      controls.enabled = state.drag.previousControlsEnabled;
    }
    if (Number.isFinite(event.pointerId)) releasePointer(event.pointerId);
    state.drag = null;
    renderer.domElement.style.cursor = '';
    setStatus(
      state.planGizmoMode === 'scale'
        ? planScaleStatusText()
        : state.planGizmoMode === 'rotate'
          ? 'Rotate floor plan with pink handle'
          : 'Move floor plan with yellow X/Z handle or green Y handle'
    );
    return true;
  }

  function beginVertexDrag(event) {
    const handle = pickVertexHandle(event);
    if (!handle) return false;
    const room = state.rooms.get(handle.userData.roomUnit);
    const vertexIndex = handle.userData.vertexIndex;
    if (!room || !Number.isFinite(vertexIndex)) return false;
    if (typeof pauseCameraAutomation === 'function') pauseCameraAutomation();
    state.selectedVertexIndex = vertexIndex;
    syncVertexInputs();
    state.drag = {
      type: 'vertex',
      room,
      vertexIndex,
      pointerId: event.pointerId,
      previousControlsEnabled: controls ? controls.enabled : undefined,
    };
    if (controls) controls.enabled = false;
    capturePointer(event.pointerId);
    renderer.domElement.style.cursor = 'grabbing';
    setStatus(`Dragging vertex ${vertexIndex + 1}`);
    return true;
  }

  function moveVertexDrag(event) {
    if (!state.drag || state.drag.type !== 'vertex') return false;
    setPointerNdc(event);
    state.raycaster.setFromCamera(state.ndc, camera);
    if (!state.raycaster.ray.intersectPlane(state.floorDragPlane, state.floorDragPoint)) return false;
    state.group.updateMatrixWorld(true);
    state.groupInverseMatrix.copy(state.group.matrixWorld).invert();
    const localPoint = state.floorDragPoint.clone().applyMatrix4(state.groupInverseMatrix);
    const updated = updateRoomVertex(state.drag.room.unit, state.drag.vertexIndex, {
      x: localPoint.x,
      z: localPoint.z,
    });
    return !!updated;
  }

  function endVertexDrag(event = {}) {
    if (!state.drag || state.drag.type !== 'vertex') return false;
    if (controls && typeof state.drag.previousControlsEnabled === 'boolean') {
      controls.enabled = state.drag.previousControlsEnabled;
    }
    if (Number.isFinite(event.pointerId)) releasePointer(event.pointerId);
    state.drag = null;
    renderer.domElement.style.cursor = '';
    if (state.selectedRoom) setStatus(`Room ${state.selectedRoom.unit}`);
    return true;
  }

  function pointerEventForScreenPoint(point) {
    const rect = renderer.domElement.getBoundingClientRect();
    return {
      clientX: rect.left + point.x,
      clientY: rect.top + point.y,
      pointerId: 1,
    };
  }

  function beginVertexDragForVerification(unit, vertexIndex = 0) {
    if (!selectRoom(unit, { syncInput: true, focus: true })) return false;
    setEditorOpen(true);
    setEditorMode('vertex');
    state.selectedVertexIndex = Number.parseInt(String(vertexIndex), 10) || 0;
    syncVertexInputs();
    const handle = getVertexHandleScreenState(unit, state.selectedVertexIndex);
    if (!handle?.visible) return false;
    return beginVertexDrag(pointerEventForScreenPoint(handle.screen));
  }

  function moveVertexDragForVerification(deltaX = 0, deltaY = 0) {
    if (!state.drag) return null;
    const handle = getVertexHandleScreenState(state.drag.room.unit, state.drag.vertexIndex);
    if (!handle?.visible) return null;
    const moved = moveVertexDrag(pointerEventForScreenPoint({
      x: handle.screen.x + deltaX,
      y: handle.screen.y + deltaY,
    }));
    if (!moved) return null;
    return getRoomVertex(state.drag.room.unit, state.drag.vertexIndex);
  }

  function endVertexDragForVerification() {
    return endVertexDrag({ pointerId: state.drag?.pointerId });
  }

  function selectFromPointer(event) {
    if (!state.floorPlanVisible || !state.rooms.size) return false;
    setPointerNdc(event);
    state.raycaster.setFromCamera(state.ndc, camera);
    const hits = state.raycaster.intersectObjects(getRoomObjects(), false);
    if (!hits.length) return false;
    const unit = hits[0].object.userData.roomUnit;
    return selectRoom(unit, { syncInput: true, focus: false });
  }

  function detectSelectedStackUnitFromPointer(event) {
    if (!state.stackVisible || !state.stackAsset.levels.length) return null;
    const objects = getStackSelectableObjects();
    setPointerNdc(event);
    state.raycaster.setFromCamera(state.ndc, camera);
    const hits = objects.length ? state.raycaster.intersectObjects(objects, false) : [];
    const hit = hits.find((entry) => state.selectedStackUnits.has(String(entry.object.userData.unitNumber)));
    if (hit) {
      return {
        unit: String(hit.object.userData.unitNumber),
        source: hit.object.userData?.isFloorPlanCubeLabel ? 'label' : 'volume',
      };
    }
    return pickSelectedStackUnitFromScreen(event);
  }

  function selectStackCubeFromPointer(event) {
    const hit = detectSelectedStackUnitFromPointer(event);
    const unit = hit?.unit || null;
    if (!unit) {
      state.lastStackTap = null;
      return false;
    }
    if (event.pointerType === 'mouse') {
      state.lastStackTap = null;
      if (typeof onStackUnitClick === 'function') onStackUnitClick(unit);
      return true;
    }
    const now = performance.now();
    const x = Number(event.clientX);
    const y = Number(event.clientY);
    const previous = state.lastStackTap;
    state.lastStackTap = { unit, time: now, x, y };
    const isDoubleTap = previous
      && previous.unit === unit
      && now - previous.time <= STACK_UNIT_DOUBLE_TAP_MS
      && Math.hypot(x - previous.x, y - previous.y) <= STACK_UNIT_DOUBLE_TAP_PX;
    if (!isDoubleTap) return false;
    state.lastStackTap = null;
    if (typeof onStackUnitClick === 'function') onStackUnitClick(unit);
    return true;
  }

  function projectStackPoint(point, rect) {
    const projected = new Vector3(point.x, point.y, point.z).project(camera);
    return {
      x: (projected.x + 1) * 0.5 * rect.width,
      y: (1 - projected.y) * 0.5 * rect.height,
      z: projected.z,
      inDepth: projected.z > -1 && projected.z < 1,
    };
  }

  function getProjectedStackVolumeBounds(volume, rect) {
    const points = [];
    const corners = volume.cornersXz || [];
    corners.forEach((corner) => {
      const x = Number(corner[0]);
      const z = Number(corner[1]);
      if (!Number.isFinite(x) || !Number.isFinite(z)) return;
      points.push(projectStackPoint({ x, y: volume.bottomY, z }, rect));
      points.push(projectStackPoint({ x, y: volume.topY, z }, rect));
    });
    const visible = points.filter((point) => point.inDepth);
    if (!visible.length) return null;
    const xs = visible.map((point) => point.x);
    const ys = visible.map((point) => point.y);
    const [cx, cz] = polygonAverage(corners);
    const label = projectStackPoint({ x: cx, y: volume.topY + 0.018, z: cz }, rect);
    return {
      minX: Math.min(...xs),
      maxX: Math.max(...xs),
      minY: Math.min(...ys),
      maxY: Math.max(...ys),
      label,
    };
  }

  function pickSelectedStackUnitFromScreen(event) {
    if (!state.selectedStackUnits.size) return null;
    const rect = renderer.domElement.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    let best = null;
    state.selectedStackUnits.forEach((unitNumber) => {
      const volume = getStackVolumeForUnit(unitNumber);
      if (!volume) return;
      const bounds = getProjectedStackVolumeBounds(volume, rect);
      if (!bounds) return;
      const labelDx = Math.abs(x - bounds.label.x);
      const labelDy = Math.abs(y - bounds.label.y);
      const insideLabel = bounds.label.inDepth && labelDx <= 72 && labelDy <= 34;
      if (!insideLabel) return;
      const distance = Math.hypot(labelDx, labelDy);
      if (!best || distance < best.distance) best = { unit: unitNumber, source: 'label', distance };
    });
    return best ? { unit: best.unit, source: best.source } : null;
  }

  function getVertexHandleScreenState(unit, vertexIndex = 0) {
    const room = state.rooms.get(Number.parseInt(String(unit), 10));
    const idx = Number.parseInt(String(vertexIndex), 10);
    if (!room || !room.cornersXz[idx] || !camera || !renderer?.domElement) return null;
    camera.updateProjectionMatrix?.();
    camera.updateMatrixWorld?.(true);
    state.group.updateMatrixWorld(true);
    const rect = renderer.domElement.getBoundingClientRect();
    const world = displayedPoint(room.cornersXz[idx], sceneY + 0.038);
    const projected = world.clone().project(camera);
    const screen = {
      x: round6((projected.x + 1) * 0.5 * rect.width),
      y: round6((1 - projected.y) * 0.5 * rect.height),
      z: round6(projected.z),
    };
    return {
      unit: room.unit,
      vertexIndex: idx,
      visible: projected.z > -1 && projected.z < 1 && screen.x >= 0 && screen.x <= rect.width && screen.y >= 0 && screen.y <= rect.height,
      screen,
      viewport: {
        x: round6(rect.left + screen.x),
        y: round6(rect.top + screen.y),
      },
      vertex: clonePoint(room.cornersXz[idx]),
    };
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

  function getPlanGizmoHandleScreenStates() {
    if (!camera || !renderer?.domElement) return [];
    camera.updateProjectionMatrix?.();
    camera.updateMatrixWorld?.(true);
    state.group.updateMatrixWorld(true);
    const rect = renderer.domElement.getBoundingClientRect();
    return state.planGizmoHandles.map((handle) => {
      const world = handle.getWorldPosition(new Vector3());
      const projected = world.clone().project(camera);
      const screen = {
        x: round6((projected.x + 1) * 0.5 * rect.width),
        y: round6((1 - projected.y) * 0.5 * rect.height),
      };
      return {
        kind: handle.userData.planGizmoKind,
        axis: handle.userData.planScaleAxis || null,
        cornerIndex: handle.userData.cornerIndex,
        visible: handle.visible && state.planGizmoGroup.visible && projected.z > -1 && projected.z < 1,
        screen,
        viewport: {
          x: round6(rect.left + screen.x),
          y: round6(rect.top + screen.y),
        },
      };
    });
  }

  function handlePointerDown(event) {
    if (
      beginStackHeightDrag(event)
      || beginPlanGizmoDrag(event)
      || beginVertexDrag(event)
      || selectStackCubeFromPointer(event)
      || (state.editorOpen && selectFromPointer(event))
    ) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  function handlePointerMove(event) {
    if (!moveStackHeightDrag(event) && !movePlanGizmoDrag(event) && !moveVertexDrag(event)) {
      const hit = event.pointerType === 'mouse' ? detectSelectedStackUnitFromPointer(event) : null;
      setHoveredStackUnit(hit?.unit || null);
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  }

  function handlePointerUp(event) {
    if (!endStackHeightDrag(event) && !endPlanGizmoDrag(event) && !endVertexDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
  }

  if (panel) {
    ['pointerdown', 'click', 'touchstart'].forEach((eventName) => {
      panel.addEventListener(eventName, (event) => event.stopPropagation(), { passive: true });
    });
  }
  if (stackSearchPanel) {
    ['pointerdown', 'click', 'touchstart'].forEach((eventName) => {
      stackSearchPanel.addEventListener(eventName, (event) => event.stopPropagation(), { passive: true });
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
  if (gizmoMoveButton) gizmoMoveButton.addEventListener('click', () => setPlanGizmoMode('move'));
  if (gizmoScaleButton) gizmoScaleButton.addEventListener('click', () => setPlanGizmoMode('scale'));
  if (gizmoRotateButton) gizmoRotateButton.addEventListener('click', () => setPlanGizmoMode('rotate'));
  if (scaleAllButton) scaleAllButton.addEventListener('click', () => setPlanScaleMode('all'));
  if (scaleXButton) scaleXButton.addEventListener('click', () => setPlanScaleMode('x'));
  if (scaleZButton) scaleZButton.addEventListener('click', () => setPlanScaleMode('z'));

  function applyPlanInputs() {
    setFloorTransform({
      centerX: centerXInput?.value,
      centerY: centerYInput?.value,
      centerZ: centerZInput?.value,
      rotationDeg: rotationInput?.value,
      scale: scaleInput?.value,
      scaleX: scaleXInput?.value,
      scaleZ: scaleZInput?.value,
      flipX: flipXInput?.checked,
    });
  }

  [centerXInput, centerYInput, centerZInput, rotationInput, scaleInput, scaleXInput, scaleZInput].forEach((field) => {
    if (!field) return;
    field.addEventListener('input', applyPlanInputs);
    field.addEventListener('change', applyPlanInputs);
  });
  if (flipXInput) {
    flipXInput.addEventListener('change', applyPlanInputs);
  }
  if (saveTransformButton) saveTransformButton.addEventListener('click', saveFloorTransform);
  if (resetTransformButton) resetTransformButton.addEventListener('click', resetFloorTransform);
  if (toggleFloorPlanVisibleButton) toggleFloorPlanVisibleButton.addEventListener('click', toggleFloorPlanVisibility);
  if (addStackLevelButton) addStackLevelButton.addEventListener('click', addStackLevelFromCurrentPlan);
  if (updateStackLevelButton) updateStackLevelButton.addEventListener('click', updateStackLevelHeight);
  if (usePlanYForStackButton) usePlanYForStackButton.addEventListener('click', setSelectedStackBottomToPlan);
  if (toggleStackVisibleButton) toggleStackVisibleButton.addEventListener('click', toggleStackVisibility);
  if (saveStackAssetButton) saveStackAssetButton.addEventListener('click', saveStackAsset);
  if (clearStackAssetButton) clearStackAssetButton.addEventListener('click', clearStackAsset);
  if (stackBaseInput) {
    stackBaseInput.addEventListener('change', () => {
      syncStackInputs();
      syncStackHeightGizmo();
    });
  }
  if (stackHeightInput) {
    stackHeightInput.addEventListener('change', () => {
      const bottom = Number.parseFloat(stackBottomInput?.value || '');
      const height = Number.parseFloat(stackHeightInput.value || '');
      if (stackTopInput && Number.isFinite(bottom) && Number.isFinite(height)) {
        stackTopInput.value = formatNumber(bottom + height);
      }
    });
  }

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
  if (stackSearchInput) {
    stackSearchInput.addEventListener('focus', () => renderStackSearchDropdown(true));
    stackSearchInput.addEventListener('input', () => renderStackSearchDropdown(true));
    stackSearchInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        selectStackSearchValue();
      } else if (event.key === 'Escape') {
        renderStackSearchDropdown(false);
      }
    });
  }
  if (stackSearchClearButton) {
    stackSearchClearButton.addEventListener('click', () => {
      if (stackSearchInput) stackSearchInput.value = '';
      clearStackSelection();
    });
  }
  document.addEventListener('pointerdown', (event) => {
    if (!stackSearchPanel || !stackSearchDropdown?.classList.contains('active')) return;
    if (stackSearchPanel.contains(event.target)) return;
    renderStackSearchDropdown(false);
  });
  renderer.domElement.addEventListener('pointerdown', handlePointerDown, { passive: false, capture: true });
  renderer.domElement.addEventListener('pointermove', handlePointerMove, { passive: false, capture: true });
  renderer.domElement.addEventListener('pointerup', handlePointerUp, { passive: false, capture: true });
  renderer.domElement.addEventListener('pointercancel', handlePointerUp, { passive: false, capture: true });

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
    syncFloorPlanVisibility();
    state.floorBaseCenter = {
      x: round6((transform.scene.minX + transform.scene.maxX) / 2),
      z: round6((transform.scene.minZ + transform.scene.maxZ) / 2),
    };
    state.floorTransform = {
      centerX: state.floorBaseCenter.x,
      centerY: 0,
      centerZ: state.floorBaseCenter.z,
      rotationDeg: DEFAULT_FLOOR_ROTATION_DEG,
      scale: 1,
      scaleX: 1,
      scaleZ: 1,
      flipX: DEFAULT_FLOOR_FLIP_X,
    };
    const savedTransform = await readRepoFloorTransform() || readSavedFloorTransform();
    if (savedTransform) setFloorTransform(savedTransform);
    else applyFloorTransform();
    syncPlanInputs();
    setEditorMode('plan');
    syncVertexInputs();
    const stackAsset = await readRepoStackAsset();
    if (stackAsset) renderStackAsset(stackAsset);
    if (stackBaseInput) stackBaseInput.value = String(nextStackBase());
    syncStackInputs();
    document.documentElement.dataset.roomOverlayReady = 'true';
    setStatus(
      stackAsset
        ? `Loaded ${state.rooms.size} rooms and ${state.stackAsset.levels.length} 3D level(s)`
        : savedTransform
          ? `Loaded ${state.rooms.size} rooms with saved position`
          : `Loaded ${state.rooms.size} rooms`
    );
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
    getVertexHandleScreenState,
    beginVertexDragForVerification,
    moveVertexDragForVerification,
    endVertexDragForVerification,
    getFloorTransform,
    setFloorTransform,
    resetFloorTransform,
    saveFloorTransform,
    clearSavedFloorTransform,
    toggleFloorPlanVisibility,
    setFloorPlanVisible(visible) {
      state.floorPlanVisible = !!visible;
      syncFloorPlanVisibility();
      return state.floorPlanVisible;
    },
    getFloorPlanVisible() {
      return state.floorPlanVisible;
    },
    addStackLevelFromCurrentPlan,
    saveStackAsset,
    clearStackAsset,
    selectStackUnit,
    selectStackUnits,
    clearStackSelection,
    setFocusedStackUnit,
    toggleStackVisibility,
    setStackVisible(visible) {
      state.stackVisible = !!visible;
      syncStackVisibility();
      return state.stackVisible;
    },
    getStackVisible() {
      return state.stackVisible;
    },
    getSelectedStackUnit() {
      return state.selectedStackUnit;
    },
    getSelectedStackUnits() {
      return Array.from(state.selectedStackUnits).sort((a, b) => Number(a) - Number(b));
    },
    getFocusedStackUnit() {
      return state.focusedStackUnit;
    },
    getSelectedStackCenter,
    getSelectedStackFrame,
    getStackFrameForUnits,
    setSelectedStackCubeOpacity,
    getSelectedStackCubeOpacity() {
      return state.selectedStackCubeOpacity;
    },
    getStackAsset() {
      return JSON.parse(JSON.stringify(state.stackAsset));
    },
    getPlanGizmoMode() {
      return state.planGizmoMode;
    },
    setPlanGizmoMode,
    getPlanScaleMode() {
      return state.planScaleMode;
    },
    setPlanScaleMode,
    getPlanGizmoHandleScreenStates,
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
      renderer.domElement.removeEventListener('pointermove', handlePointerMove, { capture: true });
      renderer.domElement.removeEventListener('pointerup', handlePointerUp, { capture: true });
      renderer.domElement.removeEventListener('pointercancel', handlePointerUp, { capture: true });
      planEditorObserver?.disconnect();
      endPlanGizmoDrag();
      endVertexDrag();
      scene.remove(state.group);
      scene.remove(state.stackGroup);
      scene.remove(state.stackGizmoGroup);
      state.group.traverse((child) => {
        child.geometry?.dispose?.();
        child.material?.dispose?.();
      });
      disposeStackGroup();
      clearStackGizmo();
      state.rooms.clear();
    },
  };
  window.__roomKmlOverlay = api;
  return api;
}
