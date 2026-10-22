import { describe, expect, it } from 'vitest';
import { add, approxEqual, cross, dot, fromSpherical, hexToRgb, length, normalize, sub } from '../src/math/vec3';

describe('vec3', () => {
  it('does basic arithmetic', () => {
    expect(add([1, 2, 3], [4, 5, 6])).toEqual([5, 7, 9]);
    expect(sub([1, 2, 3], [4, 5, 6])).toEqual([-3, -3, -3]);
    expect(dot([1, 0, 0], [0, 1, 0])).toBe(0);
    expect(cross([1, 0, 0], [0, 1, 0])).toEqual([0, 0, 1]);
  });

  it('normalizes and tolerates the zero vector', () => {
    expect(length(normalize([3, 4, 0]))).toBeCloseTo(1);
    expect(normalize([0, 0, 0])).toEqual([0, 0, 0]);
  });

  it('maps spherical coordinates with Y up', () => {
    expect(approxEqual(fromSpherical(Math.PI / 2, 0), [0, 1, 0])).toBe(true);
    expect(approxEqual(fromSpherical(0, 0), [0, 0, 1])).toBe(true);
    expect(approxEqual(fromSpherical(0, Math.PI / 2), [1, 0, 0])).toBe(true);
  });

  it('parses hex colours', () => {
    expect(hexToRgb('#ff0000')).toEqual([1, 0, 0]);
    expect(hexToRgb('0f0')).toEqual([0, 1, 0]);
  });
});
