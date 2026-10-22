import { describe, expect, it } from 'vitest';
import { buildAliasTable, sampleAlias } from '../src/math/alias';
import { parseHDR } from '../src/loaders/hdr';
import { bakeSky, buildEnvSampler, directionFromUV, uvFromDirection, type HDRImage } from '../src/scene/environment';
import { sheenAlbedo, sheenAlbedoLUT } from '../src/scene/sheen';

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

describe('alias table', () => {
  it('reproduces the input distribution exactly', () => {
    const w = [1, 0, 3, 6, 0.5, 9.5];
    const t = buildAliasTable(w);
    const n = w.length;
    const total = w.reduce((a, b) => a + b, 0);
    // Probability of bucket i = (prob[i] + Σ over j aliasing to i of (1 - prob[j])) / n.
    const p = new Array<number>(n).fill(0);
    for (let j = 0; j < n; j++) {
      p[j]! += t.prob[j]! / n;
      p[t.alias[j]!]! += (1 - t.prob[j]!) / n;
    }
    p.forEach((pi, i) => expect(pi).toBeCloseTo(w[i]! / total, 6));
    expect(t.total).toBe(total);
  });

  it('never returns a zero-weight bucket when sampled', () => {
    const t = buildAliasTable([0, 5, 0, 1]);
    const rand = rng(7);
    for (let i = 0; i < 2000; i++) expect([1, 3]).toContain(sampleAlias(t, rand(), rand()));
  });

  it('falls back to uniform for all-zero weights and rejects bad input', () => {
    const t = buildAliasTable([0, 0, 0, 0]);
    expect(Array.from(t.pmf)).toEqual([0.25, 0.25, 0.25, 0.25]);
    expect(t.total).toBe(0);
    expect(() => buildAliasTable([1, -1])).toThrow();
    expect(() => buildAliasTable([1, NaN])).toThrow();
    expect(() => buildAliasTable([])).toThrow();
  });
});

const header = (res: string) => new TextEncoder().encode(`#?RADIANCE\nFORMAT=32-bit_rle_rgbe\nEXPOSURE=1\n\n${res}\n`);
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out.buffer;
};

describe('parseHDR', () => {
  it('decodes flat RGBE pixels', () => {
    // e = 128 + 1 → scale 2^(129-136) = 1/128; (127 + 0.5) / 128 ≈ 0.996
    const px = new Uint8Array([127, 63, 0, 129, 0, 0, 0, 0]);
    const img = parseHDR(concat(header('-Y 1 +X 2'), px));
    expect([img.width, img.height]).toEqual([2, 1]);
    expect(img.data[0]).toBeCloseTo(127.5 / 128);
    expect(img.data[1]).toBeCloseTo(63.5 / 128);
    expect(img.data[2]).toBeCloseTo(0.5 / 128);
    expect(Array.from(img.data.subarray(3))).toEqual([0, 0, 0]);
  });

  it('decodes run-length encoded scanlines', () => {
    const width = 8;
    const rle = new Uint8Array([
      2, 2, 0, width,
      128 + 8, 200,         // R: run of 8 × 200
      4, 1, 2, 3, 4, 128 + 4, 9, // G: literal 1,2,3,4 then run of 4 × 9
      128 + 8, 0,           // B
      128 + 8, 128,         // E: 2^(128-136)
    ]);
    const img = parseHDR(concat(header(`-Y 1 +X ${width}`), rle));
    const f = 2 ** -8;
    for (let x = 0; x < width; x++) expect(img.data[x * 3]).toBeCloseTo(200.5 * f);
    expect([1, 2, 3, 4, 9, 9, 9, 9].map((g) => (g + 0.5) * f)).toEqual(Array.from({ length: 8 }, (_, x) => img.data[x * 3 + 1]));
  });

  it('flips bottom-up files so rows run top to bottom', () => {
    const top = [255, 0, 0, 128];
    const bottom = [0, 0, 255, 128];
    // "+Y" stores the bottom row first.
    const img = parseHDR(concat(header('+Y 2 +X 1'), new Uint8Array([...bottom, ...top])));
    expect(img.data[0]).toBeGreaterThan(0.5);
    expect(img.data[5]).toBeGreaterThan(0.5);
  });

  it('rejects files that are not Radiance HDR', () => {
    expect(() => parseHDR(new TextEncoder().encode('P6\n1 1\n255\n').buffer as ArrayBuffer)).toThrow(/Radiance/);
    expect(() => parseHDR(concat(header('-Y 2 +X 2'), new Uint8Array(4)))).toThrow(/truncated/);
  });
});

