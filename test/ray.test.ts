import { describe, expect, it } from 'vitest';
import { intersectSphere, intersectTriangle } from '../src/math/ray';

describe('intersectTriangle', () => {
  const v0 = [-1, -1, 0] as const;
  const v1 = [1, -1, 0] as const;
  const v2 = [0, 1, 0] as const;

  it('hits from both sides with correct barycentrics', () => {
    const front = intersectTriangle({ origin: [0, 0, -3], dir: [0, 0, 1] }, v0, v1, v2);
    expect(front?.t).toBeCloseTo(3);
    const back = intersectTriangle({ origin: [0, 0, 3], dir: [0, 0, -1] }, v0, v1, v2);
    expect(back?.t).toBeCloseTo(3);
    // Centroid of the triangle has u = v = 1/3.
    const c = intersectTriangle({ origin: [0, -1 / 3, -1], dir: [0, 0, 1] }, v0, v1, v2);
    expect(c?.u).toBeCloseTo(1 / 3);
    expect(c?.v).toBeCloseTo(1 / 3);
  });

  it('misses outside the edges, behind the origin and beyond tMax', () => {
    expect(intersectTriangle({ origin: [2, 2, -1], dir: [0, 0, 1] }, v0, v1, v2)).toBeNull();
    expect(intersectTriangle({ origin: [0, 0, -1], dir: [0, 0, -1] }, v0, v1, v2)).toBeNull();
    expect(intersectTriangle({ origin: [0, 0, -3], dir: [0, 0, 1] }, v0, v1, v2, 1e-5, 2)).toBeNull();
  });

  it('rejects rays parallel to the plane', () => {
    expect(intersectTriangle({ origin: [0, 0, 0], dir: [1, 0, 0] }, v0, v1, v2)).toBeNull();
  });
});

describe('intersectSphere', () => {
  it('returns the nearest root, or the far root from inside', () => {
    expect(intersectSphere({ origin: [0, 0, -5], dir: [0, 0, 1] }, [0, 0, 0], 1)).toBeCloseTo(4);
    expect(intersectSphere({ origin: [0, 0, 0], dir: [0, 0, 1] }, [0, 0, 0], 1)).toBeCloseTo(1);
    expect(intersectSphere({ origin: [0, 5, -5], dir: [0, 0, 1] }, [0, 0, 0], 1)).toBeNull();
    expect(intersectSphere({ origin: [0, 0, 5], dir: [0, 0, 1] }, [0, 0, 0], 1)).toBeNull();
  });
});
