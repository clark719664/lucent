import { describe, expect, it } from 'vitest';
import { AABB } from '../src/math/aabb';

describe('AABB', () => {
  it('starts empty and grows to contain points', () => {
    const b = AABB.empty();
    expect(b.isEmpty).toBe(true);
    expect(b.surfaceArea()).toBe(0);
    b.expandPoint([1, 2, 3]).expandPoint([-1, 0, 5]);
    expect(b.min).toEqual([-1, 0, 3]);
    expect(b.max).toEqual([1, 2, 5]);
    expect(b.centroid()).toEqual([0, 1, 4]);
    expect(b.surfaceArea()).toBe(2 * (2 * 2 + 2 * 2 + 2 * 2));
  });

  it('picks the longest axis', () => {
    expect(new AABB([0, 0, 0], [1, 5, 2]).longestAxis()).toBe(1);
    expect(new AABB([0, 0, 0], [1, 1, 9]).longestAxis()).toBe(2);
  });

  it('slab test returns entry distance or Infinity', () => {
    const b = new AABB([-1, -1, -1], [1, 1, 1]);
    const inv = (d: [number, number, number]): [number, number, number] => [1 / d[0], 1 / d[1], 1 / d[2]];
    expect(b.intersect([0, 0, -5], inv([0, 0, 1]), Infinity)).toBeCloseTo(4);
    expect(b.intersect([0, 0, -5], inv([0, 0, -1]), Infinity)).toBe(Infinity);
    expect(b.intersect([5, 5, -5], inv([0, 0, 1]), Infinity)).toBe(Infinity);
    // Axis-parallel ray with zero components must not produce NaN.
    expect(b.intersect([0.5, 0.5, -5], inv([0, 0, 1]), Infinity)).toBeCloseTo(4);
    // Box beyond tMax is a miss.
    expect(b.intersect([0, 0, -5], inv([0, 0, 1]), 2)).toBe(Infinity);
    // Ray starting inside returns 0.
    expect(b.intersect([0, 0, 0], inv([1, 0, 0]), Infinity)).toBe(0);
  });
});
