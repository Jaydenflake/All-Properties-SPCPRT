import {
  Box3,
  Color,
  Group,
  MathUtils,
  Mesh,
  MeshStandardMaterial,
  MeshBasicMaterial,
  Vector3
} from 'three';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';

const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/');
dracoLoader.setDecoderConfig({ type: 'js' });

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function ensureStyles() {
  if (document.getElementById('obj-home-editor-styles')) return;
  const style = document.createElement('style');
  style.id = 'obj-home-editor-styles';
  style.textContent = `
    .obj-home-toggle-btn {
      width: 44px;
      height: 44px;
      padding: 0;
      border-radius: 50%;
      border: 1px solid rgba(255,255,255,0.2);
      background: rgba(0,0,0,0.35);
      color: rgba(255,255,255,0.9);
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      transition: background 0.2s ease, border-color 0.2s ease;
    }
    .obj-home-toggle-btn:hover {
      background: rgba(255,255,255,0.1);
      border-color: rgba(255,255,255,0.35);
    }
    .obj-home-toggle-btn.active {
      background: rgba(191,40,27,0.45);
      border-color: rgba(191,40,27,0.5);
      color: #fff;
    }
    .obj-home-toggle-btn svg { width: 22px; height: 22px; }

    .obj-home-panel {
      position: absolute;
      right: 12px;
      top: 66px;
      width: 300px;
      max-width: min(300px, calc(100vw - 24px));
      max-height: calc(100vh - 78px);
      overflow-y: auto;
      z-index: 12;
      border-radius: 20px;
      background: rgba(32, 32, 32, 0.5);
      -webkit-backdrop-filter: blur(45px);
      backdrop-filter: blur(45px);
      color: rgba(255, 255, 255, 0.95);
      font-family: 'Helvetica Neue', Arial, sans-serif;
      padding: 14px 14px 12px;
      box-sizing: border-box;
      opacity: 0;
      transform: translateY(8px) scale(0.98);
      pointer-events: none;
      transition: opacity 0.2s ease, transform 0.2s ease;
      scrollbar-width: thin;
      scrollbar-color: rgba(255,255,255,0.25) transparent;
    }
    .obj-home-panel::-webkit-scrollbar { width: 5px; }
    .obj-home-panel::-webkit-scrollbar-track { background: transparent; }
    .obj-home-panel::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.25); border-radius: 3px; }
    .obj-home-panel.active {
      opacity: 1;
      transform: translateY(0) scale(1);
      pointer-events: auto;
    }
    .obj-home-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      margin-bottom: 6px;
    }
    .obj-home-title {
      font-size: 13px;
      font-weight: 600;
      letter-spacing: 0.2px;
    }
    .obj-home-close {
      width: 24px;
      min-width: 24px;
      height: 24px;
      border: 1px solid rgba(255, 255, 255, 0.2);
      border-radius: 12px;
      background: rgba(0, 0, 0, 0.3);
      color: rgba(255, 255, 255, 0.9);
      font: 500 14px/1 sans-serif;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      padding: 0;
    }
    .obj-home-status {
      font-size: 10px;
      color: rgba(255, 255, 255, 0.7);
      margin-bottom: 10px;
      line-height: 1.3;
      min-height: 26px;
    }
    .obj-home-section {
      border-top: 1px solid rgba(255,255,255,0.12);
      padding-top: 10px;
      margin-top: 10px;
    }
    .obj-home-section:first-of-type {
      border-top: 0;
      padding-top: 0;
      margin-top: 0;
    }
    .obj-home-row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 8px;
    }
    .obj-home-row:last-child { margin-bottom: 0; }
    .obj-home-row label {
      font-size: 11px;
      color: rgba(255,255,255,0.75);
      min-width: 92px;
    }
    .obj-home-row input[type="text"],
    .obj-home-row input[type="url"],
    .obj-home-row input[type="number"]{
      width: 100%;
      border: 1px solid rgba(255,255,255,0.18);
      border-radius: 10px;
      background: rgba(0,0,0,0.32);
      color: #fff;
      font: 500 12px/1 'Helvetica Neue', Arial, sans-serif;
      padding: 8px 8px;
      box-sizing: border-box;
      outline: none;
    }
    .obj-home-grid {
      display: grid;
      grid-template-columns: 1fr 1fr 1fr;
      gap: 8px;
    }
    .obj-home-field label {
      display: block;
      font-size: 11px;
      color: rgba(255,255,255,0.74);
      margin-bottom: 5px;
    }
    .obj-home-actions {
      margin-top: 10px;
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .obj-home-actions button {
      flex: 1;
      min-width: 90px;
      border: 1px solid rgba(255, 255, 255, 0.18);
      border-radius: 10px;
      background: rgba(0, 0, 0, 0.34);
      color: #fff;
      font: 600 12px/1 'Helvetica Neue', Arial, sans-serif;
      padding: 10px 10px;
      cursor: pointer;
    }
    .obj-home-actions button:hover {
      border-color: rgba(255, 255, 255, 0.38);
      background: rgba(191, 40, 27, 0.38);
    }
    .obj-home-actions button:disabled { opacity: 0.5; cursor: not-allowed; }
    .obj-home-actions .danger { color: #e85a4f; }

    .obj-home-inline {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      color: rgba(255,255,255,0.9);
      cursor: pointer;
      user-select: none;
    }
    .obj-home-inline input { width: 16px; height: 16px; cursor: pointer; }

    body.recording-mode .obj-home-panel { visibility: hidden !important; }
  `;
  document.head.appendChild(style);
}

