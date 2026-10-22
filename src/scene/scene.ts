import { buildBVH, intersectBVH, NODE_STRIDE, type BVH } from '../math/bvh';
import type { Ray } from '../math/ray';
import { intersectSphere } from '../math/ray';
import type { Vec3 } from '../math/vec3';
import { cross, length, sub } from '../math/vec3';
import { isEmissive, packMaterials, type Material } from './material';
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

export interface Sphere {
  center: Vec3;
  radius: number;
  material: Material;
}

export interface MeshInstance {
  mesh: Mesh;
  material: Material;
}

export interface Scene {
  name: string;
  description: string;
  /** Suggested display exposure; sunlit scenes carry far more energy than lamp-lit ones. */
  exposure: number;
  camera: Camera;
  sun: Sun;
  sky: Sky;
  spheres: Sphere[];
  meshes: MeshInstance[];
}

export const MAX_SPHERES = 64;
export const MAX_LIGHTS = 8;
export const TRI_TEXELS = 6;
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
  triangles: Float32Array;
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
  /** CPU-side copies kept for picking. */
  cpu: {
    positions: Float32Array;
    bvh: BVH;
    sphereList: Sphere[];
  };
}

/**
 * Flattens a scene into GPU texel arrays.
 *
 * Triangles are written in BVH leaf order, so the shader indexes the triangle
 * texture directly from a leaf's `leftFirst` with no indirection table.
 */
export function packScene(scene: Scene): PackedScene {
  if (scene.spheres.length > MAX_SPHERES) {
    throw new Error(`scene has ${scene.spheres.length} spheres; max is ${MAX_SPHERES}`);
  }

  // Materials are deduplicated by reference so shared library entries pack once.
  const materials: Material[] = [];
  const materialIndex = (m: Material): number => {
    let i = materials.indexOf(m);
    if (i === -1) {
      i = materials.length;
      materials.push(m);
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
  const triMaterial = new Int32Array(triangleCount(merged));
  const triLight = new Int32Array(triangleCount(merged)).fill(-1);
  let cursor = 0;
  for (const inst of scene.meshes) {
    const n = triangleCount(inst.mesh);
    triMaterial.fill(materialIndex(inst.material), cursor, cursor + n);
    // Emissive quads built with `quad()` become explicitly sampled area lights.
    const asQuad = isEmissive(inst.material) ? quadFromMesh(inst.mesh) : null;
    if (asQuad) {
      const li = addLight({ ...asQuad, type: 'quad', radius: 0, radiance: inst.material.emission });
      triLight.fill(li, cursor, cursor + n);
    }
    cursor += n;
  }

  const bvh = buildBVH(merged.positions);
  const triCount = triangleCount(merged);
  const triangles = new Float32Array(triCount * TRI_TEXELS * 4);
  for (let slot = 0; slot < triCount; slot++) {
    const src = bvh.triIndices[slot]!;
    const p = src * 9;
    const o = slot * TRI_TEXELS * 4;
    const pos = merged.positions;
    const nrm = merged.normals;
    triangles.set([pos[p]!, pos[p + 1]!, pos[p + 2]!, triMaterial[src]!], o);
    triangles.set([pos[p + 3]!, pos[p + 4]!, pos[p + 5]!, triLight[src]!], o + 4);
    triangles.set([pos[p + 6]!, pos[p + 7]!, pos[p + 8]!, 0], o + 8);
    triangles.set([nrm[p]!, nrm[p + 1]!, nrm[p + 2]!, 0], o + 12);
    triangles.set([nrm[p + 3]!, nrm[p + 4]!, nrm[p + 5]!, 0], o + 16);
    triangles.set([nrm[p + 6]!, nrm[p + 7]!, nrm[p + 8]!, 0], o + 20);
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

  const lights = new Float32Array(MAX_LIGHTS * LIGHT_TEXELS * 4);
  lightList.forEach((l, i) => {
    const o = i * LIGHT_TEXELS * 4;
    lights.set([...l.position, l.type === 'sphere' ? 0 : 1], o);
    lights.set([...l.edge1, l.radius], o + 4);
    lights.set([...l.edge2, 0], o + 8);
    lights.set([...l.radiance, 0], o + 12);
  });

  return {
    triangles,
    triCount,
    bvhNodes,
    bvhNodeCount: bvh.nodeCount,
    materials: packMaterials(materials),
    materialCount: materials.length,
    spheres,
    sphereMaterials,
    sphereCount: scene.spheres.length,
    sphereLights,
    lights,
    lightCount: lightList.length,
    lightList,
    cpu: { positions: merged.positions, bvh, sphereList: scene.spheres },
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
  return Number.isFinite(best) ? best : null;
}
