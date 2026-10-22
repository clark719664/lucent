import { AABB } from './aabb';
import type { Ray } from './ray';
import { intersectTriangle } from './ray';
import type { Vec3 } from './vec3';

/**
 * Flattened BVH node layout, 8 floats per node, matching the GPU texture:
 *
 *   [minX, minY, minZ, leftFirst, maxX, maxY, maxZ, count]
 *
 * - `count > 0`  → leaf: `count` triangles starting at `leftFirst` in `triIndices`.
 * - `count == 0` → interior: left child at `leftFirst`, right child at `leftFirst + 1`.
 *
 * Children are always allocated as a pair so the right child never needs its own slot.
 */
export const NODE_STRIDE = 8;

export interface BVH {
  nodes: Float32Array;
  nodeCount: number;
  /** Triangle indices, reordered so each leaf's triangles are contiguous. */
  triIndices: Uint32Array;
  bounds: AABB;
}

export interface BVHOptions {
  /** Maximum triangles per leaf. */
  maxLeafSize?: number;
  /** Number of SAH bins per axis. */
  bins?: number;
}

const DEFAULTS: Required<BVHOptions> = { maxLeafSize: 4, bins: 12 };

/**
 * Builds a BVH over a triangle soup with a binned Surface Area Heuristic.
 *
 * @param positions Flat xyz array, 9 floats per triangle (v0, v1, v2).
 */
export function buildBVH(positions: Float32Array, options: BVHOptions = {}): BVH {
  const opts = { ...DEFAULTS, ...options };
  const triCount = positions.length / 9;
  if (!Number.isInteger(triCount)) {
    throw new Error(`positions length ${positions.length} is not a multiple of 9`);
  }

  // Precompute per-triangle bounds and centroids once.
  const triBounds: AABB[] = new Array(triCount);
  const centroids = new Float32Array(triCount * 3);
  for (let i = 0; i < triCount; i++) {
    const b = new AABB();
    for (let k = 0; k < 3; k++) {
      const o = i * 9 + k * 3;
      b.expandPoint([positions[o]!, positions[o + 1]!, positions[o + 2]!]);
    }
    triBounds[i] = b;
    const c = b.centroid();
    centroids[i * 3] = c[0];
    centroids[i * 3 + 1] = c[1];
    centroids[i * 3 + 2] = c[2];
  }

  const triIndices = new Uint32Array(triCount);
  for (let i = 0; i < triCount; i++) triIndices[i] = i;

  // Worst case is 2N - 1 nodes for N triangles.
  const nodes = new Float32Array(Math.max(1, 2 * triCount - 1) * NODE_STRIDE);
  let nodeCount = 0;

  const allocNode = (): number => nodeCount++;

  const writeNode = (idx: number, box: AABB, leftFirst: number, count: number) => {
    const o = idx * NODE_STRIDE;
    nodes[o] = box.min[0];
    nodes[o + 1] = box.min[1];
    nodes[o + 2] = box.min[2];
    nodes[o + 3] = leftFirst;
    nodes[o + 4] = box.max[0];
    nodes[o + 5] = box.max[1];
    nodes[o + 6] = box.max[2];
    nodes[o + 7] = count;
  };

  const rangeBounds = (start: number, end: number): AABB => {
    const box = new AABB();
    for (let i = start; i < end; i++) box.expandBox(triBounds[triIndices[i]!]!);
    return box;
  };

  const centroidBounds = (start: number, end: number): AABB => {
    const box = new AABB();
    for (let i = start; i < end; i++) {
      const t = triIndices[i]! * 3;
      box.expandPoint([centroids[t]!, centroids[t + 1]!, centroids[t + 2]!]);
    }
    return box;
  };

  interface Split {
    axis: number;
    position: number;
    cost: number;
  }

  /** Evaluate binned SAH on the longest centroid axis; returns the cheapest split. */
  const findBestSplit = (start: number, end: number, cb: AABB): Split | null => {
    const axis = cb.longestAxis();
    const lo = cb.min[axis];
    const hi = cb.max[axis];
    if (hi - lo < 1e-9) return null;

    const binCount = opts.bins;
    const binBounds: AABB[] = Array.from({ length: binCount }, () => new AABB());
    const binCounts = new Uint32Array(binCount);
    const scale = binCount / (hi - lo);

    for (let i = start; i < end; i++) {
      const tri = triIndices[i]!;
      const c = centroids[tri * 3 + axis]!;
      const b = Math.min(binCount - 1, Math.floor((c - lo) * scale));
      binCounts[b]!++;
      binBounds[b]!.expandBox(triBounds[tri]!);
    }

    // Sweep from the right to accumulate suffix bounds, then from the left for prefixes.
    const rightArea = new Float64Array(binCount);
    const rightCount = new Uint32Array(binCount);
    const acc = new AABB();
    let n = 0;
    for (let b = binCount - 1; b > 0; b--) {
      acc.expandBox(binBounds[b]!);
      n += binCounts[b]!;
      rightArea[b] = acc.surfaceArea();
      rightCount[b] = n;
    }

    let best: Split | null = null;
    const leftAcc = new AABB();
    let leftN = 0;
    for (let b = 0; b < binCount - 1; b++) {
      leftAcc.expandBox(binBounds[b]!);
      leftN += binCounts[b]!;
      const rn = rightCount[b + 1]!;
      if (leftN === 0 || rn === 0) continue;
      const cost = leftAcc.surfaceArea() * leftN + rightArea[b + 1]! * rn;
      if (best === null || cost < best.cost) {
        best = { axis, position: lo + ((b + 1) / binCount) * (hi - lo), cost };
      }
    }
    return best;
  };

  /** In-place partition of triIndices[start, end) by centroid; returns the split index. */
  const partition = (start: number, end: number, axis: number, pos: number): number => {
    let i = start;
    let j = end - 1;
    while (i <= j) {
      if (centroids[triIndices[i]! * 3 + axis]! < pos) {
        i++;
      } else {
        const tmp = triIndices[i]!;
        triIndices[i] = triIndices[j]!;
        triIndices[j] = tmp;
        j--;
      }
    }
    return i;
  };

  const build = (nodeIdx: number, start: number, end: number): void => {
    const count = end - start;
    const box = rangeBounds(start, end);

    if (count <= opts.maxLeafSize) {
      writeNode(nodeIdx, box, start, count);
      return;
    }

    const cb = centroidBounds(start, end);
    const split = findBestSplit(start, end, cb);

    // SAH cost of a leaf is `count * area`. Stop when a split is unprofitable,
    // but never let a leaf grow unbounded (coincident centroids, flat SAH).
    const leafCost = count * box.surfaceArea();
    const unprofitable = split === null || split.cost >= leafCost;
    if (unprofitable && count <= opts.maxLeafSize * 4) {
      writeNode(nodeIdx, box, start, count);
      return;
    }

    let mid = unprofitable ? (start + end) >> 1 : partition(start, end, split.axis, split.position);
    // A partition that moves nothing would recurse forever; fall back to a median split.
    if (mid === start || mid === end) mid = (start + end) >> 1;

    const left = allocNode();
    const right = allocNode();
    if (right !== left + 1) throw new Error('BVH invariant violated: children not adjacent');
    writeNode(nodeIdx, box, left, 0);
    build(left, start, mid);
    build(right, mid, end);
  };

  const root = allocNode();
  if (triCount === 0) {
    writeNode(root, new AABB([0, 0, 0], [0, 0, 0]), 0, 0);
  } else {
    build(root, 0, triCount);
  }

  return {
    nodes: nodes.subarray(0, nodeCount * NODE_STRIDE),
    nodeCount,
    triIndices,
    bounds: triCount === 0 ? new AABB([0, 0, 0], [0, 0, 0]) : rangeBounds(0, triCount),
  };
}

