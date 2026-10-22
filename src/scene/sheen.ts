/**
 * Directional albedo E(cos θv, roughness) of the sheen lobe — Charlie
 * distribution (Estevez & Kulla 2017) with Neubelt's visibility term — for a
 * white sheen colour. KHR_materials_sheen scales the base layer by
 * `1 − max(sheenColor) · E` so that adding sheen does not add energy.
 *
 * The shader evaluates the same lobe, so the table is computed here by
 * quadrature rather than taken from a paper's fit.
 */
export const SHEEN_LUT_SIZE = 16;
export const MIN_SHEEN_ROUGHNESS = 0.07;

export function charlieD(alpha: number, cosH: number): number {
  const inv = 1 / alpha;
  const sin2 = Math.max(0, 1 - cosH * cosH);
  return ((2 + inv) * Math.pow(sin2, inv * 0.5)) / (2 * Math.PI);
}

export function neubeltV(cosL: number, cosV: number): number {
  return 1 / (4 * (cosL + cosV - cosL * cosV));
}

/** E for one view angle and roughness, integrated over half-vectors (where the lobe is peaked). */
export function sheenAlbedo(cosV: number, roughness: number, steps = 128): number {
  const r = Math.max(MIN_SHEEN_ROUGHNESS, roughness);
  const alpha = r * r;
  const v = [Math.sqrt(Math.max(0, 1 - cosV * cosV)), 0, cosV] as const;
  const phiSteps = steps / 2;
  const dTheta = Math.PI / 2 / steps;
  const dPhi = Math.PI / phiSteps; // half circle, doubled by symmetry about the view plane
  let e = 0;
  for (let i = 0; i < steps; i++) {
    const th = (i + 0.5) * dTheta;
    const ch = Math.cos(th);
    const sh = Math.sin(th);
    const d = charlieD(alpha, ch);
    for (let j = 0; j < phiSteps; j++) {
      const ph = (j + 0.5) * dPhi;
      const h = [sh * Math.cos(ph), sh * Math.sin(ph), ch];
      const vh = v[0] * h[0]! + v[2] * h[2]!;
      if (vh <= 0) continue;
      const cosL = 2 * vh * h[2]! - v[2];
      if (cosL <= 0) continue;
      // dω_l = 4 (v·h) dω_h
      e += d * neubeltV(cosL, cosV) * cosL * 4 * vh * sh * dTheta * dPhi;
    }
  }
  return Math.min(1, 2 * e);
}

/** Row-major table: x = cos θv in [0, 1], y = roughness in [0, 1], sampled at texel centres' end points. */
export function sheenAlbedoLUT(size = SHEEN_LUT_SIZE, steps = 96): Float32Array {
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cosV = Math.max(1e-3, x / (size - 1));
      out[y * size + x] = sheenAlbedo(cosV, y / (size - 1), steps);
    }
  }
  return out;
}
