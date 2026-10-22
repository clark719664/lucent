import { buildBVH, intersectBVH, NODE_STRIDE, type BVH } from '../math/bvh';
import type { Ray } from '../math/ray';
import { intersectSphere } from '../math/ray';
import type { Vec3 } from '../math/vec3';
import { cross, length, sub } from '../math/vec3';
import type { Environment } from './environment';
import { isEmissive, needsAlphaTest, packMaterials, type Material } from './material';
import { mergeMeshes, triangleCount, type Mesh } from './mesh';

export interface Camera {
  position: Vec3;
  target: Vec3;
  /** Vertical field of view in degrees. */
  fov: number;
  /** Lens radius in world units; 0 = pinhole. */
  aperture: number;
  /** Distance to the plane of perfect focus. */
  focusDistance: number;
}

export interface Sun {
  /** Elevation above the horizon in degrees. */
  elevation: number;
  /** Compass direction in degrees. */
  azimuth: number;
  color: Vec3;
  intensity: number;
  /** Angular radius in degrees; the real sun is ≈ 0.27°. */
  angularRadius: number;
}

export interface Sky {
  enabled: boolean;
  zenith: Vec3;
  horizon: Vec3;
  ground: Vec3;
  intensity: number;
}

/** An analytic infinite plane `y = height`; cheap, and needs no BVH rebuild when toggled. */
export interface Ground {
  enabled: boolean;
  height: number;
  material: Material;
}

export interface Sphere {
  center: Vec3;
  radius: number;
  material: Material;
}

export interface MeshInstance {
  mesh: Mesh;
  material: Material;
}

/** A decoded image; resampled on upload to the shared texture-array size. */
export interface SceneTexture {
  image: ImageBitmap;
  name: string;
}

export interface Scene {
  name: string;
  description: string;
  /** Suggested display exposure; sunlit scenes carry far more energy than lamp-lit ones. */
  exposure: number;
  camera: Camera;
  sun: Sun;
  sky: Sky;
  env: Environment;
  ground: Ground;
  spheres: Sphere[];
  meshes: MeshInstance[];
  textures: SceneTexture[];
}

export const MAX_SPHERES = 64;
export const MAX_LIGHTS = 8;
/** Triangle texels used by traversal: v0 (w = material), v1 (w = light), v2 (w = alpha-test flag). */
export const GEO_TEXELS = 3;
/** Shading texels, read once per hit: (n0, u0) (n1, u1) (n2, u2) (v0, v1, v2, 0). */
export const ATTR_TEXELS = 4;
export const BVH_TEXELS = 2;
export const LIGHT_TEXELS = 4;

/**
 * Explicit light description for next-event estimation. Packed as 4 vec4s:
 *
 *   0: position.xyz, type (0 = sphere, 1 = quad)
 *   1: edge1.xyz,    radius
 *   2: edge2.xyz,    0
 *   3: radiance.rgb, 0
 */
export interface Light {
  type: 'sphere' | 'quad';
  position: Vec3;
  radius: number;
  edge1: Vec3;
  edge2: Vec3;
  radiance: Vec3;
}

/** Everything the GPU needs, already laid out as texel arrays. */
export interface PackedScene {
  triGeometry: Float32Array;
  triAttributes: Float32Array;
  triCount: number;
  bvhNodes: Float32Array;
  bvhNodeCount: number;
  materials: Float32Array;
  materialCount: number;
  spheres: Float32Array;
  sphereMaterials: Int32Array;
  sphereCount: number;
  /** Per-sphere light index or -1. */
  sphereLights: Int32Array;
  lights: Float32Array;
  lightCount: number;
  lightList: Light[];
  /** Material index of the ground plane (packed even while it is disabled). */
  groundMaterial: number;
  /** Scene texture index stored in each layer of the sRGB (colour) and linear (data) arrays. */
  colorLayers: number[];
  dataLayers: number[];
  /** CPU-side copies kept for picking. */
  cpu: {
    positions: Float32Array;
    bvh: BVH;
    sphereList: Sphere[];
    ground: Ground;
  };
}

/** Assigns each referenced texture one layer in its array, in first-use order. */
function layerMap(): { layers: number[]; layer: (tex: number) => number } {
  const layers: number[] = [];
  const index = new Map<number, number>();
  return {
    layers,
    layer: (tex) => {
      if (tex < 0) return -1;
      let l = index.get(tex);
      if (l === undefined) {
        l = layers.length;
        layers.push(tex);
        index.set(tex, l);
      }
      return l;
    },
  };
}

