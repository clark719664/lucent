import { describe, expect, it } from 'vitest';
import { glass, light, matte, metal, packMaterials, unpackMaterial } from '../src/scene/material';
import { quad, torusKnot } from '../src/scene/mesh';
import { PRESETS } from '../src/scene/presets';
import { packScene, pickDistance, quadFromMesh, TRI_TEXELS, type Scene } from '../src/scene/scene';

const baseScene = (): Scene => ({
  name: 't',
  description: '',
  exposure: 1,
  camera: { position: [0, 0, 5], target: [0, 0, 0], fov: 45, aperture: 0, focusDistance: 5 },
  sun: { elevation: 45, azimuth: 0, color: [1, 1, 1], intensity: 1, angularRadius: 1 },
  sky: { enabled: true, zenith: [0, 0, 1], horizon: [1, 1, 1], ground: [0, 0, 0], intensity: 1 },
  spheres: [],
  meshes: [],
});

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
    expect(p.materialCount).toBe(1);
    expect(p.triCount).toBe(4);
    for (let t = 0; t < p.triCount; t++) expect(p.triangles[t * TRI_TEXELS * 4 + 3]).toBe(0);
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
    expect(p.triangles[0 * TRI_TEXELS * 4 + 7]).toBe(0);
    expect(p.triangles[1 * TRI_TEXELS * 4 + 7]).toBe(0);
    // Light table: quad at slot 0 with type 1 and radiance 5.
    expect(p.lights[3]).toBe(1);
    expect(p.lights[12]).toBe(5);
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
