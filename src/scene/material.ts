import type { Vec3 } from '../math/vec3';

/**
 * A compact "principled-lite" surface description.
 *
 * Everything is physically-motivated but deliberately small: one struct covers
 * matte paint, brushed metal, glass, and emitters, which keeps the GLSL BSDF
 * branch-light and the UI understandable.
 */
export interface Material {
  /** Base colour in linear RGB. For dielectrics this tints transmitted light. */
  albedo: Vec3;
  /** 0 = dielectric (plastic/paint), 1 = conductor (metal). */
  metallic: number;
  /** 0 = mirror-smooth, 1 = fully rough. Applied to both reflection and refraction. */
  roughness: number;
  /** 0 = opaque, 1 = refractive. Fractions blend stochastically. */
  transmission: number;
  /** Index of refraction used when `transmission > 0`. Glass ≈ 1.5, water ≈ 1.33, diamond ≈ 2.4. */
  ior: number;
  /** Emitted radiance in linear RGB. Non-zero makes the surface a light. */
  emission: Vec3;
  /** Checkerboard frequency in world units; 0 disables. Alternates `albedo` and `albedo2`. */
  checkerScale: number;
  /** Second checker colour. */
  albedo2: Vec3;
}

export const MATERIAL_TEXELS = 4;

const DEFAULT_MATERIAL: Material = {
  albedo: [0.8, 0.8, 0.8],
  metallic: 0,
  roughness: 0.5,
  transmission: 0,
  ior: 1.5,
  emission: [0, 0, 0],
  checkerScale: 0,
  albedo2: [0.2, 0.2, 0.2],
};

export const material = (overrides: Partial<Material> = {}): Material => ({
  ...DEFAULT_MATERIAL,
  ...overrides,
});

/** Convenience constructors that read like a material library. */
export const matte = (albedo: Vec3, roughness = 1): Material => material({ albedo, roughness });
export const metal = (albedo: Vec3, roughness = 0.1): Material =>
  material({ albedo, metallic: 1, roughness });
export const glass = (albedo: Vec3 = [1, 1, 1], ior = 1.5, roughness = 0): Material =>
  material({ albedo, transmission: 1, ior, roughness });
export const light = (color: Vec3, strength: number): Material =>
  material({
    albedo: [0, 0, 0],
    emission: [color[0] * strength, color[1] * strength, color[2] * strength],
  });
export const checker = (a: Vec3, b: Vec3, scale: number, roughness = 0.9): Material =>
  material({ albedo: a, albedo2: b, checkerScale: scale, roughness });

export const isEmissive = (m: Material): boolean =>
  m.emission[0] > 0 || m.emission[1] > 0 || m.emission[2] > 0;

/**
 * Packs materials into RGBA32F texels, 4 per material:
 *
 *   0: albedo.rgb,   metallic
 *   1: roughness,    ior,  transmission,  checkerScale
 *   2: emission.rgb, (unused)
 *   3: albedo2.rgb,  (unused)
 */
export function packMaterials(materials: readonly Material[]): Float32Array {
  const out = new Float32Array(materials.length * MATERIAL_TEXELS * 4);
  materials.forEach((m, i) => {
    const o = i * MATERIAL_TEXELS * 4;
    out.set([...m.albedo, m.metallic], o);
    out.set([m.roughness, m.ior, m.transmission, m.checkerScale], o + 4);
    out.set([...m.emission, 0], o + 8);
    out.set([...m.albedo2, 0], o + 12);
  });
  return out;
}

/** Inverse of `packMaterials`; exists so the round-trip is testable. */
export function unpackMaterial(data: Float32Array, index: number): Material {
  const o = index * MATERIAL_TEXELS * 4;
  const f = (k: number) => data[o + k]!;
  return {
    albedo: [f(0), f(1), f(2)],
    metallic: f(3),
    roughness: f(4),
    ior: f(5),
    transmission: f(6),
    checkerScale: f(7),
    emission: [f(8), f(9), f(10)],
    albedo2: [f(12), f(13), f(14)],
  };
}