/**
 * Flattens a scene into GPU texel arrays.
 *
 * Triangles are written in BVH leaf order, so the shader indexes the triangle
 * textures directly from a leaf's `leftFirst` with no indirection table.
 * `prebuilt` is a BVH over the merged meshes built elsewhere (a worker).
 */
export function packScene(scene: Scene, prebuilt?: BVH): PackedScene {
  if (scene.spheres.length > MAX_SPHERES) {
    throw new Error(`scene has ${scene.spheres.length} spheres; max is ${MAX_SPHERES}`);
  }

  // Materials are deduplicated by reference so shared library entries pack once.
  const materials: Material[] = [];
  const materialIds = new Map<Material, number>();
  const materialIndex = (m: Material): number => {
    let i = materialIds.get(m);
    if (i === undefined) {
      i = materials.length;
      materials.push(m);
      materialIds.set(m, i);
    }
    return i;
  };

  const lightList: Light[] = [];
  const addLight = (l: Light): number => {
    if (lightList.length >= MAX_LIGHTS) return -1;
    lightList.push(l);
    return lightList.length - 1;
  };

  const merged = mergeMeshes(scene.meshes.map((m) => m.mesh));
  const triCount = triangleCount(merged);
  const triMaterial = new Int32Array(triCount);
  const triLight = new Int32Array(triCount).fill(-1);
  const triAlpha = new Uint8Array(triCount);
  let cursor = 0;
  for (const inst of scene.meshes) {
    const n = triangleCount(inst.mesh);
    triMaterial.fill(materialIndex(inst.material), cursor, cursor + n);
    if (needsAlphaTest(inst.material)) triAlpha.fill(1, cursor, cursor + n);
    // Emissive quads built with `quad()` become explicitly sampled area lights.
    const asQuad = isEmissive(inst.material) ? quadFromMesh(inst.mesh) : null;
    if (asQuad) {
      const li = addLight({ ...asQuad, type: 'quad', radius: 0, radiance: inst.material.emission });
      triLight.fill(li, cursor, cursor + n);
    }
    cursor += n;
  }

  if (prebuilt && prebuilt.triIndices.length !== triCount) {
    throw new Error(`prebuilt BVH covers ${prebuilt.triIndices.length} triangles; scene has ${triCount}`);
  }
  const bvh = prebuilt ?? buildBVH(merged.positions);
  const pos = merged.positions;
  const nrm = merged.normals;
  const uvs = merged.uvs;
  const geo = new Float32Array(triCount * GEO_TEXELS * 4);
  const attr = new Float32Array(triCount * ATTR_TEXELS * 4);
  for (let slot = 0; slot < triCount; slot++) {
    const src = bvh.triIndices[slot]!;
    const p = src * 9;
    const g = slot * GEO_TEXELS * 4;
    const a = slot * ATTR_TEXELS * 4;
    for (let v = 0; v < 3; v++) {
      geo[g + v * 4] = pos[p + v * 3]!;
      geo[g + v * 4 + 1] = pos[p + v * 3 + 1]!;
      geo[g + v * 4 + 2] = pos[p + v * 3 + 2]!;
      attr[a + v * 4] = nrm[p + v * 3]!;
      attr[a + v * 4 + 1] = nrm[p + v * 3 + 1]!;
      attr[a + v * 4 + 2] = nrm[p + v * 3 + 2]!;
      if (uvs) {
        attr[a + v * 4 + 3] = uvs[src * 6 + v * 2]!;
        attr[a + 12 + v] = uvs[src * 6 + v * 2 + 1]!;
      }
    }
    geo[g + 3] = triMaterial[src]!;
    geo[g + 7] = triLight[src]!;
    geo[g + 11] = triAlpha[src]!;
  }

  // BVH nodes are already 8 floats = 2 texels each, exactly the texture layout.
  if (NODE_STRIDE !== BVH_TEXELS * 4) throw new Error('BVH node stride mismatch');
  const bvhNodes = new Float32Array(bvh.nodes);

  const spheres = new Float32Array(MAX_SPHERES * 4);
  const sphereMaterials = new Int32Array(MAX_SPHERES);
  const sphereLights = new Int32Array(MAX_SPHERES).fill(-1);
  scene.spheres.forEach((s, i) => {
    spheres.set([...s.center, s.radius], i * 4);
    sphereMaterials[i] = materialIndex(s.material);
    if (isEmissive(s.material)) {
      sphereLights[i] = addLight({
        type: 'sphere',
        position: s.center,
        radius: s.radius,
        edge1: [0, 0, 0],
        edge2: [0, 0, 0],
        radiance: s.material.emission,
      });
    }
  });

  // Always packed, so the ground can be toggled with a uniform instead of a repack.
  const groundMaterial = materialIndex(scene.ground.material);

  const lights = new Float32Array(MAX_LIGHTS * LIGHT_TEXELS * 4);
  lightList.forEach((l, i) => {
    const o = i * LIGHT_TEXELS * 4;
    lights.set([...l.position, l.type === 'sphere' ? 0 : 1], o);
    lights.set([...l.edge1, l.radius], o + 4);
    lights.set([...l.edge2, 0], o + 8);
    lights.set([...l.radiance, 0], o + 12);
  });

  // sRGB maps (base colour, emissive) and linear maps (metal-rough, normal) live in separate arrays.
  const color = layerMap();
  const data = layerMap();
  const layered = materials.map((m) => ({
    ...m,
    baseColorMap: color.layer(m.baseColorMap),
    emissiveMap: color.layer(m.emissiveMap),
    metalRoughMap: data.layer(m.metalRoughMap),
    normalMap: data.layer(m.normalMap),
  }));
  for (const t of [...color.layers, ...data.layers]) {
    if (t >= scene.textures.length) throw new Error(`material references texture ${t}, scene has ${scene.textures.length}`);
  }

  return {
    triGeometry: geo,
    triAttributes: attr,
    triCount,
    bvhNodes,
    bvhNodeCount: bvh.nodeCount,
    materials: packMaterials(layered),
    materialCount: materials.length,
    spheres,
    sphereMaterials,
    sphereCount: scene.spheres.length,
    sphereLights,
    lights,
    lightCount: lightList.length,
    lightList,
    groundMaterial,
    colorLayers: color.layers,
    dataLayers: data.layers,
    cpu: { positions: merged.positions, bvh, sphereList: scene.spheres, ground: scene.ground },
  };
}

