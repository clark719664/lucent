import { AABB } from './aabb';
import { buildBVH, type BVH } from './bvh';

/** Below this, a worker's start-up costs more than the build it saves. */
const WORKER_THRESHOLD = 50_000;

/** Builds the BVH on a worker thread for large inputs so the page keeps rendering. */
export function buildBVHAsync(positions: Float32Array): Promise<BVH> {
  if (positions.length / 9 < WORKER_THRESHOLD || typeof Worker === 'undefined') {
    return Promise.resolve(buildBVH(positions));
  }
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./bvh.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent) => {
      worker.terminate();
      const d = e.data as { nodes: Float32Array; nodeCount: number; triIndices: Uint32Array; min: number[]; max: number[] };
      resolve({
        nodes: d.nodes,
        nodeCount: d.nodeCount,
        triIndices: d.triIndices,
        bounds: new AABB([d.min[0]!, d.min[1]!, d.min[2]!], [d.max[0]!, d.max[1]!, d.max[2]!]),
      });
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(`BVH worker failed: ${e.message}`));
    };
    const copy = positions.slice();
    worker.postMessage(copy, [copy.buffer]);
  });
}
