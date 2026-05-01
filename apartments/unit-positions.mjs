/** @typedef {{ x: number, y: number, z: number }} Vec3 */

const STORAGE_KEY = 'apartments:positions:v1';

/** Default markers around Canyon Vista splat space (near amenity tap-dot scale). */
const DEFAULT_POSITIONS = {
  '204': { x: -0.35, y: 0.08, z: 0.25 },
  '208': { x: -0.12, y: 0.08, z: 0.38 },
  '212': { x: 0.18, y: 0.08, z: 0.22 },
  '302': { x: -0.4, y: 0.22, z: -0.15 },
  '305': { x: -0.05, y: 0.22, z: -0.28 },
  '308': { x: 0.32, y: 0.22, z: -0.12 },
  '401': { x: -0.28, y: 0.36, z: 0.42 },
  '405': { x: 0.08, y: 0.36, z: 0.48 },
  '408': { x: 0.42, y: 0.36, z: 0.18 },
  '412': { x: -0.22, y: 0.36, z: -0.42 },
};

/** @returns {Record<string, Vec3>} */
export function getDefaultPositions() {
  return JSON.parse(JSON.stringify(DEFAULT_POSITIONS));
}

/** @returns {Record<string, Vec3>} */
export function getPositions() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return getDefaultPositions();
    const parsed = JSON.parse(raw);
    const map =
      parsed && typeof parsed === 'object' && parsed.positions && typeof parsed.positions === 'object'
        ? parsed.positions
        : parsed;
    if (map && typeof map === 'object' && !Array.isArray(map)) {
      const out = {};
      for (const [k, v] of Object.entries(map)) {
        if (v && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z)) {
          out[k] = { x: v.x, y: v.y, z: v.z };
        }
      }
      return { ...getDefaultPositions(), ...out };
    }
  } catch (_) {
    /* ignore */
  }
  return getDefaultPositions();
}

/** @param {Record<string, Vec3>} map */
export function savePositions(map) {
  const body = { v: 1, positions: map, savedAt: new Date().toISOString() };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(body));
}

/**
 * Merge one unit position into stored map and persist.
 * @param {string} unitNumber
 * @param {Vec3} vec
 */
export function setUnitPosition(unitNumber, vec) {
  const map = getPositions();
  map[unitNumber] = { x: vec.x, y: vec.y, z: vec.z };
  savePositions(map);
  return map;
}

/** @param {Record<string, Vec3>} fullMap */
export function replaceAllPositions(fullMap) {
  savePositions(fullMap);
}

export function exportPositionsJSON() {
  return JSON.stringify(getPositions(), null, 2);
}

export function clearSavedPositions() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (_) {
    /* ignore */
  }
}
