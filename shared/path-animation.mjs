/**
 * Shared path animation module for property index pages.
 * Provides: flight path (camera path) state, Catmull-Rom interpolation,
 * animation editor UI (checkpoints, play/pause, capture, overwrite, delete),
 * and recording to WebM.
 *
 * Usage:
 *   import { initPathAnimation } from './path-animation.mjs';
 *   const pa = initPathAnimation({ camera, controls, renderer, sceneOrigin, startPosition, menuContainer, initialPath, propertyLabel });
 *   // In your animate loop: pa.update(deltaSeconds);
 */

function vec3(x, y, z) {
  return { x: Number.isFinite(x) ? x : 0, y: Number.isFinite(y) ? y : 0, z: Number.isFinite(z) ? z : 0 };
}

function sanitizePathVector(raw, fallback) {
  return {
    x: Number.isFinite(raw?.x) ? raw.x : fallback.x,
    y: Number.isFinite(raw?.y) ? raw.y : fallback.y,
    z: Number.isFinite(raw?.z) ? raw.z : fallback.z
  };
}

function catmullRomScalar(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (
    (2 * p1) +
    (-p0 + p2) * t +
    (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
    (-p0 + 3 * p1 - 3 * p2 + p3) * t3
  );
}

function catmullRomVector(v0, v1, v2, v3, t, out) {
  out.x = catmullRomScalar(v0.x, v1.x, v2.x, v3.x, t);
  out.y = catmullRomScalar(v0.y, v1.y, v2.y, v3.y, t);
  out.z = catmullRomScalar(v0.z, v1.z, v2.z, v3.z, t);
  return out;
}

function clamp(value, minVal, maxVal) {
  return Math.min(Math.max(value, minVal), maxVal);
}

export function initPathAnimation(options = {}) {
  const {
    camera,
    controls,
    renderer,
    sceneOrigin = { x: 0, y: 0, z: 0 },
    startPosition = { x: 0, y: 0.2, z: 2.5 },
    menuContainer,
    initialPath = {},
    paths: pathsOption,
    propertyLabel = 'property'
  } = options;

  if (!camera || !controls || !renderer?.domElement) {
    console.warn('path-animation: camera, controls, and renderer.domElement are required.');
    return { update: () => {}, getState: () => ({ enabled: false, playing: false }) };
  }

  const sanitizeCheckpoint = (raw) => {
    const pos = sanitizePathVector(raw?.position, startPosition);
    const lookAt = sanitizePathVector(raw?.lookAt, sceneOrigin);
    const duration = Number.isFinite(raw?.duration) && raw.duration > 0.1 ? raw.duration : 5;
    const pauseAt = !!raw.pauseAt;
    const pauseDuration = Number.isFinite(raw.pauseDuration) && raw.pauseDuration >= 0 ? Math.min(60, raw.pauseDuration) : 1;
    return { position: pos, lookAt, duration, pauseAt, pauseDuration };
  };

  function createPathState(defaults) {
    const d = defaults && typeof defaults === 'object' ? defaults : {};
    return {
      enabled: !!d.enabled,
      loop: d.loop !== false,
      speed: Number.isFinite(d.speed) && d.speed > 0 ? d.speed : 1,
      checkpoints: Array.isArray(d.checkpoints) ? d.checkpoints.map(sanitizeCheckpoint) : [],
      playing: false,
      segmentIndex: 0,
      segmentElapsed: 0,
      lookAtOverrideAtStart: null,
      pausedAtCheckpoint: null,
      pauseElapsed: 0
    };
  }

  const storageKey = `path-anim:${propertyLabel}`;

  const isMultiPath = Array.isArray(pathsOption) && pathsOption.length > 0;
  const allPaths = isMultiPath
    ? pathsOption.map((p) => createPathState(p))
    : [createPathState(initialPath)];
  const pathLabels = isMultiPath
    ? pathsOption.map((p, i) => (p && p.label) || `Path ${i + 1}`)
    : [];
  let activePathIndex = 0;
  let pathState = allPaths[0];
  let currentSceneOrigin = { ...sceneOrigin };

  function loadSavedPaths() {
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (isMultiPath && Array.isArray(saved)) {
        saved.forEach((savedPath, i) => {
          if (i < allPaths.length && savedPath && Array.isArray(savedPath.checkpoints)) {
            allPaths[i].checkpoints = savedPath.checkpoints.map(sanitizeCheckpoint);
            if (Number.isFinite(savedPath.speed) && savedPath.speed > 0) allPaths[i].speed = savedPath.speed;
            if (savedPath.checkpoints.length >= 2) allPaths[i].enabled = true;
          }
        });
      } else if (!isMultiPath && saved && Array.isArray(saved.checkpoints)) {
        allPaths[0].checkpoints = saved.checkpoints.map(sanitizeCheckpoint);
        if (Number.isFinite(saved.speed) && saved.speed > 0) allPaths[0].speed = saved.speed;
        if (saved.checkpoints.length >= 2) allPaths[0].enabled = true;
      }
    } catch (e) {
      // Ignore corrupt storage
    }
  }

  function persistPaths() {
    try {
      const payload = isMultiPath
        ? allPaths.map((ps) => ({ checkpoints: ps.checkpoints, speed: ps.speed }))
        : { checkpoints: allPaths[0].checkpoints, speed: allPaths[0].speed };
      localStorage.setItem(storageKey, JSON.stringify(payload));
    } catch (e) {
      // Ignore storage errors (e.g. private browsing quota)
    }
  }

  loadSavedPaths();

  const tempPosition = vec3(0, 0, 0);
  const tempLookAt = vec3(0, 0, 0);

  function getPathSegmentCount() {
    const count = pathState.checkpoints.length;
    if (count < 2) return 0;
    return pathState.loop ? count : count - 1;
  }

  function getPathIndex(index) {
    const count = pathState.checkpoints.length;
    if (!count) return 0;
    if (pathState.loop) return ((index % count) + count) % count;
    return clamp(index, 0, count - 1);
  }

  function getPathCheckpoint(index) {
    return pathState.checkpoints[getPathIndex(index)];
  }

  function getPathDurationForSegment(segmentIndex) {
    const cp = getPathCheckpoint(segmentIndex);
    return cp ? Math.max(0.1, cp.duration || 5) : 5;
  }

  function applyPathCheckpoint(index) {
    const cp = getPathCheckpoint(index);
    if (!cp) return;
    camera.position.set(cp.position.x, cp.position.y, cp.position.z);
    controls.target.set(cp.lookAt.x, cp.lookAt.y, cp.lookAt.z);
    if (typeof camera.lookAt === 'function') camera.lookAt(controls.target);
    if (typeof controls.update === 'function') controls.update();
  }

  function applyPathPose(segmentIndex, progress) {
    const count = pathState.checkpoints.length;
    const segmentCount = getPathSegmentCount();
    if (!segmentCount || count < 2) return;
    const t = clamp(progress, 0, 1);
    const i1 = pathState.loop ? getPathIndex(segmentIndex) : clamp(segmentIndex, 0, count - 2);
    const i2 = pathState.loop ? getPathIndex(i1 + 1) : Math.min(i1 + 1, count - 1);
    const p0 = getPathCheckpoint(i1 - 1).position;
    const p1 = getPathCheckpoint(i1).position;
    const p2 = getPathCheckpoint(i2).position;
    const p3 = getPathCheckpoint(i2 + 1).position;
    const l0 = getPathCheckpoint(i1 - 1).lookAt;
    const l1 = getPathCheckpoint(i1).lookAt;
    const l2 = getPathCheckpoint(i2).lookAt;
    const l3 = getPathCheckpoint(i2 + 1).lookAt;
    catmullRomVector(p0, p1, p2, p3, t, tempPosition);
    catmullRomVector(l0, l1, l2, l3, t, tempLookAt);
    camera.position.set(tempPosition.x, tempPosition.y, tempPosition.z);
    if (pathState.lookAtOverrideAtStart && segmentIndex === 0 && t < 0.02) {
      controls.target.set(pathState.lookAtOverrideAtStart.x, pathState.lookAtOverrideAtStart.y, pathState.lookAtOverrideAtStart.z);
      if (t >= 0.015) pathState.lookAtOverrideAtStart = null;
    } else {
      controls.target.set(tempLookAt.x, tempLookAt.y, tempLookAt.z);
    }
    if (typeof camera.lookAt === 'function') camera.lookAt(controls.target);
  }

  function updatePathAnimation(deltaSeconds) {
    if (!pathState.enabled || !pathState.playing) return;
    const segmentCount = getPathSegmentCount();
    if (!segmentCount) {
      pathState.playing = false;
      syncUI();
      return;
    }

    if (pathState.pausedAtCheckpoint !== null) {
      const cp = pathState.checkpoints[pathState.pausedAtCheckpoint];
      const pauseDuration = cp && cp.pauseAt ? Math.max(0, cp.pauseDuration || 1) : 0;
      pathState.pauseElapsed += deltaSeconds * pathState.speed;
      if (pathState.pauseElapsed >= pauseDuration) {
        pathState.pausedAtCheckpoint = null;
        pathState.pauseElapsed = 0;
        if (pathState.loop) {
          pathState.segmentIndex = (pathState.segmentIndex + 1) % segmentCount;
          pathState.segmentElapsed = 0;
        } else {
          const lastSegment = segmentCount - 1;
          if (pathState.segmentIndex >= lastSegment) {
            pathState.playing = false;
            setStatus('End of path. Press Play to restart.');
            syncUI();
            return;
          }
          pathState.segmentIndex += 1;
          pathState.segmentElapsed = 0;
        }
      }
      syncUI();
      return;
    }

    let remaining = Math.max(0, deltaSeconds * pathState.speed);
    let endedPlayback = false;
    while (remaining > 0 && pathState.playing) {
      const duration = getPathDurationForSegment(pathState.segmentIndex);
      const segmentRemaining = Math.max(0, duration - pathState.segmentElapsed);
      if (remaining < segmentRemaining) {
        pathState.segmentElapsed += remaining;
        remaining = 0;
        break;
      }
      remaining -= segmentRemaining;
      pathState.segmentElapsed = duration;

      const arrivalCheckpointIndex = pathState.loop ? getPathIndex(pathState.segmentIndex + 1) : pathState.segmentIndex + 1;
      const arrivalCp = pathState.checkpoints[arrivalCheckpointIndex];
      if (arrivalCp && arrivalCp.pauseAt && (pathState.loop || arrivalCheckpointIndex < pathState.checkpoints.length)) {
        applyPathPose(pathState.segmentIndex, 1);
        pathState.pausedAtCheckpoint = arrivalCheckpointIndex;
        pathState.pauseElapsed = 0;
        remaining = 0;
        break;
      }

      if (pathState.loop) {
        pathState.segmentIndex = (pathState.segmentIndex + 1) % segmentCount;
        pathState.segmentElapsed = 0;
        continue;
      }
      const lastSegment = segmentCount - 1;
      if (pathState.segmentIndex >= lastSegment) {
        pathState.segmentElapsed = getPathDurationForSegment(pathState.segmentIndex);
        pathState.playing = false;
        endedPlayback = true;
        remaining = 0;
        break;
      }
      pathState.segmentIndex += 1;
      pathState.segmentElapsed = 0;
    }
    const duration = getPathDurationForSegment(pathState.segmentIndex);
    const progress = duration > 0 ? Math.min(pathState.segmentElapsed / duration, 1) : 1;
    applyPathPose(pathState.segmentIndex, progress);
    if (endedPlayback) setStatus('End of path. Press Play to restart.');
    syncUI();
  }

  function buildCheckpointFromCurrentView(duration = 5) {
    const d = Number.isFinite(duration) && duration > 0 ? duration : 5;
    return {
      position: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
      lookAt: { x: controls.target.x, y: controls.target.y, z: controls.target.z },
      duration: d,
      pauseAt: false,
      pauseDuration: 1
    };
  }

  function serializeSinglePath(ps) {
    const checkpoints = ps.checkpoints.map((cp) => ({
      position: { x: +cp.position.x.toFixed(6), y: +cp.position.y.toFixed(6), z: +cp.position.z.toFixed(6) },
      lookAt: { x: +cp.lookAt.x.toFixed(6), y: +cp.lookAt.y.toFixed(6), z: +cp.lookAt.z.toFixed(6) },
      duration: +Math.max(0.1, cp.duration || 5).toFixed(3),
      pauseAt: !!cp.pauseAt,
      pauseDuration: +Math.max(0, Math.min(60, cp.pauseDuration ?? 1)).toFixed(2)
    }));
    return {
      enabled: !!ps.enabled,
      loop: !!ps.loop,
      speed: +Math.max(0.1, ps.speed || 1).toFixed(3),
      checkpoints
    };
  }

  function getSerializedPayload() {
    if (isMultiPath) {
      return allPaths.map((ps, i) => ({
        label: pathLabels[i] || `Path ${i + 1}`,
        ...serializeSinglePath(ps)
      }));
    }
    return serializeSinglePath(pathState);
  }

  function goToAnimationStart(lookAtOverride) {
    if (!pathState.enabled || !pathState.checkpoints.length) return;
    if (pathState.checkpoints.length < 2) return;
    pathState.lookAtOverrideAtStart = lookAtOverride ? { ...lookAtOverride } : { ...currentSceneOrigin };
    pathState.segmentIndex = 0;
    pathState.segmentElapsed = 0;
    pathState.pausedAtCheckpoint = null;
    pathState.pauseElapsed = 0;
    editorState.selectedCheckpointIndex = 0;
    applyPathCheckpoint(0);
    pathState.playing = true;
    syncUI();
  }

  const recordFormats = [
    { id: 'desktop', label: 'Desktop', ratio: 'Current', width: 0, height: 0, iconW: 36, iconH: 22 },
    { id: 'square', label: 'Square', ratio: '1:1', width: 1080, height: 1080, iconW: 26, iconH: 26 },
    { id: 'vertical-feed', label: 'Vertical Feed', ratio: '4:5', width: 1080, height: 1350, iconW: 24, iconH: 30 },
    { id: 'full-vertical', label: 'Full Vertical', ratio: '9:16', width: 1080, height: 1920, iconW: 20, iconH: 34 }
  ];

  let activeCanvasFormat = null;

  function showFormatPicker(onSelect) {
    const overlay = document.createElement('div');
    overlay.className = 'record-format-overlay';
    overlay.innerHTML = `
      <div class="record-format-dialog">
        <div class="record-format-dialog-title">Recording Format</div>
        <div class="record-format-grid">
          ${recordFormats.map((f) => `
            <button type="button" class="record-format-btn" data-format-id="${f.id}">
              <div class="record-format-btn-icon" style="width:${f.iconW}px;height:${f.iconH}px;"></div>
              <div class="record-format-btn-label">${f.label}</div>
              <div class="record-format-btn-size">${f.ratio}${f.width ? ' ' + f.width + 'x' + f.height : ''}</div>
            </button>
          `).join('')}
        </div>
        <div class="record-format-duration-row">
          <label for="recordFormatDuration">Duration</label>
          <input id="recordFormatDuration" type="number" min="5" max="120" step="5" value="20">
          <span>seconds</span>
        </div>
        <button type="button" class="record-format-cancel">Cancel</button>
      </div>
    `;
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('active'));

    function dismiss() {
      overlay.classList.remove('active');
      setTimeout(() => { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); }, 200);
    }

    overlay.querySelector('.record-format-cancel').addEventListener('click', dismiss);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) dismiss(); });

    overlay.querySelectorAll('.record-format-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const formatId = btn.getAttribute('data-format-id');
        const format = recordFormats.find((f) => f.id === formatId);
        const durInput = overlay.querySelector('#recordFormatDuration');
        const durationSec = Math.max(5, Math.min(120, parseFloat(durInput.value) || 20));
        dismiss();
        if (format && typeof onSelect === 'function') {
          onSelect(format, durationSec * 1000);
        }
      });
    });
  }

  function showCanvasFormatPicker() {
    const overlay = document.createElement('div');
    overlay.className = 'record-format-overlay';
    const currentId = activeCanvasFormat ? activeCanvasFormat.id : 'desktop';
    overlay.innerHTML = `
      <div class="record-format-dialog">
        <div class="record-format-dialog-title">Canvas Format</div>
        <div class="record-format-grid">
          ${recordFormats.map((f) => `
            <button type="button" class="record-format-btn${f.id === currentId ? ' active-format' : ''}" data-format-id="${f.id}">
              <div class="record-format-btn-icon" style="width:${f.iconW}px;height:${f.iconH}px;"></div>
              <div class="record-format-btn-label">${f.label}</div>
              <div class="record-format-btn-size">${f.ratio}</div>
            </button>
          `).join('')}
        </div>
        <button type="button" class="record-format-cancel">Cancel</button>
      </div>
    `;
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('active'));

    function dismiss() {
      overlay.classList.remove('active');
      setTimeout(() => { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); }, 200);
    }

    overlay.querySelector('.record-format-cancel').addEventListener('click', dismiss);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) dismiss(); });

    overlay.querySelectorAll('.record-format-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const formatId = btn.getAttribute('data-format-id');
        const format = recordFormats.find((f) => f.id === formatId);
        dismiss();
        if (format) applyCanvasFormat(format);
      });
    });
  }

  function getCanvasFormatOffset() {
    if (!activeCanvasFormat) return { x: 0, y: 0 };
    const aspect = activeCanvasFormat.width / activeCanvasFormat.height;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let cw, ch;
    if (vw / vh > aspect) { ch = vh; cw = Math.round(vh * aspect); }
    else { cw = vw; ch = Math.round(vw / aspect); }
    return { x: (vw - cw) / 2, y: (vh - ch) / 2 };
  }

  function adjustUIForCanvasFormat() {
    if (!menuContainer || !activeCanvasFormat) return;
    const { x, y } = getCanvasFormatOffset();
    if (x === 0 && y === 0) return;
    const curBottom = parseFloat(menuContainer.style.bottom) || 0;
    const curLeft = parseFloat(menuContainer.style.left) || 0;
    menuContainer.style.bottom = (curBottom + y) + 'px';
    menuContainer.style.left = (curLeft + x) + 'px';
  }

  function applyCanvasFormat(format) {
    const canvas = renderer.domElement;
    if (!format || format.id === 'desktop') {
      activeCanvasFormat = null;
      canvas.style.position = '';
      canvas.style.left = '';
      canvas.style.top = '';
      canvas.style.transform = '';
      renderer.setSize(window.innerWidth, window.innerHeight);
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      document.body.classList.remove('canvas-format-active');
      window.dispatchEvent(new Event('resize'));
      return;
    }
    activeCanvasFormat = format;
    const aspect = format.width / format.height;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let w, h;
    if (vw / vh > aspect) {
      h = vh;
      w = Math.round(vh * aspect);
    } else {
      w = vw;
      h = Math.round(vw / aspect);
    }
    renderer.setSize(w, h);
    camera.aspect = aspect;
    camera.updateProjectionMatrix();
    canvas.style.position = 'absolute';
    canvas.style.left = '50%';
    canvas.style.top = '50%';
    canvas.style.transform = 'translate(-50%, -50%)';
    document.body.classList.add('canvas-format-active');
    requestAnimationFrame(() => adjustUIForCanvasFormat());
  }

  window.addEventListener('resize', () => {
    if (activeCanvasFormat) {
      applyCanvasFormat(activeCanvasFormat);
    }
  });

  function recordPathAnimation(opts = {}) {
    const { durationMs = 20000, fps = 30, formatWidth = 0, formatHeight = 0, formatLabel = '', onBefore, onAfter } = opts;
    if (typeof MediaRecorder === 'undefined') {
      console.warn('MediaRecorder is not supported.');
      return;
    }
    if (!pathState.checkpoints.length || pathState.checkpoints.length < 2) {
      console.warn('Path animation requires at least 2 checkpoints.');
      return;
    }
    if (typeof onBefore === 'function') onBefore();

    const canvas = renderer.domElement;
    const origWidth = canvas.width;
    const origHeight = canvas.height;
    const origStyleW = canvas.style.width;
    const origStyleH = canvas.style.height;
    const origAspect = camera.aspect;
    const origPixelRatio = renderer.getPixelRatio();
    const needsResize = formatWidth > 0 && formatHeight > 0;

    if (needsResize) {
      renderer.setPixelRatio(1);
      renderer.setSize(formatWidth, formatHeight);
      camera.aspect = formatWidth / formatHeight;
      camera.updateProjectionMatrix();
    }

    if (!pathState.enabled) pathState.enabled = true;
    goToAnimationStart();

    const stream = canvas.captureStream(fps);
    const types = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
    let mimeType = '';
    if (typeof MediaRecorder.isTypeSupported === 'function') {
      for (const t of types) {
        if (MediaRecorder.isTypeSupported(t)) { mimeType = t; break; }
      }
    }
    const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    const chunks = [];
    recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };

    function restoreSize() {
      if (needsResize) {
        renderer.setPixelRatio(origPixelRatio);
        renderer.setSize(origWidth / origPixelRatio, origHeight / origPixelRatio);
        canvas.style.width = origStyleW;
        canvas.style.height = origStyleH;
        camera.aspect = origAspect;
        camera.updateProjectionMatrix();
      }
    }

    recorder.onstop = () => {
      restoreSize();
      const blob = new Blob(chunks, { type: recorder.mimeType || 'video/webm' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const sec = Math.round(durationMs / 1000);
      const label = String(propertyLabel).replace(/\s+/g, '-');
      const fmtTag = formatLabel ? '-' + formatLabel : '';
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      a.href = url;
      a.download = `path-${label}${fmtTag}-${sec}s-${ts}.webm`;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 0);
      if (typeof onAfter === 'function') onAfter();
    };

    recorder.start();
    setTimeout(() => {
      recorder.stop();
      stream.getTracks().forEach((t) => t.stop());
      pathState.playing = false;
      syncUI();
    }, durationMs);
  }

  const editorState = { open: false, selectedCheckpointIndex: 0 };
  let statusEl, summaryEl, stripEl, captureBtn, playBtn, exportBtn, panelEl, toggleBtn, recordBtnEl;
  let durationInputEl, durationRowEl, speedSelectEl;
  let stopAtCheckboxEl, stopRowEl, pauseDurationInputEl, pauseDurationRowEl;

  function setStatus(msg) {
    if (statusEl) statusEl.textContent = msg || '';
  }

  function getTotalPathSeconds() {
    const c = pathState.checkpoints;
    if (!c.length) return 0;
    if (c.length === 1) return Math.max(0.1, c[0].duration || 5);
    const n = pathState.loop ? c.length : c.length - 1;
    let total = 0;
    for (let i = 0; i < n; i++) total += Math.max(0.1, c[i].duration || 5);
    for (let i = 0; i < c.length; i++) {
      if (c[i].pauseAt) total += Math.max(0, c[i].pauseDuration ?? 1);
    }
    return total;
  }

  function syncSelectedIndex() {
    const n = pathState.checkpoints.length;
    if (!n) { editorState.selectedCheckpointIndex = 0; return; }
    editorState.selectedCheckpointIndex = clamp(editorState.selectedCheckpointIndex, 0, n - 1);
  }

  function deleteCheckpointAtIndex(index) {
    if (index < 0 || index >= pathState.checkpoints.length) return;
    if (!confirm(`Delete checkpoint ${index + 1}?`)) return;
    pathState.playing = false;
    pathState.checkpoints.splice(index, 1);
    editorState.selectedCheckpointIndex = Math.min(editorState.selectedCheckpointIndex, Math.max(0, pathState.checkpoints.length - 1));
    setStatus(`Deleted checkpoint ${index + 1}.`);
    syncUI();
  }

  function overwriteCheckpointAtIndex(index) {
    if (index < 0 || index >= pathState.checkpoints.length) return;
    const existing = pathState.checkpoints[index];
    const dur = existing ? Math.max(0.1, existing.duration || 5) : 5;
    pathState.playing = false;
    const fresh = buildCheckpointFromCurrentView(dur);
    pathState.checkpoints[index] = {
      ...fresh,
      pauseAt: existing ? !!existing.pauseAt : false,
      pauseDuration: existing && Number.isFinite(existing.pauseDuration) ? Math.max(0, existing.pauseDuration) : 1
    };
    setStatus(`Overwrote checkpoint ${index + 1}.`);
    syncUI();
  }

  function renderCheckpointStrip() {
    if (!stripEl) return;
    stripEl.innerHTML = '';
    pathState.checkpoints.forEach((cp, index) => {
      const item = document.createElement('div');
      item.className = 'animation-checkpoint-item';
      const hover = document.createElement('div');
      hover.className = 'animation-checkpoint-hover-actions';
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'animation-checkpoint-delete-btn';
      delBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M10 11v6M14 11v6"/></svg>';
      delBtn.setAttribute('aria-label', `Delete checkpoint ${index + 1}`);
      const ovrBtn = document.createElement('button');
      ovrBtn.type = 'button';
      ovrBtn.className = 'animation-checkpoint-overwrite-btn';
      ovrBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>';
      ovrBtn.setAttribute('aria-label', `Overwrite checkpoint ${index + 1}`);
      hover.appendChild(delBtn);
      hover.appendChild(ovrBtn);
      const pill = document.createElement('div');
      pill.className = 'animation-checkpoint-pill';
      if (index === editorState.selectedCheckpointIndex) pill.classList.add('active');
      if (pathState.playing && index === getPathIndex(pathState.segmentIndex)) pill.classList.add('playing');
      if (cp.pauseAt) pill.classList.add('stop-at');
      pill.innerHTML = `<span class="animation-checkpoint-pill-label">${index + 1}</span>`;
      pill.setAttribute('role', 'button');
      pill.setAttribute('aria-label', `Go to checkpoint ${index + 1}`);
      pill.addEventListener('click', () => {
        editorState.selectedCheckpointIndex = index;
        pathState.playing = false;
        applyPathCheckpoint(index);
        if (typeof controls.update === 'function') controls.update();
        syncUI();
      });
      delBtn.addEventListener('click', (e) => { e.stopPropagation(); deleteCheckpointAtIndex(index); });
      ovrBtn.addEventListener('click', (e) => { e.stopPropagation(); overwriteCheckpointAtIndex(index); });
      item.appendChild(pill);
      item.appendChild(hover);
      stripEl.appendChild(item);
    });
  }

  function syncUI() {
    syncSelectedIndex();
    const labelEl = document.getElementById('pathAnimationActiveLabel');
    if (labelEl) {
      labelEl.textContent = isMultiPath ? ' — ' + (pathLabels[activePathIndex] || '') : '';
    }
    if (statusEl) {
      if (pathState.playing && pathState.checkpoints.length >= 2 && pathState.segmentIndex === 0) {
        setStatus('Playing from start.');
      } else if (pathState.playing) {
        setStatus('Playing.');
      } else if (pathState.checkpoints.length >= 2) {
        setStatus('Ready. Press Play.');
      } else if (pathState.checkpoints.length === 1) {
        setStatus('Add one more checkpoint to play.');
      } else {
        setStatus('Paused. Capture to add.');
      }
    }
    if (summaryEl) {
      const n = pathState.checkpoints.length;
      summaryEl.textContent = n ? `${n} • ${getTotalPathSeconds().toFixed(1)}s` : '0';
    }
    if (captureBtn) captureBtn.disabled = false;
    if (playBtn) {
      const playSvg = playBtn.querySelector('.icon-play');
      const pauseSvg = playBtn.querySelector('.icon-pause');
      if (playSvg) playSvg.style.display = pathState.playing ? 'none' : 'block';
      if (pauseSvg) pauseSvg.style.display = pathState.playing ? 'block' : 'none';
      playBtn.setAttribute('aria-label', pathState.playing ? 'Pause' : 'Play');
      playBtn.disabled = pathState.checkpoints.length < 2;
    }
    const deletePathBtn = document.getElementById('pathAnimationDeletePathBtn');
    if (deletePathBtn) deletePathBtn.disabled = pathState.checkpoints.length === 0;
    if (speedSelectEl) {
      const options = [0.25, 0.5, 1, 1.5, 2];
      const closest = options.reduce((a, b) => Math.abs(a - pathState.speed) < Math.abs(b - pathState.speed) ? a : b);
      const speedVal = String(closest);
      if (speedSelectEl.value !== speedVal) speedSelectEl.value = speedVal;
    }
    if (durationRowEl && durationInputEl) {
      const idx = editorState.selectedCheckpointIndex;
      const hasCheckpoints = pathState.checkpoints.length > 0;
      const cp = pathState.checkpoints[idx];
      if (hasCheckpoints && cp) {
        durationRowEl.style.display = '';
        const dur = Math.max(0.1, cp.duration || 5);
        if (String(durationInputEl.value) !== String(dur)) durationInputEl.value = dur.toFixed(1);
      } else {
        durationRowEl.style.display = 'none';
      }
    }
    if (stopRowEl && stopAtCheckboxEl) {
      const idx = editorState.selectedCheckpointIndex;
      const cp = pathState.checkpoints[idx];
      if (cp) {
        stopRowEl.style.display = '';
        stopAtCheckboxEl.checked = !!cp.pauseAt;
      } else {
        stopRowEl.style.display = 'none';
      }
    }
    if (pauseDurationRowEl && pauseDurationInputEl) {
      const idx = editorState.selectedCheckpointIndex;
      const cp = pathState.checkpoints[idx];
      if (cp) {
        pauseDurationRowEl.style.display = cp.pauseAt ? '' : 'none';
        const pd = Math.max(0, Math.min(60, cp.pauseDuration ?? 1));
        if (String(pauseDurationInputEl.value) !== String(pd)) pauseDurationInputEl.value = pd.toFixed(1);
      } else {
        pauseDurationRowEl.style.display = 'none';
      }
    }
    renderCheckpointStrip();
    if (typeof window.__cameraAnimationPath !== 'undefined') window.__cameraAnimationPath = getSerializedPayload();
    persistPaths();
  }

  function setPathEnabled(enabled) {
    pathState.enabled = !!enabled;
    if (!pathState.enabled) {
      pathState.playing = false;
      setStatus('Paused. Capture to add.');
    } else if (pathState.checkpoints.length > 1) {
      setStatus('Ready. Press Play.');
    } else {
      pathState.playing = false;
      setStatus('Add 2+ checkpoints to play.');
    }
    syncUI();
  }

  function captureCheckpoint() {
    pathState.playing = false;
    const idx = editorState.selectedCheckpointIndex;
    const selected = pathState.checkpoints[idx];
    const dur = selected ? Math.max(0.1, selected.duration || 5) : 5;
    const cp = buildCheckpointFromCurrentView(dur);
    const insertAt = pathState.checkpoints.length > 0 && idx >= 0 && idx < pathState.checkpoints.length ? idx + 1 : pathState.checkpoints.length;
    pathState.checkpoints.splice(insertAt, 0, cp);
    editorState.selectedCheckpointIndex = insertAt;
    setStatus(pathState.checkpoints.length === 1 ? 'Captured checkpoint 1.' : `Captured checkpoint ${insertAt + 1}.`);
    syncUI();
  }

  function goToSelectedCheckpoint() {
    if (!pathState.checkpoints.length) return;
    pathState.playing = false;
    pathState.segmentElapsed = 0;
    pathState.segmentIndex = editorState.selectedCheckpointIndex;
    applyPathCheckpoint(editorState.selectedCheckpointIndex);
    if (typeof controls.update === 'function') controls.update();
    syncUI();
  }

  function togglePlayback() {
    if (!pathState.enabled) setPathEnabled(true);
    if (pathState.checkpoints.length < 2) { pathState.playing = false; syncUI(); return; }
    pathState.playing = !pathState.playing;
    if (pathState.playing && pathState.segmentIndex === 0 && pathState.segmentElapsed === 0) {
      pathState.lookAtOverrideAtStart = { ...currentSceneOrigin };
    }
    setStatus(pathState.playing ? 'Playing.' : 'Paused.');
    syncUI();
  }

  function injectStyles() {
    if (document.getElementById('path-animation-styles')) return;
    const style = document.createElement('style');
    style.id = 'path-animation-styles';
    style.textContent = `
      .path-animation-editor-toggles-wrap { position: absolute; top: 12px; right: 12px; z-index: 12; display: flex; gap: 8px; align-items: center; }
      .path-animation-editor-toggle { width: 44px; height: 44px; padding: 0; border-radius: 50%; border: 1px solid rgba(255,255,255,0.2); background: rgba(0,0,0,0.35); color: rgba(255,255,255,0.9); cursor: pointer; display: inline-flex; align-items: center; justify-content: center; transition: background 0.2s ease, border-color 0.2s ease; }
      .path-animation-editor-toggle:hover { background: rgba(255,255,255,0.1); border-color: rgba(255,255,255,0.35); }
      .path-animation-editor-toggle.active { background: rgba(191,40,27,0.45); border-color: rgba(191,40,27,0.5); color: #fff; }
      .path-animation-editor-toggle svg { width: 22px; height: 22px; flex-shrink: 0; }
      .path-animation-editor-panel { position: absolute; right: 12px; top: 66px; width: 260px; max-width: min(260px, calc(100vw - 24px)); z-index: 12; border-radius: 20px; background: rgba(32,32,32,0.5); -webkit-backdrop-filter: blur(45px); backdrop-filter: blur(45px); color: rgba(255,255,255,0.95); font-family: 'Helvetica Neue',Arial,sans-serif; padding: 14px; box-sizing: border-box; opacity: 0; transform: translateY(8px) scale(0.98); pointer-events: none; transition: opacity 0.2s ease, transform 0.2s ease; }
      .path-animation-editor-panel.active { opacity: 1; transform: translateY(0) scale(1); pointer-events: auto; }
      .path-animation-editor-panel .path-animation-title { font-size: 13px; font-weight: 600; margin-bottom: 4px; }
      .path-animation-editor-panel .path-animation-status { font-size: 10px; color: rgba(255,255,255,0.7); margin-bottom: 4px; }
      .path-animation-editor-panel .path-animation-summary { font-size: 10px; color: rgba(255,255,255,0.6); margin-bottom: 6px; }
      .animation-checkpoint-strip { display: flex; gap: 4px; overflow-x: auto; margin: 0 0 6px; padding: 0 0 4px; scrollbar-width: thin; align-items: center; }
      .animation-checkpoint-item { display: flex; flex-direction: column; align-items: center; flex-shrink: 0; }
      .animation-checkpoint-hover-actions { display: flex; gap: 2px; margin-top: 4px; opacity: 0; pointer-events: none; transition: opacity 0.15s; justify-content: center; }
      .animation-checkpoint-item:hover .animation-checkpoint-hover-actions { opacity: 1; pointer-events: auto; }
      .animation-checkpoint-hover-actions button { width: 24px; height: 24px; padding: 0; border: 1px solid rgba(255,255,255,0.2); border-radius: 6px; background: rgba(0,0,0,0.5); color: #fff; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; }
      .animation-checkpoint-hover-actions .animation-checkpoint-delete-btn { color: #e85a4f; }
      .animation-checkpoint-pill { width: 32px; min-width: 32px; height: 32px; border-radius: 16px; border: 1px solid rgba(255,255,255,0.2); background: rgba(0,0,0,0.3); color: rgba(255,255,255,0.92); font: 500 11px/1 'Helvetica Neue',Arial,sans-serif; display: inline-flex; align-items: center; justify-content: center; cursor: pointer; position: relative; }
      .animation-checkpoint-pill:hover { border-color: rgba(255,255,255,0.42); background: rgba(0,0,0,0.5); }
      .animation-checkpoint-pill.active { border-color: rgba(255,255,255,0.5); background: rgba(191,40,27,0.52); }
      .animation-checkpoint-pill.playing { box-shadow: 0 0 0 2px rgba(191,40,27,0.26); }
      .animation-checkpoint-pill.stop-at::after { content: ''; position: absolute; bottom: 2px; left: 50%; transform: translateX(-50%); width: 4px; height: 4px; border-radius: 50%; background: rgba(255,255,255,0.9); }
      .path-animation-actions { margin-top: 4px; display: flex; gap: 4px; }
      .path-animation-actions button { flex: 1; padding: 8px; border: 1px solid rgba(255,255,255,0.18); border-radius: 10px; background: rgba(0,0,0,0.34); color: #fff; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; }
      .path-animation-actions button:hover { background: rgba(191,40,27,0.38); }
      .path-animation-actions button:disabled { opacity: 0.5; cursor: not-allowed; }
      .path-animation-actions .path-animation-delete-path-btn { color: #e85a4f; }
      .path-animation-actions .path-animation-delete-path-btn:hover:not(:disabled) { background: rgba(232,90,79,0.35); }
      .path-animation-timing { margin-top: 8px; padding-top: 8px; border-top: 1px solid rgba(255,255,255,0.12); }
      .path-animation-timing-row { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
      .path-animation-timing-row:last-child { margin-bottom: 0; }
      .path-animation-timing label { font-size: 11px; color: rgba(255,255,255,0.75); min-width: 100px; }
      .path-animation-timing input[type="number"] { width: 72px; padding: 6px 8px; border: 1px solid rgba(255,255,255,0.2); border-radius: 8px; background: rgba(0,0,0,0.35); color: #fff; font: 500 12px/1 'Helvetica Neue',Arial,sans-serif; }
      .path-animation-timing select { padding: 6px 8px; border: 1px solid rgba(255,255,255,0.2); border-radius: 8px; background: rgba(0,0,0,0.35); color: #fff; font: 500 12px/1 'Helvetica Neue',Arial,sans-serif; cursor: pointer; min-width: 80px; }
      .path-animation-checkbox-label { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: rgba(255,255,255,0.9); cursor: pointer; }
      .path-animation-checkbox-label input { width: 16px; height: 16px; cursor: pointer; }
      #pathAnimationRecordButton { display: flex; align-items: center; justify-content: center; width: 44px; height: 44px; border-radius: 50%; border: 1px solid rgba(255,255,255,0.2); background: rgba(0,0,0,0.35); color: #fff; cursor: pointer; }
      #pathAnimationRecordButton:hover { background: rgba(191,40,27,0.4); }
      #pathAnimationRecordButton svg { width: 21px; height: 21px; }
      #canvasFormatButton { color: #fff; }
      #canvasFormatButton svg { width: 21px; height: 21px; }
      .record-format-btn.active-format { background: rgba(191,40,27,0.35); border-color: rgba(191,40,27,0.5); }
      body.recording-mode .path-animation-editor-toggles-wrap,
      body.recording-mode .path-animation-editor-panel,
      body.recording-mode #pathAnimationRecordButton,
      body.recording-mode #canvasFormatButton,
      body.recording-mode .menu-container,
      body.recording-mode #detailsBox,
      body.recording-mode #overlay-ui,
      body.recording-mode #tapdot-labels-layer,
      body.recording-mode .editor-toggles-wrap,
      body.recording-mode #developerControls,
      body.recording-mode #vignette,
      body.recording-mode #tap-focus-feedback,
      body.recording-mode .tapdot-popup,
      body.recording-mode .obj-home-toggle-btn,
      body.recording-mode .obj-home-panel,
      body.recording-mode .lot-editor-toggle-wrap,
      body.recording-mode .lot-editor-panel,
      body.recording-mode #compassButton,
      body.recording-mode #hansenLogo { visibility: hidden !important; pointer-events: none !important; }

      .record-format-overlay {
        position: fixed; inset: 0; z-index: 9999;
        background: rgba(0,0,0,0.6);
        -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px);
        display: flex; align-items: center; justify-content: center;
        opacity: 0; transition: opacity 0.2s ease;
      }
      .record-format-overlay.active { opacity: 1; }
      .record-format-dialog {
        width: 340px; max-width: calc(100vw - 32px);
        border-radius: 20px;
        background: rgba(32,32,32,0.85);
        -webkit-backdrop-filter: blur(45px); backdrop-filter: blur(45px);
        color: rgba(255,255,255,0.95);
        font-family: 'Helvetica Neue',Arial,sans-serif;
        padding: 20px; box-sizing: border-box;
        transform: translateY(12px) scale(0.96);
        transition: transform 0.2s ease;
      }
      .record-format-overlay.active .record-format-dialog { transform: translateY(0) scale(1); }
      .record-format-dialog-title { font-size: 15px; font-weight: 600; margin-bottom: 14px; text-align: center; }
      .record-format-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 14px; }
      .record-format-btn {
        display: flex; flex-direction: column; align-items: center; gap: 6px;
        padding: 12px 8px; border: 1px solid rgba(255,255,255,0.18);
        border-radius: 14px; background: rgba(0,0,0,0.3);
        color: #fff; cursor: pointer; transition: background 0.15s, border-color 0.15s;
      }
      .record-format-btn:hover { background: rgba(191,40,27,0.35); border-color: rgba(191,40,27,0.5); }
      .record-format-btn-icon {
        border: 1.5px solid rgba(255,255,255,0.5); border-radius: 3px;
        background: rgba(255,255,255,0.08);
      }
      .record-format-btn-label { font-size: 12px; font-weight: 600; }
      .record-format-btn-size { font-size: 10px; color: rgba(255,255,255,0.55); }
      .record-format-duration-row {
        display: flex; align-items: center; gap: 10px;
        margin-bottom: 14px; justify-content: center;
      }
      .record-format-duration-row label { font-size: 12px; color: rgba(255,255,255,0.75); }
      .record-format-duration-row input {
        width: 72px; padding: 6px 8px;
        border: 1px solid rgba(255,255,255,0.2); border-radius: 8px;
        background: rgba(0,0,0,0.35); color: #fff;
        font: 500 12px/1 'Helvetica Neue',Arial,sans-serif; text-align: center;
      }
      .record-format-duration-row span { font-size: 11px; color: rgba(255,255,255,0.5); }
      .record-format-cancel {
        display: block; width: 100%; padding: 10px;
        border: 1px solid rgba(255,255,255,0.15); border-radius: 12px;
        background: rgba(0,0,0,0.25); color: rgba(255,255,255,0.7);
        font: 500 13px/1 'Helvetica Neue',Arial,sans-serif;
        cursor: pointer; text-align: center; transition: background 0.15s;
      }
      .record-format-cancel:hover { background: rgba(255,255,255,0.08); }

      body.touch-sim-mode, body.touch-sim-mode * { cursor: none !important; }
      body.touch-sim-mode .menu-container,
      body.touch-sim-mode .menu-container *,
      body.touch-sim-mode .path-animation-editor-toggles-wrap,
      body.touch-sim-mode .path-animation-editor-toggles-wrap *,
      body.touch-sim-mode .path-animation-editor-panel,
      body.touch-sim-mode .path-animation-editor-panel * { cursor: auto !important; }
      #touchSimOverlay { position: fixed; inset: 0; pointer-events: none; z-index: 999999; }
      .touch-sim-dot {
        position: absolute; width: 14px; height: 14px; border-radius: 999px;
        background: rgba(255,255,255,0.95);
        box-shadow: 0 0 0 2px rgba(0,0,0,0.25), 0 10px 24px rgba(0,0,0,0.35);
        transform: translate(-50%,-50%) scale(0.35); opacity: 0;
        animation: touchSimIn 120ms ease-out forwards;
      }
      .touch-sim-dot::after {
        content: ''; position: absolute; inset: -10px; border-radius: inherit;
        border: 2px solid rgba(255,255,255,0.55); opacity: 0;
        animation: touchSimRingIn 180ms ease-out forwards;
      }
      .touch-sim-dot.releasing {
        animation: touchSimOut 320ms ease-out forwards;
      }
      .touch-sim-dot.releasing::after {
        animation: touchSimRingOut 320ms ease-out forwards;
      }
      @keyframes touchSimIn {
        0%   { opacity: 0; transform: translate(-50%,-50%) scale(0.35); }
        100% { opacity: 1; transform: translate(-50%,-50%) scale(1.0); }
      }
      @keyframes touchSimRingIn {
        0%   { opacity: 0; transform: scale(0.6); }
        100% { opacity: 0.7; transform: scale(1.0); }
      }
      @keyframes touchSimOut {
        0%   { opacity: 1; transform: translate(-50%,-50%) scale(1.0); }
        100% { opacity: 0; transform: translate(-50%,-50%) scale(1.25); }
      }
      @keyframes touchSimRingOut {
        0%   { opacity: 0.7; transform: scale(1.0); }
        100% { opacity: 0; transform: scale(1.35); }
      }
      #touchSimToggleButton { color: #fff; }
      #touchSimToggleButton svg { width: 21px; height: 21px; }
      #touchSimToggleButton.touch-sim-active { background: rgba(191,40,27,0.4); border-color: rgba(191,40,27,0.5); }
      body.recording-mode #touchSimToggleButton,
      body.recording-mode #touchSimOverlay { visibility: hidden !important; pointer-events: none !important; }
    `;
    document.head.appendChild(style);
  }

  function createUI() {
    injectStyles();

    let wrap = document.getElementById('editorTogglesWrap')
           || document.getElementById('wolfTopRightToolbarWrap')
           || document.getElementById('pathAnimationEditorTogglesWrap');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.className = 'path-animation-editor-toggles-wrap';
      wrap.id = 'pathAnimationEditorTogglesWrap';
      wrap.__created = true;
    }

    toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'path-animation-editor-toggle';
    toggleBtn.setAttribute('aria-label', 'Path animation editor');
    toggleBtn.setAttribute('title', 'Create and edit flight path');
    toggleBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>';
    wrap.prepend(toggleBtn);

    panelEl = document.createElement('div');
    panelEl.className = 'path-animation-editor-panel';
    panelEl.id = 'pathAnimationEditorPanel';
    panelEl.setAttribute('aria-live', 'polite');
    panelEl.innerHTML = `
      <div class="path-animation-header" style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
        <div class="path-animation-title">Path<span id="pathAnimationActiveLabel" style="font-weight:400;opacity:0.7"></span></div>
        <button type="button" class="path-animation-close" aria-label="Close" style="width:24px;height:24px;border:1px solid rgba(255,255,255,0.2);border-radius:12px;background:rgba(0,0,0,0.3);color:#fff;cursor:pointer;font:500 14px/1 sans-serif">×</button>
      </div>
      <div id="pathAnimationStatus" class="path-animation-status"></div>
      <div id="pathAnimationSummary" class="path-animation-summary"></div>
      <div class="path-animation-timing">
        <div class="path-animation-timing-row">
          <label for="pathAnimationSpeed">Speed</label>
          <select id="pathAnimationSpeed" aria-label="Playback speed">
            <option value="0.25">0.25×</option>
            <option value="0.5">0.5×</option>
            <option value="1" selected>1×</option>
            <option value="1.5">1.5×</option>
            <option value="2">2×</option>
          </select>
        </div>
        <div class="path-animation-timing-row" id="pathAnimationDurationRow" style="display:none">
          <label for="pathAnimationDuration">Segment (s)</label>
          <input id="pathAnimationDuration" type="number" min="0.1" max="120" step="0.5" aria-label="Segment duration in seconds">
        </div>
        <div class="path-animation-timing-row" id="pathAnimationStopRow" style="display:none">
          <label for="pathAnimationStopAt">Stop here</label>
          <label class="path-animation-checkbox-label">
            <input id="pathAnimationStopAt" type="checkbox" aria-label="Stop at this point">
            <span>Stop</span>
          </label>
        </div>
        <div class="path-animation-timing-row" id="pathAnimationPauseDurationRow" style="display:none">
          <label for="pathAnimationPauseDuration">Pause (s)</label>
          <input id="pathAnimationPauseDuration" type="number" min="0" max="60" step="0.5" aria-label="Pause duration in seconds">
        </div>
      </div>
      <div id="pathAnimationCheckpointStrip" class="animation-checkpoint-strip" aria-label="Camera checkpoints"></div>
      <div class="path-animation-actions">
        <button id="pathAnimationCaptureBtn" type="button" aria-label="Capture checkpoint" title="Capture"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="4" fill="currentColor" stroke="none"/></svg></button>
        <button id="pathAnimationPlayBtn" type="button" aria-label="Play" title="Play / Pause"><svg class="icon-play" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg><svg class="icon-pause" viewBox="0 0 24 24" fill="currentColor" style="display:none"><path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z"/></svg></button>
        <button id="pathAnimationExportBtn" type="button" aria-label="Copy JSON" title="Copy path JSON"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>
        <button id="pathAnimationDeletePathBtn" type="button" class="path-animation-delete-path-btn" aria-label="Delete entire path" title="Delete path"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M10 11v6M14 11v6"/></svg></button>
      </div>
    `;
    document.body.appendChild(panelEl);

    statusEl = document.getElementById('pathAnimationStatus');
    summaryEl = document.getElementById('pathAnimationSummary');
    stripEl = document.getElementById('pathAnimationCheckpointStrip');
    captureBtn = document.getElementById('pathAnimationCaptureBtn');
    playBtn = document.getElementById('pathAnimationPlayBtn');
    exportBtn = document.getElementById('pathAnimationExportBtn');
    durationInputEl = document.getElementById('pathAnimationDuration');
    durationRowEl = document.getElementById('pathAnimationDurationRow');
    speedSelectEl = document.getElementById('pathAnimationSpeed');
    const deletePathBtn = document.getElementById('pathAnimationDeletePathBtn');
    stopAtCheckboxEl = document.getElementById('pathAnimationStopAt');
    stopRowEl = document.getElementById('pathAnimationStopRow');
    pauseDurationInputEl = document.getElementById('pathAnimationPauseDuration');
    pauseDurationRowEl = document.getElementById('pathAnimationPauseDurationRow');

    if (deletePathBtn) {
      deletePathBtn.addEventListener('click', () => {
        if (pathState.checkpoints.length === 0) return;
        if (!confirm('Delete entire path? This cannot be undone.')) return;
        pathState.playing = false;
        pathState.checkpoints = [];
        pathState.segmentIndex = 0;
        pathState.segmentElapsed = 0;
        editorState.selectedCheckpointIndex = 0;
        setStatus('Path deleted.');
        syncUI();
      });
    }

    if (speedSelectEl) {
      speedSelectEl.addEventListener('change', () => {
        const val = parseFloat(speedSelectEl.value);
        if (Number.isFinite(val) && val > 0) {
          pathState.speed = val;
          setStatus(`Speed set to ${val}×`);
          syncUI();
        }
      });
    }
    if (durationInputEl) {
      const applyDuration = () => {
        const idx = editorState.selectedCheckpointIndex;
        if (idx < 0 || idx >= pathState.checkpoints.length) return;
        const val = parseFloat(durationInputEl.value);
        if (!Number.isFinite(val) || val < 0.1) return;
        const clamped = Math.min(120, Math.max(0.1, val));
        pathState.checkpoints[idx].duration = clamped;
        durationInputEl.value = clamped.toFixed(1);
        setStatus(`Segment ${idx + 1} duration: ${clamped.toFixed(1)}s`);
        syncUI();
      };
      durationInputEl.addEventListener('change', applyDuration);
      durationInputEl.addEventListener('blur', applyDuration);
    }
    if (stopAtCheckboxEl) {
      stopAtCheckboxEl.addEventListener('change', () => {
        const idx = editorState.selectedCheckpointIndex;
        if (idx < 0 || idx >= pathState.checkpoints.length) return;
        pathState.checkpoints[idx].pauseAt = stopAtCheckboxEl.checked;
        setStatus(pathState.checkpoints[idx].pauseAt ? `Stop at point ${idx + 1}` : `Fly through point ${idx + 1}`);
        syncUI();
      });
    }
    if (pauseDurationInputEl) {
      const applyPauseDuration = () => {
        const idx = editorState.selectedCheckpointIndex;
        if (idx < 0 || idx >= pathState.checkpoints.length) return;
        const val = parseFloat(pauseDurationInputEl.value);
        if (!Number.isFinite(val) || val < 0) return;
        const clamped = Math.min(60, Math.max(0, val));
        pathState.checkpoints[idx].pauseDuration = clamped;
        pauseDurationInputEl.value = clamped.toFixed(1);
        setStatus(`Pause at ${idx + 1}: ${clamped.toFixed(1)}s`);
        syncUI();
      };
      pauseDurationInputEl.addEventListener('change', applyPauseDuration);
      pauseDurationInputEl.addEventListener('blur', applyPauseDuration);
    }

    const closeBtn = panelEl.querySelector('.path-animation-close');
    closeBtn.addEventListener('click', () => {
      editorState.open = false;
      panelEl.classList.remove('active');
      if (toggleBtn) toggleBtn.classList.remove('active');
    });

    toggleBtn.addEventListener('click', () => {
      editorState.open = !editorState.open;
      panelEl.classList.toggle('active', editorState.open);
      toggleBtn.classList.toggle('active', editorState.open);
    });

    if (captureBtn) captureBtn.addEventListener('click', captureCheckpoint);
    if (playBtn) playBtn.addEventListener('click', togglePlayback);
    if (exportBtn) exportBtn.addEventListener('click', () => {
      try {
        navigator.clipboard.writeText(JSON.stringify(getSerializedPayload(), null, 2));
        setStatus('Path JSON copied.');
      } catch (e) { setStatus('Copy failed.'); }
      syncUI();
    });

    if (wrap.__created) document.body.insertBefore(wrap, document.body.firstChild);

    if (menuContainer && typeof menuContainer.appendChild === 'function') {
      recordBtnEl = document.createElement('div');
      recordBtnEl.id = 'pathAnimationRecordButton';
      recordBtnEl.className = 'menu-button';
      recordBtnEl.setAttribute('title', 'Record path animation');
      recordBtnEl.setAttribute('aria-label', 'Record path animation');
      recordBtnEl.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="6"/></svg>';
      recordBtnEl.addEventListener('click', () => {
        if (document.body.classList.contains('recording-mode')) return;
        showFormatPicker((format, durationMs) => {
          document.body.classList.add('recording-mode');
          recordPathAnimation({
            durationMs,
            fps: 30,
            formatWidth: format.width,
            formatHeight: format.height,
            formatLabel: format.id === 'desktop' ? '' : format.id,
            onBefore: () => {},
            onAfter: () => document.body.classList.remove('recording-mode')
          });
        });
      });
      menuContainer.appendChild(recordBtnEl);

      const canvasFormatBtn = document.createElement('div');
      canvasFormatBtn.id = 'canvasFormatButton';
      canvasFormatBtn.className = 'menu-button';
      canvasFormatBtn.setAttribute('title', 'Canvas format');
      canvasFormatBtn.setAttribute('aria-label', 'Change canvas format');
      canvasFormatBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 7V2h5M17 2h5v5M22 17v5h-5M7 22H2v-5"/></svg>';
      canvasFormatBtn.addEventListener('click', showCanvasFormatPicker);
      menuContainer.appendChild(canvasFormatBtn);

      const touchSimBtn = document.createElement('div');
      touchSimBtn.id = 'touchSimToggleButton';
      touchSimBtn.className = 'menu-button';
      touchSimBtn.setAttribute('title', 'Touch sim mode (T)');
      touchSimBtn.setAttribute('aria-label', 'Toggle touch simulation mode');
      touchSimBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2"/><path d="M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2"/><path d="M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 16"/></svg>';
      menuContainer.appendChild(touchSimBtn);

      const touchOverlay = document.createElement('div');
      touchOverlay.id = 'touchSimOverlay';
      document.body.appendChild(touchOverlay);

      function isTouchSimOn() { return document.body.classList.contains('touch-sim-mode'); }
      function setTouchSim(on) {
        document.body.classList.toggle('touch-sim-mode', !!on);
        touchSimBtn.classList.toggle('touch-sim-active', !!on);
        try { localStorage.setItem('touchSimModeEnabled', on ? '1' : '0'); } catch (_) {}
      }

      touchSimBtn.addEventListener('click', () => setTouchSim(!isTouchSimOn()));

      let activeDot = null;
      function releaseDot() {
        if (!activeDot) return;
        const dot = activeDot;
        activeDot = null;
        dot.classList.add('releasing');
        dot.addEventListener('animationend', () => dot.remove(), { once: true });
      }

      window.addEventListener('pointerdown', (e) => {
        if (!isTouchSimOn()) return;
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        releaseDot();
        const dot = document.createElement('div');
        dot.className = 'touch-sim-dot';
        dot.style.left = e.clientX + 'px';
        dot.style.top = e.clientY + 'px';
        touchOverlay.appendChild(dot);
        activeDot = dot;
      }, true);

      window.addEventListener('pointerup', releaseDot, true);
      window.addEventListener('pointercancel', releaseDot, true);

      window.addEventListener('keydown', (e) => {
        if (e.key.toLowerCase() !== 't') return;
        const tag = document.activeElement && document.activeElement.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        setTouchSim(!isTouchSimOn());
      });

      try { if (localStorage.getItem('touchSimModeEnabled') === '1') setTouchSim(true); } catch (_) {}
    }

    setPathEnabled(pathState.enabled);
  }

  function setActivePath(index) {
    const idx = clamp(Math.floor(index), 0, allPaths.length - 1);
    if (idx === activePathIndex && pathState === allPaths[idx]) return;
    pathState.playing = false;
    activePathIndex = idx;
    pathState = allPaths[idx];
    pathState.segmentIndex = 0;
    pathState.segmentElapsed = 0;
    pathState.pausedAtCheckpoint = null;
    pathState.pauseElapsed = 0;
    editorState.selectedCheckpointIndex = 0;
    syncUI();
  }

  function setSceneOrigin(origin) {
    if (origin && typeof origin === 'object') {
      currentSceneOrigin.x = Number.isFinite(origin.x) ? origin.x : currentSceneOrigin.x;
      currentSceneOrigin.y = Number.isFinite(origin.y) ? origin.y : currentSceneOrigin.y;
      currentSceneOrigin.z = Number.isFinite(origin.z) ? origin.z : currentSceneOrigin.z;
    }
  }

  createUI();

  return {
    update(deltaSeconds) {
      updatePathAnimation(deltaSeconds);
    },
    getState() {
      return { enabled: pathState.enabled, playing: pathState.playing, pathState };
    },
    goToAnimationStart,
    pause() { pathState.playing = false; syncUI(); },
    getSerializedPayload,
    recordPathAnimation,
    applyCanvasFormat,
    showCanvasFormatPicker,
    setActivePath,
    getActivePathIndex() { return activePathIndex; },
    getPathCount() { return allPaths.length; },
    setSceneOrigin
  };
}
