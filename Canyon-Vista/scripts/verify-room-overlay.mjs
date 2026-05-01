import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';

const require = createRequire(import.meta.url);

function loadPlaywright() {
  try {
    return require('playwright');
  } catch (firstError) {
    const fallback = `${process.env.HOME || ''}/node_modules/playwright`;
    if (existsSync(fallback)) return require(fallback);
    throw firstError;
  }
}

function assert(condition, message, context = {}) {
  if (condition) return;
  const error = new Error(message);
  error.context = context;
  throw error;
}

function seriousConsoleMessages(consoleMessages) {
  return consoleMessages.filter((line) =>
    /unit-kml-overlay failed|room-kml-overlay failed|Failed to load resource.*canyon-vista-units|TypeError|ReferenceError|SyntaxError/.test(line)
  );
}

async function verifySelectedRoom(page, unit, label) {
  const state = await page.evaluate((selectedUnit) => ({
    selected: window.__roomKmlOverlay.getSelectedRoom(),
    visual: window.__roomKmlOverlay.getRoomVisualState(selectedUnit),
    screen: window.__roomKmlOverlay.getRoomScreenState(selectedUnit),
    status: document.getElementById('roomLookupStatus').textContent,
    input: document.getElementById('roomSearchInput').value,
  }), unit);

  assert(state.selected === unit, `${label}: selected room mismatch`, state);
  assert(state.visual?.selected, `${label}: room is not marked selected`, state);
  assert(state.visual.lineColor === 'ffd047', `${label}: selected room line is not highlighted yellow`, state);
  assert(state.visual.fillColor === 'ffd047', `${label}: selected room fill is not highlighted yellow`, state);
  assert(state.visual.fillOpacity >= 0.3, `${label}: selected room fill opacity is too low`, state);
  assert(state.screen?.intersectsViewport, `${label}: selected room is not in the viewport`, state);
  assert((state.screen?.visiblePointCount || 0) >= 3, `${label}: selected room does not have enough visible projected vertices`, state);
  assert((state.screen?.bounds?.width || 0) > 2, `${label}: selected room projected width is too small`, state);
  assert((state.screen?.bounds?.height || 0) > 2, `${label}: selected room projected height is too small`, state);
  return state;
}

async function orbitSelectedRoom(page, unit, label, cameraMove) {
  const screen = await page.evaluate((move) =>
    window.__roomKmlOverlay.orbitSelectedRoomForVerification(move),
  cameraMove);
  assert(screen?.selected, `${label}: orbit moved the wrong selected room`, screen);
  assert(screen.intersectsViewport, `${label}: selected room is not visible after camera movement`, screen);
  return verifySelectedRoom(page, unit, label);
}

async function selectRoom(page, unit) {
  await page.fill('#roomSearchInput', String(unit));
  await page.waitForFunction((selectedUnit) =>
    window.__roomKmlOverlay.getSelectedRoom() === selectedUnit &&
    document.documentElement.dataset.selectedRoom === String(selectedUnit),
  unit, { timeout: 30000 });
}

