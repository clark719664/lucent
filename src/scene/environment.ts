import { buildAliasTable } from '../math/alias';
import { fromSpherical, type Vec3 } from '../math/vec3';
import type { Sky, Sun } from './scene';

/** Linear RGB floats, rows top to bottom, equirectangular. */
export interface HDRImage {
  width: number;
  height: number;
  data: Float32Array;
}

export interface Environment {
  /** Equirectangular radiance map; null uses the procedural sky and sun. */
  map: HDRImage | null;
  name: string;
  /** Rotation about the vertical axis in degrees. */
  rotation: number;
  intensity: number;
  /** Camera rays that miss see the environment (true) or the flat `backdrop`. */
  background: boolean;
  backdrop: Vec3;
}

export const proceduralEnvironment = (): Environment => ({
  map: null,
  name: 'Procedural sky',
  rotation: 0,
  intensity: 1,
  background: true,
  backdrop: [0.02, 0.02, 0.025],
});

/**
 * Importance-sampling data for an environment map, built over a grid of cells
 * that is at most `maxWidth` wide. Each cell gets a weight of mean luminance ×
 * sin θ (the equirect Jacobian), and the cells go into an alias table.
 *
 * `table` holds 4 floats per cell: keep probability, alias cell, the cell's
 * pdf in uv space, and the alias cell's pdf in uv space. The solid-angle pdf
 * of a direction is `pdfUV / (2π² sin θ)`, which the shader evaluates for MIS.
 */
export interface EnvSampler {
  gridWidth: number;
  gridHeight: number;
  table: Float32Array;
  /** Luminance-weighted sum; 0 for a black map (light sampling is then skipped). */
  total: number;
}

export const luminance = (r: number, g: number, b: number): number => 0.2126 * r + 0.7152 * g + 0.0722 * b;

export function buildEnvSampler(img: HDRImage, maxWidth = 1024): EnvSampler {
  const gw = Math.max(1, Math.min(img.width, maxWidth));
  const gh = Math.max(1, Math.min(img.height, Math.round((img.height * gw) / img.width)));
  const weights = new Float64Array(gw * gh);
  for (let cy = 0; cy < gh; cy++) {
    const y0 = Math.floor((cy * img.height) / gh);
    const y1 = Math.max(y0 + 1, Math.floor(((cy + 1) * img.height) / gh));
    const sinTheta = Math.sin((Math.PI * (cy + 0.5)) / gh);
    for (let cx = 0; cx < gw; cx++) {
      const x0 = Math.floor((cx * img.width) / gw);
      const x1 = Math.max(x0 + 1, Math.floor(((cx + 1) * img.width) / gw));
      let sum = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const o = (y * img.width + x) * 3;
          sum += luminance(img.data[o]!, img.data[o + 1]!, img.data[o + 2]!);
        }
      }
      weights[cy * gw + cx] = (sum / ((y1 - y0) * (x1 - x0))) * sinTheta;
    }
  }

  const alias = buildAliasTable(weights);
  const n = gw * gh;
  const table = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const a = alias.alias[i]!;
    table[i * 4] = alias.prob[i]!;
    table[i * 4 + 1] = a;
    table[i * 4 + 2] = alias.pmf[i]! * n;
    table[i * 4 + 3] = alias.pmf[a]! * n;
  }
  return { gridWidth: gw, gridHeight: gh, table, total: alias.total };
}

/** Equirect convention shared with lights.glsl: u wraps around +Y, v = 0 is straight up. */
export function directionFromUV(u: number, v: number): Vec3 {
  const phi = (u - 0.5) * 2 * Math.PI;
  const theta = v * Math.PI;
  const s = Math.sin(theta);
  return [s * Math.cos(phi), Math.cos(theta), s * Math.sin(phi)];
}

export function uvFromDirection(d: Vec3): [number, number] {
  const u = Math.atan2(d[2], d[0]) / (2 * Math.PI) + 0.5;
  const v = Math.acos(Math.max(-1, Math.min(1, d[1]))) / Math.PI;
  return [u, v];
}

/**
 * Bakes the procedural gradient sky (and the sun's glow, but not its disc) into
 * an equirect map, so sky light is importance-sampled exactly like an HDRI.
 * The disc stays analytic: it is far too small for a map of this size.
 */
export function bakeSky(sky: Sky, sun: Sun, width = 1024): HDRImage {
  const height = width / 2;
  const data = new Float32Array(width * height * 3);
  if (!sky.enabled || sky.intensity <= 0) return { width, height, data };
  const sunDir = fromSpherical((sun.elevation * Math.PI) / 180, (sun.azimuth * Math.PI) / 180);
  const sunOn = sun.intensity > 0 && sun.elevation > -sun.angularRadius;
  const mix = (a: number, b: number, t: number) => a + (b - a) * t;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const d = directionFromUV((x + 0.5) / width, (y + 0.5) / height);
      const t = d[1];
      const o = (y * width + x) * 3;
      for (let c = 0; c < 3; c++) {
        data[o + c] = t >= 0
          ? mix(sky.horizon[c]!, sky.zenith[c]!, Math.pow(t, 0.55))
          : mix(sky.horizon[c]!, sky.ground[c]!, Math.min(1, -t * 4));
      }
      if (sunOn) {
        const s = Math.max(0, d[0] * sunDir[0] + d[1] * sunDir[1] + d[2] * sunDir[2]);
        const glow = 0.12 * Math.pow(s, 24) + 0.5 * Math.pow(s, 400);
        for (let c = 0; c < 3; c++) data[o + c] = data[o + c]! + sun.color[c]! * glow;
      }
      for (let c = 0; c < 3; c++) data[o + c] = data[o + c]! * sky.intensity;
    }
  }
  return { width, height, data };
}
