import { buildBVH } from './bvh';

interface WorkerScope {
  onmessage: ((e: MessageEvent<Float32Array>) => void) | null;
  postMessage(message: unknown, transfer: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;

scope.onmessage = (e) => {
  const bvh = buildBVH(e.data);
  // `nodes` is a view into an oversized buffer; copy it so only what is used crosses back.
  const nodes = bvh.nodes.slice();
  scope.postMessage(
    { nodes, nodeCount: bvh.nodeCount, triIndices: bvh.triIndices, min: bvh.bounds.min, max: bvh.bounds.max },
    [nodes.buffer, bvh.triIndices.buffer],
  );
};