async function verifyEditorControls(page) {
  await page.click('#unitEditorToggle');
  await page.waitForFunction(() =>
    document.getElementById('unitEditorPanel').classList.contains('active') &&
    document.getElementById('roomKmlEditorPanel').closest('#unitEditorPanel'),
  null, { timeout: 30000 });

  const originalTransform = await page.evaluate(() => window.__roomKmlOverlay.getFloorTransform());
  assert(originalTransform.rotationDeg === 0, 'editor: default plan rotation should be 0 for pancake-flipped overlay', originalTransform);
  assert(originalTransform.flipX === true, 'editor: default plan should use the pancake flip', originalTransform);
  const targetTransform = {
    centerX: Number((originalTransform.centerX + 0.025).toFixed(6)),
    centerZ: Number((originalTransform.centerZ - 0.018).toFixed(6)),
    rotationDeg: Number((originalTransform.rotationDeg + 3.5).toFixed(6)),
    scale: 1.04,
    flipX: false,
  };
  await page.fill('#roomKmlCenterX', String(targetTransform.centerX));
  await page.fill('#roomKmlCenterZ', String(targetTransform.centerZ));
  await page.fill('#roomKmlRotation', String(targetTransform.rotationDeg));
  await page.fill('#roomKmlScale', String(targetTransform.scale));
  await page.setChecked('#roomKmlFlipX', targetTransform.flipX);
  await page.waitForFunction((expected) => {
    const current = window.__roomKmlOverlay.getFloorTransform();
    return Math.abs(current.centerX - expected.centerX) < 0.00001 &&
      Math.abs(current.centerZ - expected.centerZ) < 0.00001 &&
      Math.abs(current.rotationDeg - expected.rotationDeg) < 0.00001 &&
      Math.abs(current.scale - expected.scale) < 0.00001 &&
      current.flipX === expected.flipX;
  }, targetTransform, { timeout: 30000 });

  await selectRoom(page, 23);
  // The editor uses transitions, and Playwright can occasionally deem the tab "not stable".
  // Force the click to avoid flaky timeouts during verification.
  await page.locator('#roomKmlVertexTab').click({ force: true, timeout: 30000 });
  await page.waitForFunction(() => document.getElementById('roomKmlVertexPane').classList.contains('active'), null, { timeout: 30000 });
  const originalVertex = await page.evaluate(() => window.__roomKmlOverlay.getRoomVertex(23, 0));
  const originalHandle = await page.evaluate(() => window.__roomKmlOverlay.getVertexHandleScreenState(23, 0));
  assert(originalHandle?.visible, 'editor: vertex handle should be visible for the selected room', originalHandle);
  const targetVertex = [Number((originalVertex[0] + 0.012).toFixed(6)), Number((originalVertex[1] - 0.01).toFixed(6))];
  await page.selectOption('#roomKmlVertexSelect', '0');
  await page.fill('#roomKmlVertexX', String(targetVertex[0]));
  await page.fill('#roomKmlVertexZ', String(targetVertex[1]));
  await page.waitForFunction((expected) => {
    const current = window.__roomKmlOverlay.getRoomVertex(23, 0);
    return Math.abs(current[0] - expected[0]) < 0.00001 && Math.abs(current[1] - expected[1]) < 0.00001;
  }, targetVertex, { timeout: 30000 });
  const editedHandle = await page.evaluate(() => window.__roomKmlOverlay.getVertexHandleScreenState(23, 0));
  assert(editedHandle?.visible, 'editor: vertex handle should stay visible after numeric edit', editedHandle);

  await page.mouse.move(editedHandle.viewport.x, editedHandle.viewport.y);
  await page.mouse.down();
  await page.mouse.move(editedHandle.viewport.x + 54, editedHandle.viewport.y - 36, { steps: 8 });
  await page.mouse.up();
  await page.waitForFunction((previous) => {
    const current = window.__roomKmlOverlay.getRoomVertex(23, 0);
    return Math.abs(current[0] - previous[0]) > 0.0001 || Math.abs(current[1] - previous[1]) > 0.0001;
  }, targetVertex, { timeout: 30000 });
  const draggedVertex = await page.evaluate(() => window.__roomKmlOverlay.getRoomVertex(23, 0));
  const draggedHandle = await page.evaluate(() => window.__roomKmlOverlay.getVertexHandleScreenState(23, 0));
  const dragFields = await page.evaluate(() => ({
    selectedVertex: document.getElementById('roomKmlVertexSelect').value,
    x: Number.parseFloat(document.getElementById('roomKmlVertexX').value),
    z: Number.parseFloat(document.getElementById('roomKmlVertexZ').value),
  }));
  assert(draggedHandle?.visible, 'editor: vertex handle should remain visible after drag', draggedHandle);
  assert(dragFields.selectedVertex === '0', 'editor: dragged vertex should remain selected', dragFields);
  assert(Math.abs(dragFields.x - draggedVertex[0]) < 0.00001 && Math.abs(dragFields.z - draggedVertex[1]) < 0.00001,
    'editor: drag should update numeric X/Z fields', { dragFields, draggedVertex });

  await page.evaluate(({ transform, vertex }) => {
    window.__roomKmlOverlay.updateRoomVertex(23, 0, { x: vertex[0], z: vertex[1] });
    window.__roomKmlOverlay.setFloorTransform(transform);
  }, { transform: originalTransform, vertex: originalVertex });
  await page.locator('#roomKmlPlanTab').click({ force: true, timeout: 30000 });
  await page.click('#unitEditorToggle');

  return {
    originalTransform,
    targetTransform,
    originalVertex,
    targetVertex,
    originalHandle,
    editedHandle,
    draggedVertex,
    draggedHandle,
    restoredTransform: await page.evaluate(() => window.__roomKmlOverlay.getFloorTransform()),
    restoredVertex: await page.evaluate(() => window.__roomKmlOverlay.getRoomVertex(23, 0)),
  };
}

