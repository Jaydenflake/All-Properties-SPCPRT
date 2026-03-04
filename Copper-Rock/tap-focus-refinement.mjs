const HALF_FLOAT_SIGN_MASK = 0x8000;
const HALF_FLOAT_EXPONENT_MASK = 0x7c00;
const HALF_FLOAT_FRACTION_MASK = 0x03ff;
const HALF_FLOAT_EXPONENT_SHIFT = 10;
const HALF_FLOAT_MAX_EXPONENT = 0x1f;
const DEFAULT_TARGET_SAMPLE_COUNT = 18000;

export function decodeFloat16(value) {
    if (!Number.isFinite(value)) return NaN;
    const bits = value & 0xffff;
    const sign = (bits & HALF_FLOAT_SIGN_MASK) ? -1 : 1;
    const exponent = (bits & HALF_FLOAT_EXPONENT_MASK) >> HALF_FLOAT_EXPONENT_SHIFT;
    const fraction = bits & HALF_FLOAT_FRACTION_MASK;

    if (exponent === 0) {
        return fraction === 0
            ? sign * 0
            : sign * 2 ** -14 * (fraction / 1024);
    }

    if (exponent === HALF_FLOAT_MAX_EXPONENT) {
        return fraction === 0 ? sign * Infinity : NaN;
    }

    return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

export function sampleCpuPointsForFocus({
    cpuPoints,
    pointCount,
    targetSampleCount = DEFAULT_TARGET_SAMPLE_COUNT
} = {}) {
    if (!cpuPoints || typeof cpuPoints.length !== 'number' || cpuPoints.length < 3) return null;
    const availablePointCount = Math.floor(cpuPoints.length / 3);
    const requestedPointCount = Number.isFinite(pointCount)
        ? Math.max(0, Math.floor(pointCount))
        : availablePointCount;
    const sourcePointCount = Math.min(requestedPointCount, availablePointCount);
    if (!sourcePointCount) return null;

    const normalizedTargetSampleCount = Number.isFinite(targetSampleCount) && targetSampleCount > 0
        ? Math.floor(targetSampleCount)
        : DEFAULT_TARGET_SAMPLE_COUNT;
    const stride = Math.max(1, Math.ceil(sourcePointCount / normalizedTargetSampleCount));
    const estimatedSampledPointCount = Math.ceil(sourcePointCount / stride);
    let samples = new Float32Array(estimatedSampledPointCount * 3);
    let writeOffset = 0;

    for (let pointIndex = 0; pointIndex < sourcePointCount; pointIndex += stride) {
        const sourceOffset = pointIndex * 3;
        const x = -decodeFloat16(cpuPoints[sourceOffset]);
        const y = -decodeFloat16(cpuPoints[sourceOffset + 1]);
        const z = decodeFloat16(cpuPoints[sourceOffset + 2]);
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
        samples[writeOffset] = x;
        samples[writeOffset + 1] = y;
        samples[writeOffset + 2] = z;
        writeOffset += 3;
    }

    if (!writeOffset) return null;
    if (writeOffset !== samples.length) {
        samples = samples.slice(0, writeOffset);
    }

    return {
        samples,
        stride,
        sourcePointCount,
        sampledPointCount: samples.length / 3
    };
}

export function findClosestSampleToRay({
    samples,
    rayOrigin,
    rayDirection,
    maxDistanceSq = Number.POSITIVE_INFINITY
} = {}) {
    if (!samples || samples.length < 3 || !rayOrigin || !rayDirection) return null;
    let directionX = rayDirection.x;
    let directionY = rayDirection.y;
    let directionZ = rayDirection.z;
    const directionLength = Math.hypot(directionX, directionY, directionZ);
    if (!(directionLength > 1e-12)) return null;
    directionX /= directionLength;
    directionY /= directionLength;
    directionZ /= directionLength;

    const originX = rayOrigin.x;
    const originY = rayOrigin.y;
    const originZ = rayOrigin.z;
    if (!Number.isFinite(originX) || !Number.isFinite(originY) || !Number.isFinite(originZ)) return null;
    const distanceSqLimit = Number.isFinite(maxDistanceSq) && maxDistanceSq >= 0
        ? maxDistanceSq
        : Number.POSITIVE_INFINITY;

    let bestOffset = -1;
    let bestDistanceSq = Number.POSITIVE_INFINITY;
    let bestRayDistance = Number.POSITIVE_INFINITY;

    for (let offset = 0; offset < samples.length; offset += 3) {
        const pointX = samples[offset];
        const pointY = samples[offset + 1];
        const pointZ = samples[offset + 2];

        const toPointX = pointX - originX;
        const toPointY = pointY - originY;
        const toPointZ = pointZ - originZ;
        const rayDistance = toPointX * directionX + toPointY * directionY + toPointZ * directionZ;
        if (rayDistance <= 0) continue;

        const closestPointX = originX + directionX * rayDistance;
        const closestPointY = originY + directionY * rayDistance;
        const closestPointZ = originZ + directionZ * rayDistance;

        const deltaX = pointX - closestPointX;
        const deltaY = pointY - closestPointY;
        const deltaZ = pointZ - closestPointZ;
        const distanceSq = deltaX * deltaX + deltaY * deltaY + deltaZ * deltaZ;
        if (distanceSq > distanceSqLimit) continue;

        if (distanceSq < bestDistanceSq || (Math.abs(distanceSq - bestDistanceSq) <= 1e-12 && rayDistance < bestRayDistance)) {
            bestDistanceSq = distanceSq;
            bestRayDistance = rayDistance;
            bestOffset = offset;
        }
    }

    if (bestOffset < 0) return null;
    return {
        sampleOffset: bestOffset,
        x: samples[bestOffset],
        y: samples[bestOffset + 1],
        z: samples[bestOffset + 2],
        distanceSq: bestDistanceSq,
        rayDistance: bestRayDistance
    };
}

export function computeScreenDistancePx({
    ndcX,
    ndcY,
    viewportWidth,
    viewportHeight,
    pointerX,
    pointerY
} = {}) {
    if (!Number.isFinite(ndcX) || !Number.isFinite(ndcY)) return Number.POSITIVE_INFINITY;
    if (!Number.isFinite(viewportWidth) || !Number.isFinite(viewportHeight)) return Number.POSITIVE_INFINITY;
    if (!Number.isFinite(pointerX) || !Number.isFinite(pointerY)) return Number.POSITIVE_INFINITY;
    const screenX = (ndcX + 1) * 0.5 * viewportWidth;
    const screenY = (1 - ndcY) * 0.5 * viewportHeight;
    return Math.hypot(screenX - pointerX, screenY - pointerY);
}

/**
 * Extract all points within a sphere from the splat's CPU buffer (full density).
 * @param {Object} opts
 * @param {Uint16Array|Float32Array} opts.cpuPoints - Half-float position buffer (x,y,z per point)
 * @param {number} opts.pointCount - Max points to consider (e.g. loader.cpuPtsCount or length/3)
 * @param {{x:number,y:number,z:number}} opts.center - Sphere center in world space
 * @param {number} opts.radius - Sphere radius in world units (meters)
 * @param {number[]} opts.matrixWorldElements - Splat's matrixWorld.elements (column-major 4x4)
 * @returns {{ points: Float32Array, count: number }|null}
 */
export function extractPointsInSphere({
    cpuPoints,
    pointCount,
    center,
    radius,
    matrixWorldElements
} = {}) {
    if (!cpuPoints || !matrixWorldElements || matrixWorldElements.length < 16) return null;
    const cx = Number(center?.x) ?? 0;
    const cy = Number(center?.y) ?? 0;
    const cz = Number(center?.z) ?? 0;
    const r = Number(radius);
    if (!Number.isFinite(r) || r <= 0) return null;

    const available = Math.floor(cpuPoints.length / 3);
    const n = Math.min(Number.isFinite(pointCount) ? Math.floor(pointCount) : available, available);
    if (!n) return null;

    const m = matrixWorldElements;
    const radiusSq = r * r;
    const out = [];
    const stride = 1; // full density

    for (let i = 0; i < n; i += stride) {
        const o = i * 3;
        const lx = -decodeFloat16(cpuPoints[o]);
        const ly = -decodeFloat16(cpuPoints[o + 1]);
        const lz = decodeFloat16(cpuPoints[o + 2]);
        if (!Number.isFinite(lx) || !Number.isFinite(ly) || !Number.isFinite(lz)) continue;

        const wx = m[0] * lx + m[4] * ly + m[8] * lz + m[12];
        const wy = m[1] * lx + m[5] * ly + m[9] * lz + m[13];
        const wz = m[2] * lx + m[6] * ly + m[10] * lz + m[14];

        const dx = wx - cx;
        const dy = wy - cy;
        const dz = wz - cz;
        if (dx * dx + dy * dy + dz * dz <= radiusSq) {
            out.push(wx, wy, wz);
        }
    }

    if (!out.length) return { points: new Float32Array(0), count: 0 };
    return {
        points: new Float32Array(out),
        count: out.length / 3
    };
}

/**
 * Build ASCII PLY string from world-space points.
 * @param {Float32Array} points - [x,y,z, x,y,z, ...]
 * @param {Object} [opts]
 * @param {boolean} [opts.heightColors=false] - If true, add vertex colors from height (Y) gradient for terrain visualization
 * @returns {string}
 */
export function buildPlyAscii(points, opts = {}) {
    if (!points || points.length < 3) return '';
    const n = Math.floor(points.length / 3);
    const useHeightColors = !!opts.heightColors;

    // Height is Three.js Y; Blender will get this as Z after axis swap.
    let minY = Infinity, maxY = -Infinity;
    if (useHeightColors) {
        for (let i = 0; i < n; i++) {
            const y = points[i * 3 + 1];
            if (Number.isFinite(y)) {
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
            }
        }
        const range = maxY - minY;
        if (!(range > 0)) minY = maxY - 1;
    }

    const header = [
        'ply',
        'format ascii 1.0',
        'element vertex ' + n,
        'property float x',
        'property float y',
        'property float z'
    ];
    if (useHeightColors) {
        header.push('property uchar red', 'property uchar green', 'property uchar blue');
    }
    header.push('end_header');

    const lines = [...header];
    const range = maxY - minY;

    for (let i = 0; i < n; i++) {
        const o = i * 3;
        const x = points[o];
        const y = points[o + 1];
        const z = points[o + 2];

        // Swap X and Z to match Blender's import orientation better for your captures.
        // (Three.js: X right, Y up, Z forward) -> (Blender PLY: X'=Z, Y'=Y, Z'=X)
        const bx = z;
        const by = y;
        const bz = x;

        let row = bx + ' ' + by + ' ' + bz;
        if (useHeightColors && range > 0) {
            const t = Math.max(0, Math.min(1, (y - minY) / range));
            const r = Math.round(34 + t * 221);
            const g = Math.round(139 + t * 116);
            const b = Math.round(34 + t * 221);
            row += ' ' + r + ' ' + g + ' ' + b;
        }
        lines.push(row);
    }
    return lines.join('\n');
}

/**
 * Rasterize 3D points to a top-down orthographic heightmap (DEM style).
 * World up = Y (Three.js); export interprets as Z-up for Blender/Unreal.
 * Uses max Y per cell (top surface). Maps [minY, maxY] → [1, 65535]; 0 = no-data.
 * @param {Float32Array} points - [x,y,z, x,y,z, ...] world space (Y = height)
 * @param {number} width - output image width
 * @param {number} height - output image height
 * @param {{ fillHoles?: boolean, centerX?: number, centerZ?: number, radius?: number }} [opts]
 *   - fillHoles: replace no-data (0) with nearest non-zero neighbor
 *   - centerX, centerZ, radius: ortho bounds [-radius,+radius] around (centerX, centerZ); if omitted, use point bounds
 * @returns {{ data: Uint16Array, width: number, height: number, minY: number, maxY: number, minX: number, maxX: number, minZ: number, maxZ: number }|null}
 */
export function rasterizePointsToHeightmap(points, width, height, opts = {}) {
    if (!points || points.length < 3) return null;
    const n = Math.floor(points.length / 3);
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    const fillHoles = !!opts.fillHoles;
    const useOrtho = Number.isFinite(opts.centerX) && Number.isFinite(opts.centerZ) && Number.isFinite(opts.radius) && opts.radius > 0;

    let minX, maxX, minZ, maxZ;
    if (useOrtho) {
        minX = opts.centerX - opts.radius;
        maxX = opts.centerX + opts.radius;
        minZ = opts.centerZ - opts.radius;
        maxZ = opts.centerZ + opts.radius;
    } else {
        minX = Infinity;
        maxX = -Infinity;
        minZ = Infinity;
        maxZ = -Infinity;
        for (let i = 0; i < n; i++) {
            const o = i * 3;
            const x = points[o], z = points[o + 2];
            if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (z < minZ) minZ = z;
            if (z > maxZ) maxZ = z;
        }
        if (maxX <= minX) maxX = minX + 1;
        if (maxZ <= minZ) maxZ = minZ + 1;
    }

    let minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < n; i++) {
        const y = points[i * 3 + 1];
        if (!Number.isFinite(y)) continue;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
    }
    if (maxY <= minY) maxY = minY + 1;
    const rX = (maxX - minX) || 1;
    const rZ = (maxZ - minZ) || 1;
    const rY = (maxY - minY) || 1;

    const grid = new Float32Array(w * h);
    grid.fill(-Infinity);

    for (let i = 0; i < n; i++) {
        const o = i * 3;
        const x = points[o], y = points[o + 1], z = points[o + 2];
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
        if (useOrtho && (x < minX || x > maxX || z < minZ || z > maxZ)) continue;
        const px = Math.min(w - 1, Math.max(0, Math.floor((x - minX) / rX * w)));
        const py = Math.min(h - 1, Math.max(0, Math.floor((maxZ - z) / rZ * h)));
        const idx = py * w + px;
        if (y > grid[idx]) grid[idx] = y;
    }

    const out = new Uint16Array(w * h);
    for (let i = 0; i < grid.length; i++) {
        const v = grid[i];
        if (v === -Infinity || !Number.isFinite(v)) {
            out[i] = 0;
        } else {
            const t = (v - minY) / rY;
            out[i] = Math.min(65535, Math.max(1, Math.round(1 + t * 65534)));
        }
    }

    if (fillHoles) {
        const maxDist = Math.min(w, h, 100);
        for (let py = 0; py < h; py++) {
            for (let px = 0; px < w; px++) {
                const idx = py * w + px;
                if (out[idx] !== 0) continue;
                let bestVal = 0;
                let bestDist = maxDist + 1;
                for (let dy = -maxDist; dy <= maxDist; dy++) {
                    for (let dx = -maxDist; dx <= maxDist; dx++) {
                        const nx = px + dx;
                        const ny = py + dy;
                        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
                        const v = out[ny * w + nx];
                        if (v === 0) continue;
                        const d = Math.sqrt(dx * dx + dy * dy);
                        if (d < bestDist) {
                            bestDist = d;
                            bestVal = v;
                        }
                    }
                }
                if (bestVal !== 0) out[idx] = bestVal;
            }
        }
    }

    return {
        data: out,
        width: w,
        height: h,
        minY,
        maxY,
        minX,
        maxX,
        minZ,
        maxZ
    };
}

