import { describe, expect, it } from 'vitest';
import { proceduralEnvironment } from '../src/scene/environment';
import { glass, light, material, matte, metal, packMaterials, unpackMaterial } from '../src/scene/material';
import { quad, torusKnot } from '../src/scene/mesh';
import { PRESETS } from '../src/scene/presets';
import { ATTR_TEXELS, GEO_TEXELS, packScene, pickDistance, quadFromMesh, type Scene, type SceneTexture } from '../src/scene/scene';

const baseScene = (): Scene => ({
  name: 't',
  description: '',
  exposure: 1,
  camera: { position: [0, 0, 5], target: [0, 0, 0], fov: 45, aperture: 0, focusDistance: 5 },
  sun: { elevation: 45, azimuth: 0, color: [1, 1, 1], intensity: 1, angularRadius: 1 },
  sky: { enabled: true, zenith: [0, 0, 1], horizon: [1, 1, 1], ground: [0, 0, 0], intensity: 1 },
  env: proceduralEnvironment(),
  ground: { enabled: false, height: 0, material: matte([0.5, 0.5, 0.5]) },
  spheres: [],
  meshes: [],
  textures: [],
});

/** Rounds every number in a structure so float32 storage compares equal to the float64 source. */
const rounded = (x: unknown): unknown =>
  typeof x === 'number' ? (Number.isFinite(x) ? +x.toFixed(5) : x)
    : Array.isArray(x) ? x.map(rounded)
    : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, rounded(v)]))
    : x;

const fakeTextures = (n: number): SceneTexture[] =>
  Array.from({ length: n }, (_, i) => ({ image: {} as ImageBitmap, name: `t${i}` }));

describe('materials', () => {
  it('round-trip through the texel layout', () => {
    const mats = [matte([0.1, 0.2, 0.3]), metal([1, 0.8, 0.5], 0.2), glass([0.9, 1, 0.9], 1.33, 0.1), light([1, 0.5, 0.25], 10)];
    const packed = packMaterials(mats);
    mats.forEach((m, i) => {
      const u = unpackMaterial(packed, i);
      expect(u.albedo.map((x) => +x.toFixed(5))).toEqual(m.albedo.map((x) => +x.toFixed(5)));
      expect(u.metallic).toBeCloseTo(m.metallic);
      expect(u.roughness).toBeCloseTo(m.roughness);
      expect(u.ior).toBeCloseTo(m.ior);
      expect(u.transmission).toBeCloseTo(m.transmission);
      expect(u.emission.map((x) => +x.toFixed(4))).toEqual(m.emission.map((x) => +x.toFixed(4)));
    });
  });

  it('round-trip the glTF extension fields', () => {
    const m = material({
      alpha: 0.5,
      alphaMode: 'blend',
      alphaCutoff: 0.25,
      clearcoat: 1,
      clearcoatRoughness: 0.125,
      sheenColor: [0.5, 0.25, 0.125],
      sheenRoughness: 0.75,
      thinWalled: true,
      attenuationColor: [1, 0.5, 0.25],
      attenuationDistance: 3,
      baseColorMap: 2,
      metalRoughMap: 0,
      normalMap: 1,
      emissiveMap: 3,
      normalScale: 0.5,
      uvTransform: [2, 0, 0.5, 0, 2, 0.25],
    });
    expect(rounded(unpackMaterial(packMaterials([m]), 0))).toEqual(rounded(m));
    // Infinite attenuation distance survives as "no absorption".
    expect(unpackMaterial(packMaterials([material()]), 0).attenuationDistance).toBe(Infinity);
  });
});

describe('quadFromMesh', () => {
  it('recognises quads produced by quad()', () => {
    const q = quadFromMesh(quad([0, 2, 0], [1, 2, 0], [1, 2, 1], [0, 2, 1]));
    expect(q).not.toBeNull();
    expect(q!.position).toEqual([0, 2, 0]);
    expect(q!.edge1).toEqual([1, 0, 0]);
    expect(q!.edge2).toEqual([0, 0, 1]);
  });

  it('rejects other meshes', () => {
    expect(quadFromMesh(torusKnot({ tubularSegments: 4, radialSegments: 3 }))).toBeNull();
  });
});