describe('environment sampling', () => {
  it('maps directions to equirect coordinates and back', () => {
    const rand = rng(3);
    for (let i = 0; i < 100; i++) {
      const [u, v] = [rand(), 0.01 + rand() * 0.98];
      const [u2, v2] = uvFromDirection(directionFromUV(u, v));
      expect(u2).toBeCloseTo(u, 9);
      expect(v2).toBeCloseTo(v, 9);
    }
    expect(directionFromUV(0.5, 0).map((x) => Math.abs(+x.toFixed(9)))).toEqual([0, 1, 0]);
  });

  it('has a solid-angle pdf that integrates to one and favours bright texels', () => {
    const width = 64;
    const height = 32;
    const data = new Float32Array(width * height * 3).fill(0.1);
    const bright = (10 * width + 40) * 3;
    data.fill(500, bright, bright + 3);
    const img: HDRImage = { width, height, data };
    const s = buildEnvSampler(img, 32);
    expect([s.gridWidth, s.gridHeight]).toEqual([32, 16]);

    // ∫ pdf dω over the sphere, with pdf = pdfUV / (2π² sin θ) and dω = 2π² sin θ du dv.
    let integral = 0;
    let maxCell = 0;
    for (let i = 0; i < s.gridWidth * s.gridHeight; i++) {
      integral += s.table[i * 4 + 2]! / (s.gridWidth * s.gridHeight);
      if (s.table[i * 4 + 2]! > s.table[maxCell * 4 + 2]!) maxCell = i;
    }
    expect(integral).toBeCloseTo(1, 6);
    expect(maxCell).toBe(5 * 32 + 20);
    // The alias column stores the alias cell's pdf.
    for (let i = 0; i < 20; i++) {
      const a = s.table[i * 4 + 1]!;
      expect(s.table[i * 4 + 3]).toBeCloseTo(s.table[a * 4 + 2]!, 6);
    }
  });

  it('bakes the procedural sky so the zenith is bluer than the horizon', () => {
    const sky = { enabled: true, zenith: [0.2, 0.4, 0.9] as const, horizon: [0.8, 0.85, 0.95] as const, ground: [0.3, 0.25, 0.2] as const, intensity: 2 };
    const sun = { elevation: 40, azimuth: 0, color: [1, 1, 1] as const, intensity: 0, angularRadius: 1 };
    const img = bakeSky(sky, sun, 64);
    const at = (x: number, y: number) => Array.from(img.data.subarray((y * 64 + x) * 3, (y * 64 + x) * 3 + 3));
    expect(at(10, 0)[2]).toBeGreaterThan(at(10, 0)[0]!);
    expect(at(10, 0)[2]).toBeCloseTo(2 * 0.9, 1);
    expect(at(10, 31)[0]).toBeGreaterThan(at(10, 31)[2]!);
    expect(bakeSky({ ...sky, enabled: false }, sun, 64).data.every((x) => x === 0)).toBe(true);
  });
});

describe('sheen albedo', () => {
  it('stays within [0, 1] and grows with roughness', () => {
    const lut = sheenAlbedoLUT(8, 48);
    for (const e of lut) {
      expect(e).toBeGreaterThanOrEqual(0);
      expect(e).toBeLessThanOrEqual(1);
    }
    expect(sheenAlbedo(0.7, 1, 96)).toBeGreaterThan(sheenAlbedo(0.7, 0.2, 96));
  });

  it('matches a brute-force Monte Carlo estimate', () => {
    // Uniform hemisphere sampling of l: E = (2π / N) Σ f(l, v) cos θl.
    const cosV = 0.5;
    const r = 0.6;
    const alpha = r * r;
    const v = [Math.sqrt(1 - cosV * cosV), 0, cosV];
    const rand = rng(11);
    let sum = 0;
    const n = 200000;
    for (let i = 0; i < n; i++) {
      const z = rand();
      const phi = 2 * Math.PI * rand();
      const s = Math.sqrt(1 - z * z);
      const l = [s * Math.cos(phi), s * Math.sin(phi), z];
      const h = [l[0]! + v[0]!, l[1]! + v[1]!, l[2]! + v[2]!];
      const len = Math.hypot(h[0]!, h[1]!, h[2]!);
      const cosH = h[2]! / len;
      const inv = 1 / alpha;
      const d = ((2 + inv) * Math.pow(Math.max(0, 1 - cosH * cosH), inv / 2)) / (2 * Math.PI);
      const vis = 1 / (4 * (z + cosV - z * cosV));
      sum += d * vis * z;
    }
    expect(sheenAlbedo(cosV, r, 256)).toBeCloseTo((2 * Math.PI * sum) / n, 2);
  });
});