function getOrCreateTopRightToolbarWrap() {
  return (
    document.getElementById('pathAnimationEditorTogglesWrap') ||
    document.getElementById('editorTogglesWrap') ||
    document.getElementById('wolfTopRightToolbarWrap') ||
    (() => {
      const wrap = document.createElement('div');
      wrap.id = 'objHomeTopRightToolbarWrap';
      wrap.style.position = 'absolute';
      wrap.style.top = '12px';
      wrap.style.right = '12px';
      wrap.style.zIndex = '12';
      wrap.style.display = 'flex';
      wrap.style.gap = '8px';
      wrap.style.alignItems = 'center';
      document.body.appendChild(wrap);
      return wrap;
    })()
  );
}

async function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Failed to read file.'));
    reader.onload = () => resolve(String(reader.result || ''));
    reader.readAsText(file);
  });
}

async function readFileAsArrayBuffer(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Failed to read file.'));
    reader.onload = () => resolve(reader.result);
    reader.readAsArrayBuffer(file);
  });
}

function isGlbFile(file) {
  return file && (file.name.toLowerCase().endsWith('.glb') || file.name.toLowerCase().endsWith('.gltf'));
}

function applyDefaultMaterial(object) {
  const material = new MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
  object.traverse((child) => {
    if (child instanceof Mesh) {
      child.material = material;
      child.castShadow = false;
      child.receiveShadow = false;
    }
  });
}

function convertToUnlitMaterials(object) {
  object.traverse((child) => {
    if (!(child instanceof Mesh)) return;
    const mats = Array.isArray(child.material) ? child.material : [child.material];
    const nextMats = mats.map((m) => {
      if (!m) return m;
      if (m.isMeshBasicMaterial) return m;
      const basic = new MeshBasicMaterial({ toneMapped: false });
      if (m.map) basic.map = m.map;
      if (m.color) basic.color.copy(m.color);
      if (m.transparent) basic.transparent = true;
      if (m.alphaMap) basic.alphaMap = m.alphaMap;
      if (m.alphaTest) basic.alphaTest = m.alphaTest;
      if (m.side != null) basic.side = m.side;
      if (m.opacity != null) basic.opacity = m.opacity;
      return basic;
    });
    child.material = Array.isArray(child.material) ? nextMats : nextMats[0];
  });
}

function applyBrightness(object, brightness) {
  if (!object) return;
  const c = clamp(brightness, 0, 3);
  object.traverse((child) => {
    if (!(child instanceof Mesh)) return;
    const mats = Array.isArray(child.material) ? child.material : [child.material];
    mats.forEach((m) => {
      if (!m) return;
      if (!m.__origColor) {
        m.__origColor = m.color ? m.color.clone() : new Color(1, 1, 1);
      }
      m.color.copy(m.__origColor).multiplyScalar(c);
    });
  });
}