describe('packScene', () => {
  it('deduplicates shared materials and writes triangle material ids', () => {
    const white = matte([1, 1, 1]);
    const s = baseScene();
    s.meshes = [
      { mesh: quad([0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]), material: white },
      { mesh: quad([2, 0, 0], [3, 0, 0], [3, 1, 0], [2, 1, 0]), material: white },
    ];
    s.spheres = [{ center: [0, 0, 0], radius: 1, material: white }];
    const p = packScene(s);
    expect(p.materialCount).toBe(2); // white + the (disabled) ground
    expect(p.triCount).toBe(4);
    for (let t = 0; t < p.triCount; t++) expect(p.triGeometry[t * GEO_TEXELS * 4 + 3]).toBe(0);
    expect(p.sphereMaterials[0]).toBe(0);
    expect(p.lightCount).toBe(0);
  });

  it('turns emissive spheres and quads into explicit lights', () => {
    const s = baseScene();
    const lamp = light([1, 1, 1], 5);
    s.spheres = [{ center: [0, 3, 0], radius: 0.5, material: lamp }];
    s.meshes = [{ mesh: quad([-1, 4, -1], [1, 4, -1], [1, 4, 1], [-1, 4, 1]), material: lamp }];
    const p = packScene(s);
    expect(p.lightCount).toBe(2);
    expect(p.lightList[0]!.type).toBe('quad');
    expect(p.lightList[1]!.type).toBe('sphere');
    expect(p.sphereLights[0]).toBe(1);
    // Both quad triangles carry light index 0 in v1.w.
    expect(p.triGeometry[0 * GEO_TEXELS * 4 + 7]).toBe(0);
    expect(p.triGeometry[1 * GEO_TEXELS * 4 + 7]).toBe(0);
    // Light table: quad at slot 0 with type 1 and radiance 5.
    expect(p.lights[3]).toBe(1);
    expect(p.lights[12]).toBe(5);
  });

  it('assigns sRGB and linear texture layers per usage and remaps material maps', () => {
    const s = baseScene();
    s.textures = fakeTextures(4);
    const a = material({ baseColorMap: 3, normalMap: 1, metalRoughMap: 1 });
    const b = material({ baseColorMap: 0, emissiveMap: 3, metalRoughMap: 2 });
    s.meshes = [
      { mesh: quad([0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]), material: a },
      { mesh: quad([2, 0, 0], [3, 0, 0], [3, 1, 0], [2, 1, 0]), material: b },
    ];
    const p = packScene(s);
    expect(p.colorLayers).toEqual([3, 0]);
    expect(p.dataLayers).toEqual([1, 2]);
    const ua = unpackMaterial(p.materials, 0);
    const ub = unpackMaterial(p.materials, 1);
    expect([ua.baseColorMap, ua.normalMap, ua.metalRoughMap, ua.emissiveMap]).toEqual([0, 0, 0, -1]);
    expect([ub.baseColorMap, ub.emissiveMap, ub.metalRoughMap]).toEqual([1, 0, 1]);
  });

  it('rejects maps that point past the scene textures', () => {
    const s = baseScene();
    s.meshes = [{ mesh: quad([0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]), material: material({ normalMap: 0 }) }];
    expect(() => packScene(s)).toThrow(/texture 0/);
  });

  it('writes UVs into the attribute texels and flags alpha-tested triangles', () => {
    const s = baseScene();
    s.textures = fakeTextures(1);
    const mesh = quad([0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]);
    const uvs = new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.1, 0.2, 0.5, 0.6, 0.7, 0.8]);
    s.meshes = [
      { mesh: { ...mesh, uvs }, material: material({ alphaMode: 'mask', baseColorMap: 0 }) },
      { mesh: quad([2, 0, 0], [3, 0, 0], [3, 1, 0], [2, 1, 0]), material: matte([1, 1, 1]) },
    ];
    const p = packScene(s);
    const bySlot = Array.from({ length: p.triCount }, (_, slot) => {
      const g = slot * GEO_TEXELS * 4;
      const a = slot * ATTR_TEXELS * 4;
      const us = [p.triAttributes[a + 3]!, p.triAttributes[a + 7]!, p.triAttributes[a + 11]!];
      const vs = [p.triAttributes[a + 12]!, p.triAttributes[a + 13]!, p.triAttributes[a + 14]!];
      return { mat: p.triGeometry[g + 3], alpha: p.triGeometry[g + 11], uv: us.flatMap((u, i) => [u, vs[i]!]).map((x) => +x.toFixed(4)) };
    });
    const textured = bySlot.filter((t) => t.mat === 0);
    expect(textured).toHaveLength(2);
    expect(textured.every((t) => t.alpha === 1)).toBe(true);
    expect(textured.map((t) => t.uv)).toContainEqual([0.1, 0.2, 0.3, 0.4, 0.5, 0.6]);
    expect(bySlot.filter((t) => t.mat === 1).every((t) => t.alpha === 0 && t.uv.every((x) => x === 0))).toBe(true);
  });

  it('packs the ground plane material and picks against it', () => {
    const s = baseScene();
    s.ground = { enabled: true, height: -1, material: matte([0.3, 0.3, 0.3]) };
    const p = packScene(s);
    expect(p.groundMaterial).toBe(0);
    expect(pickDistance(p, { origin: [0, 1, 0], dir: [0, -1, 0] })).toBeCloseTo(2);
    expect(pickDistance(p, { origin: [0, 1, 0], dir: [0, 1, 0] })).toBeNull();
    // Toggling the shared ground object is picked up without repacking.
    s.ground.enabled = false;
    expect(pickDistance(p, { origin: [0, 1, 0], dir: [0, -1, 0] })).toBeNull();
  });

  it('rejects too many spheres', () => {
    const s = baseScene();
    s.spheres = Array.from({ length: 65 }, () => ({ center: [0, 0, 0] as const, radius: 1, material: matte([1, 1, 1]) }));
    expect(() => packScene(s)).toThrow(/spheres/);
  });
});

describe('presets', () => {
  it('all pack without error and have unique names', () => {
    const names = new Set<string>();
    for (const make of PRESETS) {
      const scene = make();
      const p = packScene(scene);
      expect(p.bvhNodeCount).toBeGreaterThan(0);
      names.add(scene.name);
    }
    expect(names.size).toBe(PRESETS.length);
  });

  it('the camera of every preset is looking at something', () => {
    for (const make of PRESETS) {
      const scene = make();
      const p = packScene(scene);
      const { position, target } = scene.camera;
      const d = [target[0] - position[0], target[1] - position[1], target[2] - position[2]];
      const l = Math.hypot(d[0]!, d[1]!, d[2]!);
      const dist = pickDistance(p, { origin: position, dir: [d[0]! / l, d[1]! / l, d[2]! / l] });
      expect(dist).not.toBeNull();
      expect(dist!).toBeGreaterThan(0);
    }
  });
});