/**
 * Derive a normal map from a heightmap grid (finite differences).
 * Heightmap: Uint16Array, values 1-65535 (0 = no-data). minZ/maxZ in world units.
 * @param {Uint16Array} data - row-major height values
 * @param {number} width
 * @param {number} height
 * @param {number} minZ - world min height (meters)
 * @param {number} maxZ - world max height (meters)
 * @param {number} pixelSizeX - world units per pixel (width)
 * @param {number} pixelSizeZ - world units per pixel (height)
 * @returns {Uint8ClampedArray} RGBA 0-255, normal map (R=X*0.5+0.5, G=Y*0.5+0.5, B=Z*0.5+0.5)
 */
export function deriveNormalMapFromHeightmap(data, width, height, minZ, maxZ, pixelSizeX, pixelSizeZ) {
    const rangeZ = (maxZ - minZ) || 1;
    const out = new Uint8ClampedArray(width * height * 4);
    for (let py = 0; py < height; py++) {
        for (let px = 0; px < width; px++) {
            const idx = py * width + px;
            const v = data[idx];
            const h = v === 0 ? 0 : minZ + (v / 65535) * rangeZ;
            const left = px > 0 ? data[py * width + (px - 1)] : v;
            const right = px < width - 1 ? data[py * width + (px + 1)] : v;
            const down = py < height - 1 ? data[(py + 1) * width + px] : v;
            const up = py > 0 ? data[(py - 1) * width + px] : v;
            const hl = left === 0 ? h : minZ + (left / 65535) * rangeZ;
            const hr = right === 0 ? h : minZ + (right / 65535) * rangeZ;
            const hd = down === 0 ? h : minZ + (down / 65535) * rangeZ;
            const hu = up === 0 ? h : minZ + (up / 65535) * rangeZ;
            const dzdx = (hr - hl) / (2 * pixelSizeX) || 0;
            const dzdy = (hu - hd) / (2 * pixelSizeZ) || 0;
            const nx = -dzdx;
            const ny = -dzdy;
            const nz = 1;
            const len = Math.hypot(nx, ny, nz) || 1;
            const rx = Math.round(((nx / len) * 0.5 + 0.5) * 255);
            const ry = Math.round(((ny / len) * 0.5 + 0.5) * 255);
            const rz = Math.round(((nz / len) * 0.5 + 0.5) * 255);
            const o = idx * 4;
            out[o] = Math.max(0, Math.min(255, rx));
            out[o + 1] = Math.max(0, Math.min(255, ry));
            out[o + 2] = Math.max(0, Math.min(255, rz));
            out[o + 3] = 255;
        }
    }
    return out;
}