function computeAndApplyRecenter(object, { center = true, groundToZero = true } = {}) {
  const box = new Box3().setFromObject(object);
  const size = new Vector3();
  const c = new Vector3();
  box.getSize(size);
  box.getCenter(c);
  if (center) {
    object.position.sub(c);
  }
  if (groundToZero) {
    const nextBox = new Box3().setFromObject(object);
    const minY = nextBox.min.y;
    if (Number.isFinite(minY)) object.position.y -= minY;
  }
}

export function initObjHomeEditor(options = {}) {
  const { scene, camera, controls, renderer, propertyLabel = 'property' } = options;
  if (!scene || !camera || !controls || !renderer?.domElement) {
    console.warn('obj-home-editor: scene, camera, controls, and renderer.domElement are required.');
    return {};
  }

  ensureStyles();
  const toolbarWrap = getOrCreateTopRightToolbarWrap();

  const state = {
    open: false,
    modelGroup: null,
    objSource: { type: 'none', obj: '', mtl: '', baseUrl: '' },
    recenter: { center: true, ground: true },
    transform: { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, s: 1 },
    gizmoEnabled: false,
    gizmoMode: 'translate',
    brightness: 1.0
  };

  const ui = {};

  const setStatus = (msg) => {
    if (ui.status) ui.status.textContent = msg || '';
  };

  const setOpen = (open) => {
    state.open = !!open;
    if (ui.toggle) ui.toggle.classList.toggle('active', state.open);
    if (ui.panel) ui.panel.classList.toggle('active', state.open);
  };

  const transformControls = new TransformControls(camera, renderer.domElement);
  transformControls.visible = false;
  transformControls.enabled = true;
  transformControls.setMode('translate');
  transformControls.addEventListener('dragging-changed', (event) => {
    controls.enabled = !event.value;
  });
  transformControls.addEventListener('objectChange', () => {
    if (!state.modelGroup) return;
    syncInputsFromObject();
  });
  scene.add(transformControls);

  function attachGizmoIfNeeded() {
    if (!state.modelGroup) {
      transformControls.detach();
      transformControls.visible = false;
      return;
    }
    if (!state.gizmoEnabled) {
      transformControls.detach();
      transformControls.visible = false;
      return;
    }
    transformControls.attach(state.modelGroup);
    transformControls.setMode(state.gizmoMode);
    transformControls.visible = true;
  }

  function removeModel() {
    if (!state.modelGroup) return;
    transformControls.detach();
    transformControls.visible = false;
    scene.remove(state.modelGroup);
    state.modelGroup = null;
    setStatus('Removed home model.');
    syncInputsFromObject();
  }

  function syncInputsFromObject() {
    const obj = state.modelGroup;
    if (!obj) {
      if (ui.posX) ui.posX.value = '';
      if (ui.posY) ui.posY.value = '';
      if (ui.posZ) ui.posZ.value = '';
      if (ui.rotX) ui.rotX.value = '';
      if (ui.rotY) ui.rotY.value = '';
      if (ui.rotZ) ui.rotZ.value = '';
      if (ui.scale) ui.scale.value = '';
      if (ui.removeBtn) ui.removeBtn.disabled = true;
      if (ui.copyBtn) ui.copyBtn.disabled = true;
      if (ui.resetBtn) ui.resetBtn.disabled = true;
      if (ui.gizmoToggle) ui.gizmoToggle.checked = false;
      state.gizmoEnabled = false;
      attachGizmoIfNeeded();
      return;
    }
    if (ui.posX) ui.posX.value = obj.position.x.toFixed(3);
    if (ui.posY) ui.posY.value = obj.position.y.toFixed(3);
    if (ui.posZ) ui.posZ.value = obj.position.z.toFixed(3);
    if (ui.rotX) ui.rotX.value = MathUtils.radToDeg(obj.rotation.x).toFixed(1);
    if (ui.rotY) ui.rotY.value = MathUtils.radToDeg(obj.rotation.y).toFixed(1);
    if (ui.rotZ) ui.rotZ.value = MathUtils.radToDeg(obj.rotation.z).toFixed(1);
    if (ui.scale) ui.scale.value = obj.scale.x.toFixed(3);
    if (ui.removeBtn) ui.removeBtn.disabled = false;
    if (ui.copyBtn) ui.copyBtn.disabled = false;
    if (ui.resetBtn) ui.resetBtn.disabled = false;
  }

  function applyInputsToObject() {
    const obj = state.modelGroup;
    if (!obj) return;
    const x = parseFloat(ui.posX?.value);
    const y = parseFloat(ui.posY?.value);
    const z = parseFloat(ui.posZ?.value);
    const rx = parseFloat(ui.rotX?.value);
    const ry = parseFloat(ui.rotY?.value);
    const rz = parseFloat(ui.rotZ?.value);
    const s = parseFloat(ui.scale?.value);

    if (Number.isFinite(x)) obj.position.x = x;
    if (Number.isFinite(y)) obj.position.y = y;
    if (Number.isFinite(z)) obj.position.z = z;
    if (Number.isFinite(rx)) obj.rotation.x = MathUtils.degToRad(rx);
    if (Number.isFinite(ry)) obj.rotation.y = MathUtils.degToRad(ry);
    if (Number.isFinite(rz)) obj.rotation.z = MathUtils.degToRad(rz);
    if (Number.isFinite(s)) {
      const ss = clamp(s, 0.001, 1000);
      obj.scale.setScalar(ss);
    }
    attachGizmoIfNeeded();
    setStatus('Applied transform.');
  }

  function resetTransform() {
    const obj = state.modelGroup;
    if (!obj) return;
    obj.position.set(0, 0, 0);
    obj.rotation.set(0, 0, 0);
    obj.scale.setScalar(1);
    attachGizmoIfNeeded();
    syncInputsFromObject();
    setStatus('Reset transform.');
  }

  async function loadFromGlbBuffer(arrayBuffer, sourceLabel) {
    removeModel();
    setStatus(`Loading GLB (${sourceLabel})…`);
    return new Promise((resolve) => {
      const loader = new GLTFLoader();
      loader.setDRACOLoader(dracoLoader);
      loader.parse(arrayBuffer, '', (gltf) => {
        const group = new Group();
        group.name = `home-model-${propertyLabel}`;
        group.add(gltf.scene || gltf.scenes[0]);
        convertToUnlitMaterials(group);
        applyBrightness(group, state.brightness);
        computeAndApplyRecenter(group, { center: state.recenter.center, groundToZero: state.recenter.ground });
        scene.add(group);
        state.modelGroup = group;
        state.objSource = { type: 'glb', obj: sourceLabel, mtl: '', baseUrl: '' };
        setStatus(`Loaded home model (${sourceLabel}). Use gizmo or fields to align.`);
        syncInputsFromObject();
        attachGizmoIfNeeded();
        resolve();
      }, (err) => {
        console.warn('GLTFLoader error:', err);
        setStatus('Failed to load GLB. Check console for details.');
        resolve();
      });
    });
  }

  async function loadFromTexts({ objText, mtlText, baseUrl, sourceLabel }) {
    removeModel();
    const group = new Group();
    group.name = `home-model-${propertyLabel}`;

    try {
      const objLoader = new OBJLoader();
      if (mtlText) {
        const mtlLoader = new MTLLoader();
        if (baseUrl) {
          mtlLoader.setPath(baseUrl);
          mtlLoader.setResourcePath(baseUrl);
        }
        const materialsCreator = mtlLoader.parse(mtlText, baseUrl || '');
        materialsCreator.preload();
        objLoader.setMaterials(materialsCreator);
      }
      const parsed = objLoader.parse(objText);
      group.add(parsed);

      let hasAnyMesh = false;
      let hasMaterialWithMap = false;
      group.traverse((child) => {
        if (child instanceof Mesh) {
          hasAnyMesh = true;
          const mats = Array.isArray(child.material) ? child.material : [child.material];
          if (mats.some((m) => m && m.map)) hasMaterialWithMap = true;
        }
      });
      if (!hasAnyMesh) {
        setStatus('Loaded OBJ, but it contains no mesh geometry.');
      }

      if (hasMaterialWithMap) {
        convertToUnlitMaterials(group);
      } else {
        applyDefaultMaterial(group);
      }
      applyBrightness(group, state.brightness);

      computeAndApplyRecenter(group, { center: state.recenter.center, groundToZero: state.recenter.ground });

      scene.add(group);
      state.modelGroup = group;
      state.objSource = { ...state.objSource, baseUrl: baseUrl || '' };
      setStatus(`Loaded home model (${sourceLabel}). Use gizmo or fields to align.`); // keep short
      syncInputsFromObject();
      attachGizmoIfNeeded();
    } catch (err) {
      console.warn(err);
      setStatus('Failed to load OBJ/MTL. Check console for details.');
      removeModel();
    }
  }

  async function loadFromUrls(objUrl, mtlUrl, baseUrl) {
    if (!objUrl) return;
    const lc = objUrl.toLowerCase();
    if (lc.endsWith('.glb') || lc.endsWith('.gltf')) {
      setStatus('Fetching GLB…');
      try {
        const resp = await fetch(objUrl);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const buffer = await resp.arrayBuffer();
        await loadFromGlbBuffer(buffer, objUrl.split('/').pop());
      } catch (err) {
        console.warn(err);
        setStatus('Failed to fetch GLB. Check the URL and CORS settings.');
      }
      return;
    }
    setStatus('Loading OBJ from URL…');
    const [objText, mtlText] = await Promise.all([
      fetch(objUrl).then((r) => r.text()),
      mtlUrl ? fetch(mtlUrl).then((r) => r.text()) : Promise.resolve('')
    ]);
    state.objSource = { type: 'url', obj: objUrl, mtl: mtlUrl || '', baseUrl: baseUrl || '' };
    await loadFromTexts({ objText, mtlText, baseUrl, sourceLabel: 'URL' });
  }

  async function loadFromFiles(objFile, mtlFile, baseUrl) {
    if (!objFile) return;
    if (isGlbFile(objFile)) {
      setStatus('Loading GLB from file…');
      const buffer = await readFileAsArrayBuffer(objFile);
      await loadFromGlbBuffer(buffer, objFile.name);
      return;
    }
    setStatus('Loading OBJ from file…');
    const [objText, mtlText] = await Promise.all([
      readFileAsText(objFile),
      mtlFile ? readFileAsText(mtlFile) : Promise.resolve('')
    ]);
    state.objSource = { type: 'file', obj: objFile.name, mtl: mtlFile ? mtlFile.name : '', baseUrl: baseUrl || '' };
    await loadFromTexts({ objText, mtlText, baseUrl, sourceLabel: 'file' });
  }

  function copyConfigJson() {
    const obj = state.modelGroup;
    if (!obj) return;
    const payload = {
      source: state.objSource,
      transform: {
        position: { x: +obj.position.x.toFixed(6), y: +obj.position.y.toFixed(6), z: +obj.position.z.toFixed(6) },
        rotationDeg: {
          x: +MathUtils.radToDeg(obj.rotation.x).toFixed(3),
          y: +MathUtils.radToDeg(obj.rotation.y).toFixed(3),
          z: +MathUtils.radToDeg(obj.rotation.z).toFixed(3)
        },
        scale: +obj.scale.x.toFixed(6)
      },
      recenter: { center: !!state.recenter.center, groundToZero: !!state.recenter.ground }
    };
    const text = JSON.stringify(payload, null, 2);
    navigator.clipboard.writeText(text).then(
      () => setStatus('Copied model config JSON.'),
      () => setStatus('Copy failed (clipboard permission).')
    );
    window.__homeModelConfig = payload;
  }

  // UI creation
  ui.toggle = document.createElement('button');
  ui.toggle.type = 'button';
  ui.toggle.className = 'obj-home-toggle-btn';
  ui.toggle.id = 'objHomeToggleBtn';
  ui.toggle.setAttribute('aria-label', 'Home model');
  ui.toggle.setAttribute('title', 'Import and place a home model');
  ui.toggle.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 10v11h14V10"/><path d="M9 21v-7h6v7"/></svg>';

  toolbarWrap.appendChild(ui.toggle);

  ui.panel = document.createElement('div');
  ui.panel.className = 'obj-home-panel';
  ui.panel.id = 'objHomePanel';
  ui.panel.innerHTML = `
    <div class="obj-home-header">
      <div class="obj-home-title">Home model</div>
      <button type="button" class="obj-home-close" aria-label="Close">×</button>
    </div>
    <div class="obj-home-status" id="objHomeStatus"></div>

    <div class="obj-home-section">
      <div class="obj-home-row" style="font-size:11px;color:rgba(255,255,255,0.55);margin-bottom:6px;">
        <label></label><span>✦ Recommended — single file with textures baked in</span>
      </div>
      <div class="obj-home-row">
        <label>GLB / GLTF</label>
        <input id="objHomeGlbFile" type="file" accept=".glb,.gltf">
      </div>
      <div class="obj-home-row">
        <label></label>
        <button id="objHomeLoadGlbBtn" type="button" style="width:100%">Load GLB</button>
      </div>
    </div>

    <div class="obj-home-section">
      <div class="obj-home-row" style="font-size:11px;color:rgba(255,255,255,0.55);margin-bottom:6px;">
        <label></label><span>OBJ + MTL (textures must be served over HTTP)</span>
      </div>
      <div class="obj-home-row">
        <label>Local OBJ</label>
        <input id="objHomeObjFile" type="file" accept=".obj,text/plain">
      </div>
      <div class="obj-home-row">
        <label>Local MTL</label>
        <input id="objHomeMtlFile" type="file" accept=".mtl,text/plain">
      </div>
      <div class="obj-home-row">
        <label>Texture base</label>
        <input id="objHomeBaseUrlFile" type="text" placeholder="./assets/home-textures/">
      </div>
      <div class="obj-home-row">
        <label></label>
        <button id="objHomeLoadFilesBtn" type="button" style="width:100%">Load OBJ files</button>
      </div>
    </div>

    <div class="obj-home-section">
      <div class="obj-home-row">
        <label>OBJ URL</label>
        <input id="objHomeObjUrl" type="url" placeholder="https://.../home.obj or .glb">
      </div>
      <div class="obj-home-row">
        <label>MTL URL</label>
        <input id="objHomeMtlUrl" type="url" placeholder="https://.../home.mtl (optional)">
      </div>
      <div class="obj-home-row">
        <label>Texture base</label>
        <input id="objHomeBaseUrl" type="text" placeholder="https://.../textures/ or ./assets/">
      </div>
      <div class="obj-home-row">
        <label></label>
        <button id="objHomeLoadUrlBtn" type="button" style="width:100%">Load URL</button>
      </div>
    </div>

    <div class="obj-home-section">
      <div class="obj-home-row">
        <label></label>
        <label class="obj-home-inline"><input id="objHomeRecenter" type="checkbox" checked>Recenter</label>
        <label class="obj-home-inline"><input id="objHomeGround" type="checkbox" checked>Ground to Y=0</label>
      </div>
      <div class="obj-home-row">
        <label></label>
        <label class="obj-home-inline"><input id="objHomeGizmo" type="checkbox">Gizmo</label>
        <button id="objHomeModeT" type="button">Move</button>
        <button id="objHomeModeR" type="button">Rotate</button>
        <button id="objHomeModeS" type="button">Scale</button>
      </div>
      <div class="obj-home-grid">
        <div class="obj-home-field">
          <label for="objHomePosX">Pos X</label>
          <input id="objHomePosX" type="number" step="0.001">
        </div>
        <div class="obj-home-field">
          <label for="objHomePosY">Pos Y</label>
          <input id="objHomePosY" type="number" step="0.001">
        </div>
        <div class="obj-home-field">
          <label for="objHomePosZ">Pos Z</label>
          <input id="objHomePosZ" type="number" step="0.001">
        </div>
        <div class="obj-home-field">
          <label for="objHomeRotX">Rot X°</label>
          <input id="objHomeRotX" type="number" step="1">
        </div>
        <div class="obj-home-field">
          <label for="objHomeRotY">Rot Y°</label>
          <input id="objHomeRotY" type="number" step="1">
        </div>
        <div class="obj-home-field">
          <label for="objHomeRotZ">Rot Z°</label>
          <input id="objHomeRotZ" type="number" step="1">
        </div>
        <div class="obj-home-field" style="grid-column: 1 / -1;">
          <label for="objHomeScale">Scale</label>
          <input id="objHomeScale" type="number" step="0.01" min="0.001">
        </div>
      </div>

      <div class="obj-home-row" style="margin-top:8px;align-items:center;">
        <label for="objHomeBrightness" style="min-width:68px;">Brightness</label>
        <input id="objHomeBrightness" type="range" min="0" max="3" step="0.05" value="1" style="flex:1;accent-color:#fff;">
        <span id="objHomeBrightnessVal" style="min-width:32px;text-align:right;font-size:11px;">1.0</span>
      </div>

      <div class="obj-home-actions">
        <button id="objHomeApplyBtn" type="button">Apply</button>
        <button id="objHomeResetBtn" type="button">Reset</button>
        <button id="objHomeCopyBtn" type="button">Copy JSON</button>
        <button id="objHomeRemoveBtn" type="button" class="danger">Remove</button>
      </div>
      <div class="obj-home-actions" style="margin-top:6px;">
        <button id="objHomeAlignBtn" type="button" style="flex:1 1 100%;background:rgba(34,139,34,0.35);border-color:rgba(34,139,34,0.5);">Align Model</button>
      </div>
    </div>
  `;
  document.body.appendChild(ui.panel);

  ui.status = ui.panel.querySelector('#objHomeStatus');

  // Inputs & buttons
  const glbFileEl = ui.panel.querySelector('#objHomeGlbFile');
  const loadGlbBtn = ui.panel.querySelector('#objHomeLoadGlbBtn');
  const objFileEl = ui.panel.querySelector('#objHomeObjFile');
  const mtlFileEl = ui.panel.querySelector('#objHomeMtlFile');
  const baseFileEl = ui.panel.querySelector('#objHomeBaseUrlFile');
  const loadFilesBtn = ui.panel.querySelector('#objHomeLoadFilesBtn');

  const objUrlEl = ui.panel.querySelector('#objHomeObjUrl');
  const mtlUrlEl = ui.panel.querySelector('#objHomeMtlUrl');
  const baseUrlEl = ui.panel.querySelector('#objHomeBaseUrl');
  const loadUrlBtn = ui.panel.querySelector('#objHomeLoadUrlBtn');

  const recenterEl = ui.panel.querySelector('#objHomeRecenter');
  const groundEl = ui.panel.querySelector('#objHomeGround');
  ui.gizmoToggle = ui.panel.querySelector('#objHomeGizmo');

  ui.posX = ui.panel.querySelector('#objHomePosX');
  ui.posY = ui.panel.querySelector('#objHomePosY');
  ui.posZ = ui.panel.querySelector('#objHomePosZ');
  ui.rotX = ui.panel.querySelector('#objHomeRotX');
  ui.rotY = ui.panel.querySelector('#objHomeRotY');
  ui.rotZ = ui.panel.querySelector('#objHomeRotZ');
  ui.scale = ui.panel.querySelector('#objHomeScale');

  const brightnessSlider = ui.panel.querySelector('#objHomeBrightness');
  const brightnessVal = ui.panel.querySelector('#objHomeBrightnessVal');

  ui.applyBtn = ui.panel.querySelector('#objHomeApplyBtn');
  ui.resetBtn = ui.panel.querySelector('#objHomeResetBtn');
  ui.copyBtn = ui.panel.querySelector('#objHomeCopyBtn');
  ui.removeBtn = ui.panel.querySelector('#objHomeRemoveBtn');

  const modeT = ui.panel.querySelector('#objHomeModeT');
  const modeR = ui.panel.querySelector('#objHomeModeR');
  const modeS = ui.panel.querySelector('#objHomeModeS');

  const closeBtn = ui.panel.querySelector('.obj-home-close');

  const updateModeButtons = () => {
    const is = (m) => state.gizmoMode === m;
    modeT.style.opacity = is('translate') ? '1' : '0.6';
    modeR.style.opacity = is('rotate') ? '1' : '0.6';
    modeS.style.opacity = is('scale') ? '1' : '0.6';
  };

  closeBtn.addEventListener('click', () => setOpen(false));
  ui.toggle.addEventListener('click', () => setOpen(!state.open));

  recenterEl.addEventListener('change', () => {
    state.recenter.center = recenterEl.checked;
  });
  groundEl.addEventListener('change', () => {
    state.recenter.ground = groundEl.checked;
  });

  ui.gizmoToggle.addEventListener('change', () => {
    state.gizmoEnabled = ui.gizmoToggle.checked;
    attachGizmoIfNeeded();
  });
  modeT.addEventListener('click', () => {
    state.gizmoMode = 'translate';
    updateModeButtons();
    attachGizmoIfNeeded();
  });
  modeR.addEventListener('click', () => {
    state.gizmoMode = 'rotate';
    updateModeButtons();
    attachGizmoIfNeeded();
  });
  modeS.addEventListener('click', () => {
    state.gizmoMode = 'scale';
    updateModeButtons();
    attachGizmoIfNeeded();
  });

  if (brightnessSlider) {
    brightnessSlider.addEventListener('input', () => {
      const val = parseFloat(brightnessSlider.value);
      state.brightness = Number.isFinite(val) ? val : 1;
      if (brightnessVal) brightnessVal.textContent = state.brightness.toFixed(1);
      applyBrightness(state.modelGroup, state.brightness);
    });
  }

  loadGlbBtn.addEventListener('click', async () => {
    const glbFile = glbFileEl.files && glbFileEl.files[0];
    if (!glbFile) {
      setStatus('Pick a GLB or GLTF file first.');
      return;
    }
    const buffer = await readFileAsArrayBuffer(glbFile);
    await loadFromGlbBuffer(buffer, glbFile.name);
  });

  loadFilesBtn.addEventListener('click', async () => {
    const objFile = objFileEl.files && objFileEl.files[0];
    const mtlFile = mtlFileEl.files && mtlFileEl.files[0];
    if (!objFile) {
      setStatus('Pick an OBJ file first.');
      return;
    }
    await loadFromFiles(objFile, mtlFile, baseFileEl.value.trim());
  });

  loadUrlBtn.addEventListener('click', async () => {
    const objUrl = objUrlEl.value.trim();
    const mtlUrl = mtlUrlEl.value.trim();
    if (!objUrl) {
      setStatus('Paste an OBJ URL first.');
      return;
    }
    await loadFromUrls(objUrl, mtlUrl || '', baseUrlEl.value.trim());
  });

  ui.applyBtn.addEventListener('click', applyInputsToObject);
  ui.resetBtn.addEventListener('click', resetTransform);
  ui.copyBtn.addEventListener('click', copyConfigJson);
  ui.removeBtn.addEventListener('click', () => {
    if (!state.modelGroup) return;
    if (!confirm('Remove the home model from the scene?')) return;
    removeModel();
  });

  const alignBtn = ui.panel.querySelector('#objHomeAlignBtn');
  alignBtn.addEventListener('click', () => {
    const obj = state.modelGroup;
    if (!obj) { setStatus('Load a model first.'); return; }
    obj.position.set(-0.144, -0.370, -0.395);
    obj.rotation.set(MathUtils.degToRad(-177.7), MathUtils.degToRad(-57), MathUtils.degToRad(-177.3));
    obj.scale.setScalar(0.008);
    syncInputsFromObject();
    attachGizmoIfNeeded();
    setStatus('Aligned model to saved coordinates.');
  });

  // Initial UI state
  updateModeButtons();
  setStatus('Load an OBJ (file or URL), then move/rotate/scale to align.');
  syncInputsFromObject();
  setOpen(false);

  // Expose for debugging
  window.__homeModel = {
    get object() {
      return state.modelGroup;
    },
    remove: removeModel,
    copyConfig: copyConfigJson
  };

  return {
    setOpen,
    removeModel,
    copyConfigJson,
    loadFromUrls,
    loadFromGlbBuffer,
    applyTransform(cfg) {
      const obj = state.modelGroup;
      if (!obj || !cfg) return;
      if (cfg.position) {
        if (Number.isFinite(cfg.position.x)) obj.position.x = cfg.position.x;
        if (Number.isFinite(cfg.position.y)) obj.position.y = cfg.position.y;
        if (Number.isFinite(cfg.position.z)) obj.position.z = cfg.position.z;
      }
      if (cfg.rotationDeg) {
        if (Number.isFinite(cfg.rotationDeg.x)) obj.rotation.x = MathUtils.degToRad(cfg.rotationDeg.x);
        if (Number.isFinite(cfg.rotationDeg.y)) obj.rotation.y = MathUtils.degToRad(cfg.rotationDeg.y);
        if (Number.isFinite(cfg.rotationDeg.z)) obj.rotation.z = MathUtils.degToRad(cfg.rotationDeg.z);
      }
      if (Number.isFinite(cfg.scale)) obj.scale.setScalar(cfg.scale);
      if (Number.isFinite(cfg.brightness)) {
        state.brightness = cfg.brightness;
        applyBrightness(obj, state.brightness);
      }
      syncInputsFromObject();
      attachGizmoIfNeeded();
    },
    getState() { return state; }
  };
}