/**
 * Recognises the two-triangle layout produced by `quad(a, b, c, d)` —
 * triangles (a, b, c) and (a, c, d) — and returns its parallelogram
 * parameterisation, or `null` for any other mesh.
 */
export function quadFromMesh(mesh: Mesh): { position: Vec3; edge1: Vec3; edge2: Vec3 } | null {
  if (triangleCount(mesh) !== 2) return null;
  const v = (i: number): Vec3 => [mesh.positions[i * 3]!, mesh.positions[i * 3 + 1]!, mesh.positions[i * 3 + 2]!];
  const [a, b, c, a2, c2, d] = [v(0), v(1), v(2), v(3), v(4), v(5)];
  const same = (p: Vec3, q: Vec3) => length(sub(p, q)) < 1e-6;
  if (!same(a, a2) || !same(c, c2)) return null;
  const edge1 = sub(b, a);
  const edge2 = sub(d, a);
  // Must be a genuine parallelogram: a + e1 + e2 == c.
  const corner: Vec3 = [a[0] + edge1[0] + edge2[0], a[1] + edge1[1] + edge2[1], a[2] + edge1[2] + edge2[2]];
  if (!same(corner, c) || length(cross(edge1, edge2)) < 1e-9) return null;
  return { position: a, edge1, edge2 };
}

/** Closest hit distance against everything in the scene, or `null`. Used for click-to-focus. */
export function pickDistance(packed: PackedScene, ray: Ray): number | null {
  let best = Infinity;
  const tri = intersectBVH(packed.cpu.bvh, packed.cpu.positions, ray);
  if (tri) best = tri.t;
  for (const s of packed.cpu.sphereList) {
    const t = intersectSphere(ray, s.center, s.radius, 1e-5, best);
    if (t !== null) best = t;
  }
  const g = packed.cpu.ground;
  if (g.enabled && Math.abs(ray.dir[1]) > 1e-9) {
    const t = (g.height - ray.origin[1]) / ray.dir[1];
    if (t > 1e-5 && t < best) best = t;
  }
  return Number.isFinite(best) ? best : null;
}
