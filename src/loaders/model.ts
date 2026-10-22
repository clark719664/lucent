import type { Vec3 } from '../math/vec3';
import type { Environment, HDRImage } from '../scene/environment';
import { matte } from '../scene/material';
import type { Mesh } from '../scene/mesh';
import { daySky, defaultSun } from '../scene/presets';
import type { Scene, SceneTexture } from '../scene/scene';
import { loadGLTF, type GLTFAsset, type ResourceResolver } from './gltf';
import { parseHDR } from './hdr';

/** A dropped or picked file and its path inside the drop (folders keep their structure). */
export interface InputFile {
  file: File;
  path: string;
}

export interface LoadedModel {
  name: string;
  asset: GLTFAsset;
  textures: SceneTexture[];
  warnings: string[];
}

const basename = (p: string): string => p.split('/').pop() ?? p;
const stem = (p: string): string => basename(p).replace(/\.[^.]+$/, '');

function normalizePath(uri: string): string {
  let p = uri.split(/[?#]/)[0]!.replace(/\\/g, '/');
  try {
    p = decodeURIComponent(p);
  } catch {
    // Not percent-encoded after all.
  }
  return p.replace(/^\.\//, '');
}

async function fetchBuffer(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} fetching ${url}`);
  return res.arrayBuffer();
}

/** Decodes every image; one that fails is dropped from the materials rather than failing the model. */
async function decodeImages(asset: GLTFAsset): Promise<{ textures: SceneTexture[]; warnings: string[] }> {
  const warnings: string[] = [];
  const results = await Promise.allSettled(asset.images.map((img) =>
    createImageBitmap(new Blob([img.data as Uint8Array<ArrayBuffer>], { type: img.mimeType }), {
      premultiplyAlpha: 'none',
      colorSpaceConversion: 'none',
    })));
  let blank: ImageBitmap | null = null;
  const placeholder = (): ImageBitmap => {
    if (!blank) {
      const canvas = new OffscreenCanvas(1, 1);
      canvas.getContext('2d');
      blank = canvas.transferToImageBitmap();
    }
    return blank;
  };
  const textures = results.map((r, i): SceneTexture => {
    const name = asset.images[i]!.name;
    if (r.status === 'fulfilled') return { image: r.value, name };
    warnings.push(`could not decode image "${name}"`);
    for (const m of asset.materials) {
      if (m.baseColorMap === i) m.baseColorMap = -1;
      if (m.metalRoughMap === i) m.metalRoughMap = -1;
      if (m.normalMap === i) m.normalMap = -1;
      if (m.emissiveMap === i) m.emissiveMap = -1;
    }
    return { image: placeholder(), name };
  });
  return { textures, warnings };
}

async function finish(name: string, asset: GLTFAsset): Promise<LoadedModel> {
  const { textures, warnings } = await decodeImages(asset);
  return { name, asset, textures, warnings: [...asset.warnings, ...warnings] };
}

/** Loads a .glb, or a .gltf with its buffers and images found among `files` by relative path or name. */
export async function loadModelFiles(files: InputFile[]): Promise<LoadedModel> {
  const main = files.find((f) => /\.glb$/i.test(f.path)) ?? files.find((f) => /\.gltf$/i.test(f.path));
  if (!main) throw new Error('drop a .glb or .gltf file (with its .bin and textures, or the folder holding them)');
  const dir = main.path.includes('/') ? main.path.slice(0, main.path.lastIndexOf('/') + 1) : '';
  const byPath = new Map(files.map((f) => [f.path, f.file]));
  const byName = new Map(files.map((f) => [basename(f.path).toLowerCase(), f.file]));
  const resolve: ResourceResolver = async (uri) => {
    const rel = normalizePath(uri);
    const file = byPath.get(dir + rel) ?? byPath.get(rel) ?? byName.get(basename(rel).toLowerCase());
    if (!file) throw new Error(`"${rel}" is missing; drop it together with ${basename(main.path)}`);
    return file.arrayBuffer();
  };
  return finish(stem(main.path), await loadGLTF(await main.file.arrayBuffer(), resolve));
}

export async function loadModelURL(url: string, name: string): Promise<LoadedModel> {
  const resolve: ResourceResolver = (uri) => fetchBuffer(new URL(uri, url).href);
  return finish(name, await loadGLTF(await fetchBuffer(url), resolve));
}

export const loadHDRFile = async (file: File): Promise<HDRImage> => parseHDR(await file.arrayBuffer());
export const loadHDRURL = async (url: string): Promise<HDRImage> => parseHDR(await fetchBuffer(url));

function placeMesh(mesh: Mesh, offset: Vec3, s: number): Mesh {
  const positions = new Float32Array(mesh.positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    positions[i] = (mesh.positions[i]! - offset[0]) * s;
    positions[i + 1] = (mesh.positions[i + 1]! - offset[1]) * s;
    positions[i + 2] = (mesh.positions[i + 2]! - offset[2]) * s;
  }
  return mesh.uvs ? { positions, normals: mesh.normals, uvs: mesh.uvs } : { positions, normals: mesh.normals };
}

export interface FramingOptions {
  /** Camera azimuth and elevation around the model, in degrees. */
  azimuth?: number;
  elevation?: number;
  /** Multiplies the distance that just fits the bounding sphere. */
  distance?: number;
  exposure?: number;
  groundColor?: Vec3;
  groundRoughness?: number;
}

/**
 * Wraps a loaded model in a scene: rescaled so its bounding sphere has radius 1,
 * standing on an analytic ground plane at y = 0, framed by the camera. Volume
 * attenuation distances are rescaled with the geometry so glass keeps its colour.
 */
export function sceneFromModel(model: LoadedModel, env: Environment, opts: FramingOptions = {}): Scene {
  const { min, max } = model.asset.bounds;
  const radius = 0.5 * Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) || 1;
  const s = 1 / radius;
  const offset: Vec3 = [(min[0] + max[0]) / 2, min[1], (min[2] + max[2]) / 2];
  const materials = model.asset.materials.map((m) =>
    Number.isFinite(m.attenuationDistance) ? { ...m, attenuationDistance: m.attenuationDistance * s } : m);
  const height = (max[1] - min[1]) * s;
  const halfWidth = 0.5 * Math.max(max[0] - min[0], max[2] - min[2]) * s;
  const fov = 40;
  const tan = Math.tan((fov * Math.PI) / 360);
  const target: Vec3 = [0, height / 2, 0];
  // Fit the box, not its bounding sphere, assuming a landscape view about 1.5 : 1.
  const dist = Math.max(height / 2 / tan, halfWidth / (tan * 1.5)) * (opts.distance ?? 1.1) + halfWidth;
  const az = ((opts.azimuth ?? 30) * Math.PI) / 180;
  const el = ((opts.elevation ?? 14) * Math.PI) / 180;
  const position: Vec3 = [
    target[0] + dist * Math.sin(az) * Math.cos(el),
    target[1] + dist * Math.sin(el),
    target[2] + dist * Math.cos(az) * Math.cos(el),
  ];
  const tris = model.asset.triangleCount.toLocaleString('en-US');
  const maps = model.textures.length;
  return {
    name: model.name,
    description: `${tris} triangles · ${materials.length} material${materials.length === 1 ? '' : 's'} · ${maps} texture${maps === 1 ? '' : 's'}`,
    exposure: opts.exposure ?? 1,
    camera: { position, target, fov, aperture: 0, focusDistance: dist },
    sun: defaultSun(),
    sky: daySky(1),
    env,
    // A hair below the model so flat bases do not z-fight with the plane.
    ground: { enabled: true, height: -1e-3, material: matte(opts.groundColor ?? [0.4, 0.4, 0.42], opts.groundRoughness ?? 0.9) },
    spheres: [],
    meshes: model.asset.meshes.map(({ mesh, material }) => ({ mesh: placeMesh(mesh, offset, s), material: materials[material]! })),
    textures: model.textures,
  };
}
