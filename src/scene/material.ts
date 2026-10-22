import type { Vec3 } from '../math/vec3';

export type AlphaMode = 'opaque' | 'mask' | 'blend';

/** Row-major 2×3 affine transform applied to texture coordinates. */
export type UVTransform = readonly [number, number, number, number, number, number];

export const IDENTITY_UV: UVTransform = [1, 0, 0, 0, 1, 0];

/**
 * A "principled" surface description that covers the glTF 2.0 metal-rough
 * model plus the clearcoat, sheen, transmission and volume extensions.
 *
 * One struct covers matte paint, brushed metal, car paint, velvet, glass and
 * emitters, which keeps the GLSL BSDF a single function and the UI legible.
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
  /** Index of refraction. Sets the dielectric F0 and the refraction angle. Glass ≈ 1.5. */
  ior: number;
  /** Emitted radiance in linear RGB. Non-zero makes the surface a light. */
  emission: Vec3;
  /** Checkerboard frequency in world units; 0 disables. Alternates `albedo` and `albedo2`. */
  checkerScale: number;
  /** Second checker colour. */
  albedo2: Vec3;
  /** Base-colour alpha; `alphaMode` decides whether it cuts out (mask) or fades (blend). */
  alpha: number;
  alphaMode: AlphaMode;
  alphaCutoff: number;
  /** Weight of a smooth IOR-1.5 coat over the base, as on car paint; 0 disables. */
  clearcoat: number;
  clearcoatRoughness: number;
  /** Retro-reflective fabric sheen (Charlie distribution); black disables. */
  sheenColor: Vec3;
  sheenRoughness: number;
  /** Transmission passes straight through instead of refracting (a glTF material without a volume). */
  thinWalled: boolean;
  /** Beer–Lambert absorption: the colour white light becomes after `attenuationDistance` inside. */
  attenuationColor: Vec3;
  /** Infinity disables absorption. */
  attenuationDistance: number;
  /** Indices into `Scene.textures`, or -1. Colour maps are sRGB; metal-rough and normal maps are linear. */
  baseColorMap: number;
  metalRoughMap: number;
  normalMap: number;
  emissiveMap: number;
  normalScale: number;
  uvTransform: UVTransform;
}

export const MATERIAL_TEXELS = 10;

const DEFAULT_MATERIAL: Material = {
  albedo: [0.8, 0.8, 0.8],
  metallic: 0,
  roughness: 0.5,
  transmission: 0,
  ior: 1.5,
  emission: [0, 0, 0],
  checkerScale: 0,
  albedo2: [0.2, 0.2, 0.2],
  alpha: 1,
  alphaMode: 'opaque',
  alphaCutoff: 0.5,
  clearcoat: 0,
  clearcoatRoughness: 0,
  sheenColor: [0, 0, 0],
  sheenRoughness: 0,
  thinWalled: false,
  attenuationColor: [1, 1, 1],
  attenuationDistance: Infinity,
  baseColorMap: -1,
  metalRoughMap: -1,
  normalMap: -1,
  emissiveMap: -1,
  normalScale: 1,
  uvTransform: IDENTITY_UV,
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

/** True if the traversal must evaluate alpha before accepting a hit on this material. */
export const needsAlphaTest = (m: Material): boolean =>
  m.alphaMode !== 'opaque' && (m.alpha < 1 || m.baseColorMap >= 0);

const ALPHA_CODE: Record<AlphaMode, number> = { opaque: 0, mask: 1, blend: 2 };
const ALPHA_MODES: readonly AlphaMode[] = ['opaque', 'mask', 'blend'];

/**
 * Packs materials into RGBA32F texels, 10 per material. Map fields must
 * already hold texture-array layer indices (see `packScene`).
 *
 *   0: albedo.rgb,       metallic
 *   1: roughness,        ior, transmission, checkerScale
 *   2: emission.rgb,     alpha
 *   3: albedo2.rgb,      alphaMode (0 opaque, 1 mask, 2 blend)
 *   4: baseColorMap,     metalRoughMap, normalMap, emissiveMap
 *   5: normalScale,      clearcoat, clearcoatRoughness, alphaCutoff
 *   6: sheenColor.rgb,   sheenRoughness
 *   7: attenuation.rgb,  attenuationDistance (0 = none)
 *   8: uv row 0 (a b c), thinWalled
 *   9: uv row 1 (d e f), 0
 */
export function packMaterials(materials: readonly Material[]): Float32Array {
  const out = new Float32Array(materials.length * MATERIAL_TEXELS * 4);
  materials.forEach((m, i) => {
    const o = i * MATERIAL_TEXELS * 4;
    const uv = m.uvTransform;
    out.set([...m.albedo, m.metallic], o);
    out.set([m.roughness, m.ior, m.transmission, m.checkerScale], o + 4);
    out.set([...m.emission, m.alpha], o + 8);
    out.set([...m.albedo2, ALPHA_CODE[m.alphaMode]], o + 12);
    out.set([m.baseColorMap, m.metalRoughMap, m.normalMap, m.emissiveMap], o + 16);
    out.set([m.normalScale, m.clearcoat, m.clearcoatRoughness, m.alphaCutoff], o + 20);
    out.set([...m.sheenColor, m.sheenRoughness], o + 24);
    out.set([...m.attenuationColor, Number.isFinite(m.attenuationDistance) ? m.attenuationDistance : 0], o + 28);
    out.set([uv[0], uv[1], uv[2], m.thinWalled ? 1 : 0], o + 32);
    out.set([uv[3], uv[4], uv[5], 0], o + 36);
  });
  return out;
}

/** Inverse of `packMaterials`; exists so the round-trip is testable. */
export function unpackMaterial(data: Float32Array, index: number): Material {
  const o = index * MATERIAL_TEXELS * 4;
  const f = (k: number) => data[o + k]!;
  const v = (k: number): Vec3 => [f(k), f(k + 1), f(k + 2)];
  return {
    albedo: v(0),
    metallic: f(3),
    roughness: f(4),
    ior: f(5),
    transmission: f(6),
    checkerScale: f(7),
    emission: v(8),
    alpha: f(11),
    albedo2: v(12),
    alphaMode: ALPHA_MODES[f(15)] ?? 'opaque',
    baseColorMap: f(16),
    metalRoughMap: f(17),
    normalMap: f(18),
    emissiveMap: f(19),
    normalScale: f(20),
    clearcoat: f(21),
    clearcoatRoughness: f(22),
    alphaCutoff: f(23),
    sheenColor: v(24),
    sheenRoughness: f(27),
    attenuationColor: v(28),
    attenuationDistance: f(31) > 0 ? f(31) : Infinity,
    uvTransform: [f(32), f(33), f(34), f(36), f(37), f(38)],
    thinWalled: f(35) > 0.5,
  };
}
