import type { Vec3 } from './vec3';

/** Axis-aligned bounding box. Mutable on purpose: the BVH builder grows these in place. */
export class AABB {
  constructor(
    public min: [number, number, number] = [Infinity, Infinity, Infinity],
    public max: [number, number, number] = [-Infinity, -Infinity, -Infinity],
  ) {}

  static empty(): AABB {
    return new AABB();
  }

  static fromPoints(points: Iterable<Vec3>): AABB {
    const box = new AABB();
    for (const p of points) box.expandPoint(p);
    return box;
  }

  get isEmpty(): boolean {
    return this.min[0] > this.max[0];
  }

  clone(): AABB {
    return new AABB([...this.min], [...this.max]);
  }

  expandPoint(p: Vec3): this {
    if (p[0] < this.min[0]) this.min[0] = p[0];
    if (p[1] < this.min[1]) this.min[1] = p[1];
    if (p[2] < this.min[2]) this.min[2] = p[2];
    if (p[0] > this.max[0]) this.max[0] = p[0];
    if (p[1] > this.max[1]) this.max[1] = p[1];
    if (p[2] > this.max[2]) this.max[2] = p[2];
    return this;
  }

  expandBox(b: AABB): this {
    if (b.isEmpty) return this;
    this.expandPoint(b.min);
    this.expandPoint(b.max);
    return this;
  }

  centroid(): Vec3 {
    return [
      (this.min[0] + this.max[0]) * 0.5,
      (this.min[1] + this.max[1]) * 0.5,
      (this.min[2] + this.max[2]) * 0.5,
    ];
  }

  extent(): Vec3 {
    return [this.max[0] - this.min[0], this.max[1] - this.min[1], this.max[2] - this.min[2]];
  }

  /** Index (0, 1, 2) of the longest axis. */
  longestAxis(): 0 | 1 | 2 {
    const e = this.extent();
    if (e[0] >= e[1] && e[0] >= e[2]) return 0;
    return e[1] >= e[2] ? 1 : 2;
  }

  /** Surface area, the cost metric used by the SAH builder. Zero for empty boxes. */
  surfaceArea(): number {
    if (this.isEmpty) return 0;
    const [x, y, z] = this.extent();
    return 2 * (x * y + y * z + z * x);
  }

  containsPoint(p: Vec3): boolean {
    return (
      p[0] >= this.min[0] && p[0] <= this.max[0] &&
      p[1] >= this.min[1] && p[1] <= this.max[1] &&
      p[2] >= this.min[2] && p[2] <= this.max[2]
    );
  }

  /**
   * Slab test. Returns the entry distance along the ray, or `Infinity` if the
   * ray misses or the box lies entirely beyond `tMax`. `invDir` is 1 / dir,
   * precomputed by the caller; IEEE infinities make zero components safe.
   */
  intersect(origin: Vec3, invDir: Vec3, tMax: number): number {
    let tmin = 0;
    let tmax = tMax;
    for (let i = 0; i < 3; i++) {
      const o = origin[i] as number;
      const inv = invDir[i] as number;
      let t0 = (this.min[i]! - o) * inv;
      let t1 = (this.max[i]! - o) * inv;
      if (t0 > t1) [t0, t1] = [t1, t0];
      if (t0 > tmin) tmin = t0;
      if (t1 < tmax) tmax = t1;
      if (tmax < tmin) return Infinity;
    }
    return tmin;
  }
}