async function run() {
  const { chromium } = loadPlaywright();
  const url = process.argv[2] || process.env.ROOM_OVERLAY_URL || 'http://127.0.0.1:4173/Canyon-Vista/index.html';
  const executablePath = process.env.CHROME_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const browser = await chromium.launch({
    headless: true,
    executablePath,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const consoleMessages = [];
  const pageErrors = [];
  page.on('console', (msg) => consoleMessages.push(`${msg.type()}: ${msg.text()}`));
  page.on('pageerror', (error) => pageErrors.push(error.message));

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    // Reduce flakiness from UI transitions/animations while verifying editor wiring.
    await page.addStyleTag({
      content: `
        * { transition: none !important; animation: none !important; }
        html { scroll-behavior: auto !important; }
      `,
    });
    await page.waitForSelector('#roomSearchInput', { timeout: 20000 });
    await page.waitForFunction(() =>
      window.__roomKmlOverlay &&
      document.documentElement.dataset.roomOverlayReady === 'true' &&
      window.__roomKmlOverlay.roomCount() === 87,
    null, { timeout: 60000 });

    const initial = await page.evaluate(() => ({
      count: window.__roomKmlOverlay.roomCount(),
      first: window.__roomKmlOverlay.getRoomUnits()[0],
      last: window.__roomKmlOverlay.getRoomUnits().slice(-1)[0],
      ready: document.documentElement.dataset.roomOverlayReady,
      status: document.getElementById('roomLookupStatus').textContent,
    }));
    assert(initial.count === 87 && initial.first === 1 && initial.last === 87, 'Room overlay did not load Unit 1 through Unit 87', initial);

    const editor = await verifyEditorControls(page);
    const checks = [];
    for (const unit of [23, 73, 1]) {
      await selectRoom(page, unit);
      checks.push({ label: `post-move-select-${unit}`, state: await verifySelectedRoom(page, unit, `post-move-select-${unit}`) });

      checks.push({
        label: `orbit-a-${unit}`,
        state: await orbitSelectedRoom(page, unit, `orbit-a-${unit}`, {
          azimuth: 0.65,
          elevationRatio: 0.62,
          distanceScale: 1.08,
        }),
      });
      await page.waitForTimeout(250);

      checks.push({
        label: `orbit-b-${unit}`,
        state: await orbitSelectedRoom(page, unit, `orbit-b-${unit}`, {
          azimuth: 2.15,
          elevationRatio: 0.78,
          distanceScale: 0.92,
        }),
      });
      await page.waitForTimeout(250);
    }

    await page.fill('#roomSearchInput', '999');
    await page.waitForFunction(() =>
      window.__roomKmlOverlay.getSelectedRoom() === null &&
      !document.documentElement.dataset.selectedRoom,
    null, { timeout: 30000 });
    const invalid = await page.evaluate(() => ({
      selected: window.__roomKmlOverlay.getSelectedRoom(),
      status: document.getElementById('roomLookupStatus').textContent,
      input: document.getElementById('roomSearchInput').value,
    }));
    assert(invalid.status === 'Room 999 not found', 'Invalid room status did not render correctly', invalid);

    const seriousErrors = pageErrors.concat(seriousConsoleMessages(consoleMessages));
    assert(seriousErrors.length === 0, 'Serious browser errors were reported', { seriousErrors });

    console.log(JSON.stringify({ url, initial, editor, checks, invalid, seriousErrors }, null, 2));
  } finally {
    await browser.close();
  }
}

run().catch((error) => {
  console.error(error.message);
  if (error.context) console.error(JSON.stringify(error.context, null, 2));
  process.exit(1);
});
