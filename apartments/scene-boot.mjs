import { WebGLRenderer, PerspectiveCamera, Scene, Color, MathUtils } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { LumaSplatsThree } from '@lumaai/luma-web';

/** Same Luma embed + splat transform as Canyon-Vista/index.html */
const CANYON_VISTA_HOLE = {
  source:
    'https://lumalabs.ai/embed/9dda6301-f17b-45c7-8e95-edfb6fd529a2?mode=sparkles&background=%23ffffff&color=%23000000&showTitle=true&loadBg=true&logoPosition=bottom-left&infoPosition=bottom-right&cinematicVideo=undefined&showMenu=false',
  revealDuration: 2.8,
  splat: {
    position: { x: 0, y: 0.238, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    scale: 1,
  },
  view: {
    startPosition: { x: 0.22, y: 0.6, z: 2.75 },
    target: { x: 0, y: -0.06, z: 0 },
    minDistance: 0.65,
    maxDistance: 10.4,
    minPolarAngle: 14,
    maxPolarAngle: 179,
  },
};

const CAMERA_MIN_Y = -2;

function applyHoleSplatTransform(holeSplat, holeConfig) {
  const splatConfig = holeConfig && holeConfig.splat ? holeConfig.splat : {};
  const position = splatConfig.position || { x: 0, y: 0, z: 0 };
  const rotation = splatConfig.rotation || { x: 0, y: 0, z: 0 };
  const scale = Number.isFinite(splatConfig.scale) ? splatConfig.scale : 1;
  holeSplat.position.set(position.x, position.y, position.z);
  holeSplat.rotation.x = MathUtils.degToRad(rotation.x || 0);
  holeSplat.rotation.y = MathUtils.degToRad(rotation.y || 0);
  holeSplat.rotation.z = MathUtils.degToRad(rotation.z || 0);
  holeSplat.scale.setScalar(scale);
}

/**
 * @returns {{ scene: import('three').Scene, camera: import('three').PerspectiveCamera, controls: import('three').OrbitControls, renderer: import('three').WebGLRenderer, splat: object, animate: (frame?: (dt: number) => void) => void }}
 */
export function createSceneBoot() {
  const renderer = new WebGLRenderer({ antialias: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio * 0.8, 1.8));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(new Color(0x000000));
  document.body.appendChild(renderer.domElement);

  const scene = new Scene();
  const camera = new PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 1000);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.zoomSpeed = 0.5;
  if ('zoomToCursor' in controls) controls.zoomToCursor = true;

  const vc = CANYON_VISTA_HOLE.view;
  controls.target.set(vc.target.x, vc.target.y, vc.target.z);
  controls.minDistance = vc.minDistance;
  controls.maxDistance = vc.maxDistance;
  controls.minPolarAngle = MathUtils.degToRad(vc.minPolarAngle);
  controls.maxPolarAngle = MathUtils.degToRad(vc.maxPolarAngle);
  camera.position.set(vc.startPosition.x, vc.startPosition.y, vc.startPosition.z);
  controls.update();

  controls.addEventListener('change', () => {
    if (camera.position.y < CAMERA_MIN_Y) {
      const dist = camera.position.distanceTo(controls.target);
      const distanceScale = Math.min(3, Math.max(0.6, dist / 1.2));
      const effectiveSpeed = 0.2 * distanceScale;
      camera.position.y += (CAMERA_MIN_Y - camera.position.y) * effectiveSpeed;
    }
  });

  const splat = new LumaSplatsThree({
    source: CANYON_VISTA_HOLE.source,
    particleRevealEnabled: true,
    particleRevealDuration: CANYON_VISTA_HOLE.revealDuration,
  });
  if (splat.material) splat.material.depthTest = true;
  splat.renderOrder = 999;
  applyHoleSplatTransform(splat, CANYON_VISTA_HOLE);
  scene.add(splat);

  let last = performance.now();
  let userFrame = /** @type {((dt: number) => void) | null} */ (null);

  function animateLoop() {
    requestAnimationFrame(animateLoop);
    const now = performance.now();
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    controls.update();
    if (userFrame) userFrame(dt);
    renderer.render(scene, camera);
  }

  function animate(frame) {
    userFrame = frame || null;
  }

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  animateLoop();

  return { scene, camera, controls, renderer, splat, animate };
}