export interface BVHHit {
  t: number;
  triIndex: number;
  u: number;
  v: number;
}

/**
 * Closest-hit traversal using an explicit stack. Used for CPU-side picking and
 * as the reference the GPU traversal is validated against in tests.
 */
export function intersectBVH(
  bvh: BVH,
  positions: Float32Array,
  ray: Ray,
  tMin = 1e-5,
  tMax = Infinity,
): BVHHit | null {
  const { nodes, triIndices } = bvh;
  // An empty BVH has a single placeholder node that must never be traversed.
  if (triIndices.length === 0) return null;
  const invDir: Vec3 = [1 / ray.dir[0], 1 / ray.dir[1], 1 / ray.dir[2]];
  const stack = new Int32Array(64);
  let sp = 0;
  stack[sp++] = 0;
  let best: BVHHit | null = null;
  let closest = tMax;
  const box = new AABB();

  while (sp > 0) {
    const n = stack[--sp]!;
    const o = n * NODE_STRIDE;
    box.min[0] = nodes[o]!;
    box.min[1] = nodes[o + 1]!;
    box.min[2] = nodes[o + 2]!;
    box.max[0] = nodes[o + 4]!;
    box.max[1] = nodes[o + 5]!;
    box.max[2] = nodes[o + 6]!;
    if (box.intersect(ray.origin, invDir, closest) === Infinity) continue;

    const leftFirst = nodes[o + 3]!;
    const count = nodes[o + 7]!;
    if (count > 0) {
      for (let i = 0; i < count; i++) {
        const tri = triIndices[leftFirst + i]!;
        const p = tri * 9;
        const hit = intersectTriangle(
          ray,
          [positions[p]!, positions[p + 1]!, positions[p + 2]!],
          [positions[p + 3]!, positions[p + 4]!, positions[p + 5]!],
          [positions[p + 6]!, positions[p + 7]!, positions[p + 8]!],
          tMin,
          closest,
        );
        if (hit) {
          closest = hit.t;
          best = { t: hit.t, triIndex: tri, u: hit.u, v: hit.v };
        }
      }
    } else {
      // Push both children; the far one first so the near one is popped next.
      stack[sp++] = leftFirst + 1;
      stack[sp++] = leftFirst;
    }
  }
  return best;
}

/** Brute-force reference used by tests. */
export function intersectAllTriangles(
  positions: Float32Array,
  ray: Ray,
  tMin = 1e-5,
  tMax = Infinity,
): BVHHit | null {
  let best: BVHHit | null = null;
  let closest = tMax;
  const triCount = positions.length / 9;
  for (let tri = 0; tri < triCount; tri++) {
    const p = tri * 9;
    const hit = intersectTriangle(
      ray,
      [positions[p]!, positions[p + 1]!, positions[p + 2]!],
      [positions[p + 3]!, positions[p + 4]!, positions[p + 5]!],
      [positions[p + 6]!, positions[p + 7]!, positions[p + 8]!],
      tMin,
      closest,
    );
    if (hit) {
      closest = hit.t;
      best = { t: hit.t, triIndex: tri, u: hit.u, v: hit.v };
    }
  }
  return best;
}
