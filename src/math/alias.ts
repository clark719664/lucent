/**
 * Walker's alias method, built with Vose's numerically stable algorithm.
 *
 * Sampling is O(1): pick bucket `i` uniformly, keep it with probability
 * `prob[i]`, otherwise take `alias[i]`. The GPU environment sampler uses this
 * so that an HDRI sample costs one texel fetch instead of a binary search.
 */
export interface AliasTable {
  prob: Float32Array;
  alias: Uint32Array;
  /** Normalised probability of each bucket. */
  pmf: Float64Array;
  /** Sum of the input weights; 0 means the table fell back to uniform. */
  total: number;
}

export function buildAliasTable(weights: ArrayLike<number>): AliasTable {
  const n = weights.length;
  if (n === 0) throw new Error('alias table needs at least one weight');

  let total = 0;
  for (let i = 0; i < n; i++) {
    const w = weights[i]!;
    if (!(w >= 0) || !Number.isFinite(w)) throw new Error(`weight ${i} is ${w}; weights must be finite and >= 0`);
    total += w;
  }

  const pmf = new Float64Array(n);
  for (let i = 0; i < n; i++) pmf[i] = total > 0 ? weights[i]! / total : 1 / n;

  const scaled = new Float64Array(n);
  const small = new Uint32Array(n);
  const large = new Uint32Array(n);
  let ns = 0;
  let nl = 0;
  for (let i = 0; i < n; i++) {
    scaled[i] = pmf[i]! * n;
    if (scaled[i]! < 1) small[ns++] = i;
    else large[nl++] = i;
  }

  const prob = new Float32Array(n);
  const alias = new Uint32Array(n);
  while (ns > 0 && nl > 0) {
    const s = small[--ns]!;
    const l = large[--nl]!;
    prob[s] = scaled[s]!;
    alias[s] = l;
    scaled[l] = scaled[l]! + scaled[s]! - 1;
    if (scaled[l]! < 1) small[ns++] = l;
    else large[nl++] = l;
  }
  // Leftovers are 1 up to rounding error.
  while (nl > 0) {
    const l = large[--nl]!;
    prob[l] = 1;
    alias[l] = l;
  }
  while (ns > 0) {
    const s = small[--ns]!;
    prob[s] = 1;
    alias[s] = s;
  }
  return { prob, alias, pmf, total };
}

/** Draws a bucket with two uniforms in [0, 1). Mirrors the GLSL sampler. */
export function sampleAlias(table: AliasTable, u0: number, u1: number): number {
  const n = table.prob.length;
  const i = Math.min(n - 1, Math.floor(u0 * n));
  return u1 < table.prob[i]! ? i : table.alias[i]!;
}
