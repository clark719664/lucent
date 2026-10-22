import { describe, expect, it } from 'vitest';
import { box, floor, mergeMeshes, quad, torusKnot, transform, triangleCount } from '../src/scene/mesh';

/** Counts directed edges; a closed 2-manifold has every edge used exactly twice, once per direction. */
function isClosed(positions: Float32Array): boolean {
  const key = (i: number) => `${positions[i]!.toFixed(5)},${positions[i + 1]!.toFixed(5)},${positions[i + 2]!.toFixed(5)}`;
  const edges = new Map<string, number>();
  for (let t = 0; t < positions.length; t += 9) {
    const v = [key(t), key(t + 3), key(t + 6)];
    for (let e = 0; e < 3; e++) {
      const a = v[e]!;
      const b = v[(e + 1) % 3]!;
      edges.set(`${a}|${b}`, (edges.get(`${a}|${b}`) ?? 0) + 1);
    }
  }
  for (const [k, n] of edges) {
    if (n !== 1) return false;
    const [a, b] = k.split('|');
    if (edges.get(`${b}|${a}`) !== 1) return false;
  }
  return true;
}

describe('mesh generators', () => {
  it('quad has two triangles and a consistent normal', () => {
    const q = quad([0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]);
    expect(triangleCount(q)).toBe(2);
    expect(Array.from(q.normals.subarray(0, 3))).toEqual([0, 0, 1]);
  });

  it('floor faces +Y', () => {
    const f = floor([0, 0, 0], 1);
    expect(Array.from(f.normals.subarray(0, 3)).map((x) => Math.round(x) + 0)).toEqual([0, 1, 0]);
  });

  it('box is a closed surface with outward normals (inward when requested)', () => {
    const b = box([-1, -1, -1], [1, 1, 1]);
    expect(triangleCount(b)).toBe(12);
    expect(isClosed(b.positions)).toBe(true);
    // Every face normal should point away from the centre.
    for (let t = 0; t < b.positions.length; t += 9) {
      const n = [b.normals[t]!, b.normals[t + 1]!, b.normals[t + 2]!];
      const p = [b.positions[t]!, b.positions[t + 1]!, b.positions[t + 2]!];
      expect(n[0]! * p[0]! + n[1]! * p[1]! + n[2]! * p[2]!).toBeGreaterThan(0);
    }
    const inward = box([-1, -1, -1], [1, 1, 1], true);
    expect(inward.normals[1]! * b.normals[1]! <= 0 || inward.normals[0]! * b.normals[0]! <= 0 || inward.normals[2]! * b.normals[2]! <= 0).toBe(true);
  });

  it('torus knot is closed and has unit normals', () => {
    const k = torusKnot({ tubularSegments: 40, radialSegments: 8 });
    expect(triangleCount(k)).toBe(40 * 8 * 2);
    expect(isClosed(k.positions)).toBe(true);
    for (let i = 0; i < k.normals.length; i += 3) {
      const l = Math.hypot(k.normals[i]!, k.normals[i + 1]!, k.normals[i + 2]!);
      expect(l).toBeCloseTo(1, 4);
    }
  });

  it('transform scales, rotates and translates positions but only rotates normals', () => {
    const q = quad([0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]);
    const t = transform(q, { scale: 2, rotateY: Math.PI / 2, translate: [5, 0, 0] });
    // (1,0,0) → scale → (2,0,0) → rotateY(90°) → (0,0,-2) → translate → (5,0,-2)
    expect(t.positions[3]).toBeCloseTo(5);
    expect(t.positions[4]).toBeCloseTo(0);
    expect(t.positions[5]).toBeCloseTo(-2);
    // Normal (0,0,1) → rotateY(90°) → (1,0,0), unchanged by scale/translate.
    expect(t.normals[0]).toBeCloseTo(1);
    expect(t.normals[2]).toBeCloseTo(0);
  });

  it('merges meshes preserving order', () => {
    const a = quad([0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]);
    const b = floor([0, 0, 0], 1);
    const m = mergeMeshes([a, b]);
    expect(triangleCount(m)).toBe(4);
    expect(m.positions[0]).toBe(a.positions[0]);
    expect(m.positions[18]).toBe(b.positions[0]);
  });
});
