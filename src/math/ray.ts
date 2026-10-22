import type { Vec3 } from './vec3';
import { cross, dot, sub } from './vec3';

export interface Ray {
  origin: Vec3;
  dir: Vec3;
}

export interface TriangleHit {
  /** Distance along the ray. */
  t: number;
  /** Barycentric coordinates of v1 and v2 (v0 weight is 1 - u - v). */
  u: number;
  v: number;
}

/**
 * Möller–Trumbore ray/triangle intersection. Two-sided; returns `null` on a
 * miss or when the hit is outside (tMin, tMax). Mirrors the GLSL version so
 * CPU picking and GPU rendering agree on what the camera is looking at.
 */
export function intersectTriangle(
  ray: Ray,
  v0: Vec3,
  v1: Vec3,
  v2: Vec3,
  tMin = 1e-5,
  tMax = Infinity,
): TriangleHit | null {
  const e1 = sub(v1, v0);
  const e2 = sub(v2, v0);
  const p = cross(ray.dir, e2);
  const det = dot(e1, p);
  if (Math.abs(det) < 1e-12) return null;
  const invDet = 1 / det;
  const s = sub(ray.origin, v0);
  const u = dot(s, p) * invDet;
  if (u < 0 || u > 1) return null;
  const q = cross(s, e1);
  const v = dot(ray.dir, q) * invDet;
  if (v < 0 || u + v > 1) return null;
  const t = dot(e2, q) * invDet;
  if (t <= tMin || t >= tMax) return null;
  return { t, u, v };
}

/** Analytic ray/sphere intersection returning the nearest valid root, or `null`. */
export function intersectSphere(
  ray: Ray,
  center: Vec3,
  radius: number,
  tMin = 1e-5,
  tMax = Infinity,
): number | null {
  const oc = sub(ray.origin, center);
  const b = dot(oc, ray.dir);
  const c = dot(oc, oc) - radius * radius;
  const disc = b * b - c;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  let t = -b - sq;
  if (t <= tMin || t >= tMax) {
    t = -b + sq;
    if (t <= tMin || t >= tMax) return null;
  }
  return t;
}
