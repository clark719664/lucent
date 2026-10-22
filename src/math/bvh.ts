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

const boxArea = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): number => {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const dz = z1 - z0;
  return dx < 0 ? 0 : 2 * (dx * dy + dy * dz + dz * dx);
};

/**
 * Builds a BVH over a triangle soup with a binned Surface Area Heuristic.
 *
 * Large nodes bin all three axes in one pass; small ones, the vast majority,
 * only their longest. Bounds and bins live in flat typed arrays and the
 * recursion is an explicit stack, so a million-triangle model builds without
 * allocating per triangle or per node.
 *
 * @param positions Flat xyz array, 9 floats per triangle (v0, v1, v2).
 */
export function buildBVH(positions: Float32Array, options: BVHOptions = {}): BVH {
  const opts = { ...DEFAULTS, ...options };
  const triCount = positions.length / 9;
  if (!Number.isInteger(triCount)) {
    throw new Error(`positions length ${positions.length} is not a multiple of 9`);
  }

  // Per-triangle bounds (min xyz, max xyz) and centroids, computed once.
  const tb = new Float32Array(triCount * 6);
  const cen = new Float32Array(triCount * 3);
  for (let i = 0; i < triCount; i++) {
    for (let a = 0; a < 3; a++) {
      const p0 = positions[i * 9 + a]!;
      const p1 = positions[i * 9 + 3 + a]!;
      const p2 = positions[i * 9 + 6 + a]!;
      const lo = Math.min(p0, p1, p2);
      const hi = Math.max(p0, p1, p2);
      tb[i * 6 + a] = lo;
      tb[i * 6 + 3 + a] = hi;
      cen[i * 3 + a] = (lo + hi) * 0.5;
    }
  }

  const triIndices = new Uint32Array(triCount);
  for (let i = 0; i < triCount; i++) triIndices[i] = i;

  // Worst case is 2N - 1 nodes for N triangles.
  const nodes = new Float32Array(Math.max(1, 2 * triCount - 1) * NODE_STRIDE);
  let nodeCount = 0;

  const bins = opts.bins;
  const binBox = new Float64Array(3 * bins * 6);
  const binCount = new Uint32Array(3 * bins);
  const rightArea = new Float64Array(bins);
  const rightCount = new Uint32Array(bins);
  const box = new Float64Array(6);
  const cbox = new Float64Array(6);
  const splittable = [false, false, false];

  const writeNode = (idx: number, b: Float64Array, leftFirst: number, count: number) => {
    const o = idx * NODE_STRIDE;
    nodes[o] = b[0]!;
    nodes[o + 1] = b[1]!;
    nodes[o + 2] = b[2]!;
    nodes[o + 3] = leftFirst;
    nodes[o + 4] = b[3]!;
    nodes[o + 5] = b[4]!;
    nodes[o + 6] = b[5]!;
    nodes[o + 7] = count;
  };

  /** Fills `box` with the triangles' bounds and `cbox` with their centroids' bounds. */
  const measure = (start: number, end: number) => {
    box.fill(Infinity, 0, 3).fill(-Infinity, 3, 6);
    cbox.fill(Infinity, 0, 3).fill(-Infinity, 3, 6);
    for (let i = start; i < end; i++) {
      const t = triIndices[i]!;
      for (let a = 0; a < 3; a++) {
        const lo = tb[t * 6 + a]!;
        const hi = tb[t * 6 + 3 + a]!;
        const c = cen[t * 3 + a]!;
        if (lo < box[a]!) box[a] = lo;
        if (hi > box[a + 3]!) box[a + 3] = hi;
        if (c < cbox[a]!) cbox[a] = c;
        if (c > cbox[a + 3]!) cbox[a + 3] = c;
      }
    }
  };

  const binScale = new Float64Array(3);
  const binOf = (t: number, axis: number): number =>
    Math.min(bins - 1, Math.floor((cen[t * 3 + axis]! - cbox[axis]!) * binScale[axis]!));

  /** In-place partition of triIndices[start, end) into bins <= `split` on `axis`; returns the split index. */
  const partition = (start: number, end: number, axis: number, split: number): number => {
    let i = start;
    let j = end - 1;
    while (i <= j) {
      if (binOf(triIndices[i]!, axis) <= split) {
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

  const root = nodeCount++;
  if (triCount === 0) {
    box.fill(0);
    writeNode(root, box, 0, 0);
    return { nodes: nodes.subarray(0, NODE_STRIDE), nodeCount, triIndices, bounds: new AABB([0, 0, 0], [0, 0, 0]) };
  }

  const stack: number[] = [root, 0, triCount];
  while (stack.length > 0) {
    const end = stack.pop()!;
    const start = stack.pop()!;
    const nodeIdx = stack.pop()!;
    const count = end - start;
    measure(start, end);

    if (count <= opts.maxLeafSize) {
      writeNode(nodeIdx, box, start, count);
      continue;
    }

    // Small nodes are the vast majority; binning only their longest axis keeps per-node cost low.
    const longest = cbox[3]! - cbox[0]! >= cbox[4]! - cbox[1]! && cbox[3]! - cbox[0]! >= cbox[5]! - cbox[2]! ? 0
      : cbox[4]! - cbox[1]! >= cbox[5]! - cbox[2]! ? 1 : 2;
    for (let a = 0; a < 3; a++) {
      const extent = cbox[a + 3]! - cbox[a]!;
      splittable[a] = extent > 1e-9 && (count >= 512 || a === longest);
      binScale[a] = bins / extent;
      if (!splittable[a]) continue;
      for (let k = a * bins; k < (a + 1) * bins; k++) {
        binBox.fill(Infinity, k * 6, k * 6 + 3).fill(-Infinity, k * 6 + 3, k * 6 + 6);
        binCount[k] = 0;
      }
    }
    for (let i = start; i < end; i++) {
      const t = triIndices[i]!;
      for (let a = 0; a < 3; a++) {
        if (!splittable[a]) continue;
        const k = a * bins + binOf(t, a);
        binCount[k]!++;
        const o = k * 6;
        for (let c = 0; c < 3; c++) {
          const lo = tb[t * 6 + c]!;
          const hi = tb[t * 6 + 3 + c]!;
          if (lo < binBox[o + c]!) binBox[o + c] = lo;
          if (hi > binBox[o + 3 + c]!) binBox[o + 3 + c] = hi;
        }
      }
    }

    let bestCost = Infinity;
    let bestAxis = -1;
    let bestBin = -1;
    for (let a = 0; a < 3; a++) {
      if (!splittable[a]) continue;
      // Sweep from the right to accumulate suffix areas, then from the left for prefixes.
      let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
      let n = 0;
      for (let b = bins - 1; b > 0; b--) {
        const o = (a * bins + b) * 6;
        x0 = Math.min(x0, binBox[o]!); y0 = Math.min(y0, binBox[o + 1]!); z0 = Math.min(z0, binBox[o + 2]!);
        x1 = Math.max(x1, binBox[o + 3]!); y1 = Math.max(y1, binBox[o + 4]!); z1 = Math.max(z1, binBox[o + 5]!);
        n += binCount[a * bins + b]!;
        rightArea[b] = boxArea(x0, y0, z0, x1, y1, z1);
        rightCount[b] = n;
      }
      x0 = Infinity; y0 = Infinity; z0 = Infinity; x1 = -Infinity; y1 = -Infinity; z1 = -Infinity;
      let leftN = 0;
      for (let b = 0; b < bins - 1; b++) {
        const o = (a * bins + b) * 6;
        x0 = Math.min(x0, binBox[o]!); y0 = Math.min(y0, binBox[o + 1]!); z0 = Math.min(z0, binBox[o + 2]!);
        x1 = Math.max(x1, binBox[o + 3]!); y1 = Math.max(y1, binBox[o + 4]!); z1 = Math.max(z1, binBox[o + 5]!);
        leftN += binCount[a * bins + b]!;
        const rn = rightCount[b + 1]!;
        if (leftN === 0 || rn === 0) continue;
        const cost = boxArea(x0, y0, z0, x1, y1, z1) * leftN + rightArea[b + 1]! * rn;
        if (cost < bestCost) {
          bestCost = cost;
          bestAxis = a;
          bestBin = b;
        }
      }
    }

    // SAH cost of a leaf is `count * area`. Stop when a split is unprofitable,
    // but never let a leaf grow unbounded (coincident centroids, flat SAH).
    const leafCost = count * boxArea(box[0]!, box[1]!, box[2]!, box[3]!, box[4]!, box[5]!);
    const unprofitable = bestAxis < 0 || bestCost >= leafCost;
    if (unprofitable && count <= opts.maxLeafSize * 4) {
      writeNode(nodeIdx, box, start, count);
      continue;
    }

    let mid = unprofitable ? (start + end) >> 1 : partition(start, end, bestAxis, bestBin);
    // A partition that moves nothing would loop forever; fall back to a median split.
    if (mid === start || mid === end) mid = (start + end) >> 1;

    const left = nodeCount++;
    const right = nodeCount++;
    writeNode(nodeIdx, box, left, 0);
    // Right is pushed first so the left subtree is built (and numbered) first.
    stack.push(right, mid, end, left, start, mid);
  }

  measure(0, triCount);
  return {
    nodes: nodes.subarray(0, nodeCount * NODE_STRIDE),
    nodeCount,
    triIndices,
    bounds: new AABB([box[0]!, box[1]!, box[2]!], [box[3]!, box[4]!, box[5]!]),
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
