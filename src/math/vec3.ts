/**
 * Minimal immutable 3-vector utilities.
 *
 * Vectors are plain readonly tuples so they serialize trivially, structurally
 * compare in tests, and never carry hidden state. Hot loops (BVH build,
 * intersection) work on `Float32Array` views instead and only touch these
 * helpers at the edges.
 */
export type Vec3 = readonly [number, number, number];

export const vec3 = (x: number, y: number, z: number): Vec3 => [x, y, z];
export const ZERO: Vec3 = [0, 0, 0];
export const ONE: Vec3 = [1, 1, 1];

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const mul = (a: Vec3, b: Vec3): Vec3 => [a[0] * b[0], a[1] * b[1], a[2] * b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const neg = (a: Vec3): Vec3 => [-a[0], -a[1], -a[2]];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const length = (a: Vec3): number => Math.sqrt(dot(a, a));
export const distance = (a: Vec3, b: Vec3): number => length(sub(a, b));

export function normalize(a: Vec3): Vec3 {
  const len = length(a);
  if (len === 0) return ZERO;
  return scale(a, 1 / len);
}

export const min = (a: Vec3, b: Vec3): Vec3 => [
  Math.min(a[0], b[0]),
  Math.min(a[1], b[1]),
  Math.min(a[2], b[2]),
];
export const max = (a: Vec3, b: Vec3): Vec3 => [
  Math.max(a[0], b[0]),
  Math.max(a[1], b[1]),
  Math.max(a[2], b[2]),
];

export const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

/** Approximate equality with an absolute epsilon per component. */
export const approxEqual = (a: Vec3, b: Vec3, eps = 1e-6): boolean =>
  Math.abs(a[0] - b[0]) <= eps && Math.abs(a[1] - b[1]) <= eps && Math.abs(a[2] - b[2]) <= eps;

/** Spherical to cartesian; `elevation` and `azimuth` in radians, Y is up. */
export function fromSpherical(elevation: number, azimuth: number): Vec3 {
  const c = Math.cos(elevation);
  return [c * Math.sin(azimuth), Math.sin(elevation), c * Math.cos(azimuth)];
}

/** Hex colour string ("#rrggbb") to a linear-ish RGB triple in [0, 1]. */
export function hexToRgb(hex: string): Vec3 {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
