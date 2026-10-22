import { describe, expect, it } from 'vitest';
import { buildBVH, intersectAllTriangles, intersectBVH, NODE_STRIDE } from '../src/math/bvh';
import { normalize, type Vec3 } from '../src/math/vec3';
import { torusKnot, triangleCount } from '../src/scene/mesh';

/** Deterministic LCG so failures are reproducible. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function randomSoup(count: number, rand: () => number): Float32Array {
  const out = new Float32Array(count * 9);
  for (let i = 0; i < count; i++) {
    const cx = rand() * 10 - 5;
    const cy = rand() * 10 - 5;
    const cz = rand() * 10 - 5;
    for (let k = 0; k < 3; k++) {
      out[i * 9 + k * 3] = cx + rand() - 0.5;
      out[i * 9 + k * 3 + 1] = cy + rand() - 0.5;
      out[i * 9 + k * 3 + 2] = cz + rand() - 0.5;
    }
  }
  return out;
}

describe('buildBVH', () => {
  it('handles an empty soup', () => {
    const bvh = buildBVH(new Float32Array(0));
    expect(bvh.nodeCount).toBe(1);
    expect(intersectBVH(bvh, new Float32Array(0), { origin: [0, 0, 0], dir: [0, 0, 1] })).toBeNull();
  });

  it('builds a single leaf for tiny inputs', () => {
    const tri = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const bvh = buildBVH(tri);
    expect(bvh.nodeCount).toBe(1);
    expect(bvh.nodes[7]).toBe(1); // count
    expect(bvh.nodes[3]).toBe(0); // first
  });

  it('references every triangle exactly once across its leaves', () => {
    const soup = randomSoup(500, rng(7));
    const bvh = buildBVH(soup);
    const seen = new Uint8Array(500);
    for (let n = 0; n < bvh.nodeCount; n++) {
      const count = bvh.nodes[n * NODE_STRIDE + 7]!;
      const first = bvh.nodes[n * NODE_STRIDE + 3]!;
      for (let i = 0; i < count; i++) {
        const tri = bvh.triIndices[first + i]!;
        expect(seen[tri]).toBe(0);
        seen[tri] = 1;
      }
    }
    expect(seen.every((v) => v === 1)).toBe(true);
  });

  it('keeps children adjacent and bounds nested', () => {
    const soup = randomSoup(300, rng(3));
    const bvh = buildBVH(soup);
    for (let n = 0; n < bvh.nodeCount; n++) {
      const o = n * NODE_STRIDE;
      if (bvh.nodes[o + 7] !== 0) continue;
      const left = bvh.nodes[o + 3]!;
      for (const child of [left, left + 1]) {
        const c = child * NODE_STRIDE;
        for (let a = 0; a < 3; a++) {
          expect(bvh.nodes[c + a]!).toBeGreaterThanOrEqual(bvh.nodes[o + a]! - 1e-6);
          expect(bvh.nodes[c + 4 + a]!).toBeLessThanOrEqual(bvh.nodes[o + 4 + a]! + 1e-6);
        }
      }
    }
  });

  it('survives degenerate input where every centroid coincides', () => {
    // 64 copies of the same triangle: SAH can't split, median split must terminate.
    const one = [0, 0, 0, 1, 0, 0, 0, 1, 0];
    const soup = new Float32Array(Array.from({ length: 64 }, () => one).flat());
    const bvh = buildBVH(soup, { maxLeafSize: 4 });
    expect(bvh.nodeCount).toBeGreaterThan(1);
    const hit = intersectBVH(bvh, soup, { origin: [0.2, 0.2, -1], dir: [0, 0, 1] });
    expect(hit?.t).toBeCloseTo(1);
  });
});

describe('intersectBVH', () => {
  it('agrees with brute force on random rays through a random soup', () => {
    const rand = rng(42);
    const soup = randomSoup(2000, rand);
    const bvh = buildBVH(soup);
    let hits = 0;
    for (let i = 0; i < 400; i++) {
      const origin: Vec3 = [rand() * 16 - 8, rand() * 16 - 8, rand() * 16 - 8];
      const dir = normalize([rand() - 0.5, rand() - 0.5, rand() - 0.5]);
      const a = intersectBVH(bvh, soup, { origin, dir });
      const b = intersectAllTriangles(soup, { origin, dir });
      if (b) {
        hits++;
        expect(a).not.toBeNull();
        expect(a!.t).toBeCloseTo(b.t, 5);
        expect(a!.triIndex).toBe(b.triIndex);
      } else {
        expect(a).toBeNull();
      }
    }
    expect(hits).toBeGreaterThan(50);
  });

  it('agrees with brute force on a real mesh', () => {
    const mesh = torusKnot({ tubularSegments: 80, radialSegments: 10 });
    expect(triangleCount(mesh)).toBe(1600);
    const bvh = buildBVH(mesh.positions);
    const rand = rng(99);
    for (let i = 0; i < 200; i++) {
      const origin: Vec3 = [rand() * 6 - 3, rand() * 6 - 3, 4];
      const dir = normalize([rand() * 0.4 - 0.2, rand() * 0.4 - 0.2, -1]);
      const a = intersectBVH(bvh, mesh.positions, { origin, dir });
      const b = intersectAllTriangles(mesh.positions, { origin, dir });
      expect(a?.t ?? null).toBe(b?.t ?? null);
    }
  });

  it('respects tMax', () => {
    const soup = randomSoup(100, rng(5));
    const bvh = buildBVH(soup);
    const ref = intersectAllTriangles(soup, { origin: [0, 0, -20], dir: [0, 0, 1] });
    if (!ref) return;
    expect(intersectBVH(bvh, soup, { origin: [0, 0, -20], dir: [0, 0, 1] }, 1e-5, ref.t * 0.5)).toBeNull();
  });
});
