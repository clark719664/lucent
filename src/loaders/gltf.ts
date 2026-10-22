import type { Vec3 } from '../math/vec3';
import { IDENTITY_UV, material, type AlphaMode, type Material, type UVTransform } from '../scene/material';
import type { Mesh } from '../scene/mesh';

/**
 * glTF 2.0 / GLB parser that produces Lucent meshes and materials directly.
 * It needs no DOM: images come back as encoded bytes for the caller to decode,
 * so everything here runs (and is tested) under Node.
 */

export interface GLTFImage {
  data: Uint8Array;
  mimeType: string;
  name: string;
}

export interface GLTFAsset {
  /** One entry per primitive, already in world space. `material` indexes `materials`. */
  meshes: { mesh: Mesh; material: number }[];
  /** Map fields (`baseColorMap` …) index `images`. */
  materials: Material[];
  /** Only images that some material samples. */
  images: GLTFImage[];
  bounds: { min: Vec3; max: Vec3 };
  triangleCount: number;
  warnings: string[];
}

/** Fetches an external resource referenced by a relative URI. */
export type ResourceResolver = (uri: string) => Promise<ArrayBuffer>;

/* eslint-disable @typescript-eslint/no-explicit-any -- glTF JSON is validated field by field below. */
type Json = any;

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

/** Extensions whose absence would break geometry or textures; refuse rather than render garbage. */
const UNSUPPORTED_REQUIRED = new Set([
  'KHR_draco_mesh_compression',
  'EXT_meshopt_compression',
  'KHR_texture_basisu',
  'MSFT_texture_dds',
  'EXT_mesh_gpu_instancing',
]);

const HANDLED_MATERIAL_EXTENSIONS = new Set([
  'KHR_materials_emissive_strength',
  'KHR_materials_transmission',
  'KHR_materials_ior',
  'KHR_materials_volume',
  'KHR_materials_clearcoat',
  'KHR_materials_sheen',
  'KHR_materials_unlit',
]);

export function isGLB(buffer: ArrayBuffer): boolean {
  return buffer.byteLength >= 12 && new DataView(buffer).getUint32(0, true) === GLB_MAGIC;
}

export function parseGLB(buffer: ArrayBuffer): { json: Json; bin: Uint8Array | null } {
  const view = new DataView(buffer);
  if (!isGLB(buffer)) throw new Error('not a GLB file (bad magic)');
  const version = view.getUint32(4, true);
  if (version !== 2) throw new Error(`GLB version ${version} is not supported; only glTF 2.0`);
  const length = Math.min(view.getUint32(8, true), buffer.byteLength);
  let offset = 12;
  let json: Json = null;
  let bin: Uint8Array | null = null;
  while (offset + 8 <= length) {
    const chunkLength = view.getUint32(offset, true);
    const chunkType = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (start + chunkLength > length) throw new Error('GLB chunk runs past the end of the file');
    if (chunkType === CHUNK_JSON) json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, start, chunkLength)));
    else if (chunkType === CHUNK_BIN && bin === null) bin = new Uint8Array(buffer, start, chunkLength);
    offset = start + chunkLength + ((4 - (chunkLength % 4)) % 4);
  }
  if (!json) throw new Error('GLB has no JSON chunk');
  return { json, bin };
}

function decodeDataUri(uri: string): ArrayBuffer {
  const comma = uri.indexOf(',');
  if (comma < 0) throw new Error('malformed data URI');
  const meta = uri.slice(5, comma);
  const payload = uri.slice(comma + 1);
  if (!meta.endsWith(';base64')) return new TextEncoder().encode(decodeURIComponent(payload)).buffer as ArrayBuffer;
  const bin = atob(payload);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

const mimeFromDataUri = (uri: string): string => /^data:([^;,]+)/.exec(uri)?.[1] ?? '';

function mimeFromName(name: string): string {
  const ext = name.split(/[?#]/)[0]!.split('.').pop()?.toLowerCase();
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'ktx2') return 'image/ktx2';
  return 'application/octet-stream';
}

const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
const COMPONENT_BYTES: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };

type Reader = (dv: DataView, offset: number) => number;
function componentReader(type: number, normalized: boolean): Reader {
  switch (type) {
    case 5126: return (dv, o) => dv.getFloat32(o, true);
    case 5125: return (dv, o) => dv.getUint32(o, true);
    case 5123: return normalized ? (dv, o) => dv.getUint16(o, true) / 65535 : (dv, o) => dv.getUint16(o, true);
    case 5122: return normalized ? (dv, o) => Math.max(dv.getInt16(o, true) / 32767, -1) : (dv, o) => dv.getInt16(o, true);
    case 5121: return normalized ? (dv, o) => dv.getUint8(o) / 255 : (dv, o) => dv.getUint8(o);
    case 5120: return normalized ? (dv, o) => Math.max(dv.getInt8(o) / 127, -1) : (dv, o) => dv.getInt8(o);
    default: throw new Error(`unknown accessor componentType ${type}`);
  }
}

type Mat4 = Float64Array;

const identity = (): Mat4 => {
  const m = new Float64Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
};

function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float64Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r]! * b[c * 4 + k]!;
      out[c * 4 + r] = s;
    }
  }
  return out;
}

/** Column-major T · R · S, as glTF specifies for node transforms. */
export function composeTRS(t: readonly number[], q: readonly number[], s: readonly number[]): Mat4 {
  const [x, y, z, w] = [q[0]!, q[1]!, q[2]!, q[3]!];
  const m = new Float64Array(16);
  m[0] = (1 - 2 * (y * y + z * z)) * s[0]!;
  m[1] = 2 * (x * y + z * w) * s[0]!;
  m[2] = 2 * (x * z - y * w) * s[0]!;
  m[4] = 2 * (x * y - z * w) * s[1]!;
  m[5] = (1 - 2 * (x * x + z * z)) * s[1]!;
  m[6] = 2 * (y * z + x * w) * s[1]!;
  m[8] = 2 * (x * z + y * w) * s[2]!;
  m[9] = 2 * (y * z - x * w) * s[2]!;
  m[10] = (1 - 2 * (x * x + y * y)) * s[2]!;
  m[12] = t[0]!;
  m[13] = t[1]!;
  m[14] = t[2]!;
  m[15] = 1;
  return m;
}

/** Inverse-transpose of the upper 3×3 (row-major result) and its determinant. */
function normalMatrix(m: Mat4): { n: number[]; det: number } {
  const a = m[0]!, b = m[4]!, c = m[8]!;
  const d = m[1]!, e = m[5]!, f = m[9]!;
  const g = m[2]!, h = m[6]!, i = m[10]!;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  const inv = det === 0 ? 0 : 1 / det;
  // Cofactor matrix / det == inverse-transpose.
  const n = [
    A * inv, B * inv, C * inv,
    -(b * i - c * h) * inv, (a * i - c * g) * inv, -(a * h - b * g) * inv,
    (b * f - c * e) * inv, -(a * f - c * d) * inv, (a * e - b * d) * inv,
  ];
  return { n, det };
}

/** KHR_texture_transform: T(offset) · R(rotation) · S(scale) as a row-major 2×3 matrix. */
export function textureTransform(ext: Json): UVTransform {
  if (!ext) return IDENTITY_UV;
  const [ox, oy] = ext.offset ?? [0, 0];
  const [sx, sy] = ext.scale ?? [1, 1];
  const r = ext.rotation ?? 0;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [c * sx, -s * sy, ox, s * sx, c * sy, oy];
}

export async function loadGLTF(source: ArrayBuffer, resolve: ResourceResolver): Promise<GLTFAsset> {
  let json: Json;
  let glbBin: Uint8Array | null = null;
  if (isGLB(source)) ({ json, bin: glbBin } = parseGLB(source));
  else json = JSON.parse(new TextDecoder().decode(source));

  const version = String(json?.asset?.version ?? '');
  if (!version.startsWith('2')) throw new Error(`glTF version "${version || 'unknown'}" is not supported; only 2.0`);
  const warnings: string[] = [];
  const warn = (msg: string) => {
    if (!warnings.includes(msg)) warnings.push(msg);
  };

  for (const ext of (json.extensionsRequired ?? []) as string[]) {
    if (UNSUPPORTED_REQUIRED.has(ext)) throw new Error(`this file requires ${ext}, which Lucent does not support`);
  }

  const buffers: Uint8Array[] = await Promise.all(
    ((json.buffers ?? []) as Json[]).map(async (b, i): Promise<Uint8Array> => {
      if (b.uri === undefined) {
        if (i === 0 && glbBin) return glbBin;
        throw new Error(`buffer ${i} has no uri and there is no GLB binary chunk`);
      }
      const data = String(b.uri).startsWith('data:') ? decodeDataUri(b.uri) : await resolve(b.uri);
      return new Uint8Array(data);
    }),
  );

  const bufferViewBytes = (index: number): { bytes: Uint8Array; stride: number } => {
    const view = json.bufferViews?.[index];
    if (!view) throw new Error(`missing bufferView ${index}`);
    const buf = buffers[view.buffer];
    if (!buf) throw new Error(`bufferView ${index} references missing buffer ${view.buffer}`);
    const start = view.byteOffset ?? 0;
    if (start + view.byteLength > buf.byteLength) throw new Error(`bufferView ${index} runs past its buffer`);
    return { bytes: buf.subarray(start, start + view.byteLength), stride: view.byteStride ?? 0 };
  };

  const accessorCache = new Map<number, { data: Float32Array; size: number; count: number }>();
  const readAccessor = (index: number): { data: Float32Array; size: number; count: number } => {
    const cached = accessorCache.get(index);
    if (cached) return cached;
    const acc = json.accessors?.[index];
    if (!acc) throw new Error(`missing accessor ${index}`);
    const size = COMPONENTS[acc.type];
    const compBytes = COMPONENT_BYTES[acc.componentType];
    if (!size || !compBytes) throw new Error(`accessor ${index} has unsupported type ${acc.type}/${acc.componentType}`);
    const count: number = acc.count;
    const out = new Float32Array(count * size);
    const read = componentReader(acc.componentType, acc.normalized === true);

    if (acc.bufferView !== undefined) {
      const { bytes, stride } = bufferViewBytes(acc.bufferView);
      const elementBytes = size * compBytes;
      const step = stride || elementBytes;
      const base = acc.byteOffset ?? 0;
      if (count > 0 && base + step * (count - 1) + elementBytes > bytes.byteLength) {
        throw new Error(`accessor ${index} reads past its bufferView`);
      }
      const absolute = bytes.byteOffset + base;
      if (acc.componentType === 5126 && step === elementBytes && absolute % 4 === 0) {
        out.set(new Float32Array(bytes.buffer, absolute, count * size));
      } else {
        const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        for (let i = 0; i < count; i++) {
          const o = base + i * step;
          for (let c = 0; c < size; c++) out[i * size + c] = read(dv, o + c * compBytes);
        }
      }
    }

    if (acc.sparse) {
      const { count: n, indices, values } = acc.sparse;
      const idx = bufferViewBytes(indices.bufferView);
      const val = bufferViewBytes(values.bufferView);
      const idxBytes = COMPONENT_BYTES[indices.componentType]!;
      const readIdx = componentReader(indices.componentType, false);
      const idv = new DataView(idx.bytes.buffer, idx.bytes.byteOffset, idx.bytes.byteLength);
      const vdv = new DataView(val.bytes.buffer, val.bytes.byteOffset, val.bytes.byteLength);
      for (let k = 0; k < n; k++) {
        const target = readIdx(idv, (indices.byteOffset ?? 0) + k * idxBytes);
        if (target >= count) throw new Error(`sparse index ${target} out of range in accessor ${index}`);
        for (let c = 0; c < size; c++) {
          out[target * size + c] = read(vdv, (values.byteOffset ?? 0) + (k * size + c) * compBytes);
        }
      }
    }
    const result = { data: out, size, count };
    accessorCache.set(index, result);
    return result;
  };

  // Images are resolved lazily so that unused ones are never fetched.
  const imageRemap = new Map<number, number>();
  const imageLoads: Promise<GLTFImage>[] = [];
  const useImage = (imageIndex: number): number => {
    let slot = imageRemap.get(imageIndex);
    if (slot !== undefined) return slot;
    const img = json.images?.[imageIndex];
    if (!img) return -1;
    slot = imageLoads.length;
    imageRemap.set(imageIndex, slot);
    const name = String(img.name ?? img.uri ?? `image ${imageIndex}`);
    imageLoads.push((async (): Promise<GLTFImage> => {
      if (img.bufferView !== undefined) {
        const { bytes } = bufferViewBytes(img.bufferView);
        return { data: bytes, mimeType: img.mimeType ?? 'image/png', name };
      }
      const uri = String(img.uri);
      if (uri.startsWith('data:')) return { data: new Uint8Array(decodeDataUri(uri)), mimeType: mimeFromDataUri(uri), name };
      return { data: new Uint8Array(await resolve(uri)), mimeType: img.mimeType ?? mimeFromName(uri), name };
    })());
    return slot;
  };

  const textureSlot = (info: Json): number => {
    if (!info || info.index === undefined) return -1;
    const tex = json.textures?.[info.index];
    if (!tex) return -1;
    if ((info.texCoord ?? 0) !== 0) warn('textures on TEXCOORD_1 or higher are sampled with TEXCOORD_0');
    const source = tex.extensions?.EXT_texture_webp?.source ?? tex.source;
    if (source === undefined) {
      if (tex.extensions?.KHR_texture_basisu) warn('KTX2/Basis textures are not supported and were skipped');
      return -1;
    }
    const mime = json.images?.[source]?.mimeType ?? mimeFromName(String(json.images?.[source]?.uri ?? ''));
    if (mime === 'image/ktx2') {
      warn('KTX2/Basis textures are not supported and were skipped');
      return -1;
    }
    return useImage(source);
  };

  const convertMaterial = (m: Json): Material => {
    const pbr = m.pbrMetallicRoughness ?? {};
    const ext = m.extensions ?? {};
    for (const name of Object.keys(ext)) {
      if (!HANDLED_MATERIAL_EXTENSIONS.has(name)) warn(`material extension ${name} is ignored`);
    }
    const bc: number[] = pbr.baseColorFactor ?? [1, 1, 1, 1];
    const emissiveStrength = ext.KHR_materials_emissive_strength?.emissiveStrength ?? 1;
    const ef: number[] = m.emissiveFactor ?? [0, 0, 0];
    const transformSource = [pbr.baseColorTexture, pbr.metallicRoughnessTexture, m.normalTexture, m.emissiveTexture]
      .find((t) => t?.extensions?.KHR_texture_transform);
    const volume = ext.KHR_materials_volume;
    const alphaMode: AlphaMode = m.alphaMode === 'MASK' ? 'mask' : m.alphaMode === 'BLEND' ? 'blend' : 'opaque';
    const out = material({
      albedo: [bc[0]!, bc[1]!, bc[2]!],
      alpha: bc[3] ?? 1,
      alphaMode,
      alphaCutoff: m.alphaCutoff ?? 0.5,
      metallic: pbr.metallicFactor ?? 1,
      roughness: pbr.roughnessFactor ?? 1,
      baseColorMap: textureSlot(pbr.baseColorTexture),
      metalRoughMap: textureSlot(pbr.metallicRoughnessTexture),
      normalMap: textureSlot(m.normalTexture),
      normalScale: m.normalTexture?.scale ?? 1,
      emissiveMap: textureSlot(m.emissiveTexture),
      emission: [ef[0]! * emissiveStrength, ef[1]! * emissiveStrength, ef[2]! * emissiveStrength],
      transmission: ext.KHR_materials_transmission?.transmissionFactor ?? 0,
      ior: ext.KHR_materials_ior?.ior ?? 1.5,
      thinWalled: !volume || (volume.thicknessFactor ?? 0) === 0,
      attenuationColor: volume?.attenuationColor ?? [1, 1, 1],
      attenuationDistance: volume?.attenuationDistance ?? Infinity,
      clearcoat: ext.KHR_materials_clearcoat?.clearcoatFactor ?? 0,
      clearcoatRoughness: ext.KHR_materials_clearcoat?.clearcoatRoughnessFactor ?? 0,
      sheenColor: ext.KHR_materials_sheen?.sheenColorFactor ?? [0, 0, 0],
      sheenRoughness: ext.KHR_materials_sheen?.sheenRoughnessFactor ?? 0,
      uvTransform: textureTransform(transformSource?.extensions?.KHR_texture_transform),
    });
    if (ext.KHR_materials_unlit) {
      return { ...out, emission: out.albedo, emissiveMap: out.baseColorMap, albedo: [0, 0, 0], metallic: 0 };
    }
    return out;
  };

  const materials: Material[] = ((json.materials ?? []) as Json[]).map(convertMaterial);
  let defaultMaterial = -1;
  const materialFor = (index: number | undefined): number => {
    if (index !== undefined && materials[index]) return index;
    if (defaultMaterial < 0) {
      // The glTF default material: white, fully metallic, fully rough.
      defaultMaterial = materials.length;
      materials.push(material({ albedo: [1, 1, 1], metallic: 1, roughness: 1 }));
    }
    return defaultMaterial;
  };

  const meshes: GLTFAsset['meshes'] = [];
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  let triangleCount = 0;

  const emitPrimitive = (prim: Json, world: Mat4): void => {
    const mode = prim.mode ?? 4;
    if (mode !== 4 && mode !== 5 && mode !== 6) {
      warn('point and line primitives are skipped');
      return;
    }
    if (prim.extensions?.KHR_draco_mesh_compression) throw new Error('Draco-compressed meshes are not supported');
    if (prim.attributes?.POSITION === undefined) return;
    const pos = readAccessor(prim.attributes.POSITION);
    const nrm = prim.attributes.NORMAL !== undefined ? readAccessor(prim.attributes.NORMAL) : null;
    const uv = prim.attributes.TEXCOORD_0 !== undefined ? readAccessor(prim.attributes.TEXCOORD_0) : null;
    const vertexCount = pos.count;
    const idx = prim.indices !== undefined ? readAccessor(prim.indices).data : null;
    const n = idx ? idx.length : vertexCount;
    const vertex = (k: number): number => (idx ? idx[k]! : k);

    const tris: number[] = [];
    if (mode === 4) {
      for (let k = 0; k + 2 < n; k += 3) tris.push(vertex(k), vertex(k + 1), vertex(k + 2));
    } else if (mode === 5) {
      for (let k = 0; k + 2 < n; k++) {
        if (k % 2 === 0) tris.push(vertex(k), vertex(k + 1), vertex(k + 2));
        else tris.push(vertex(k), vertex(k + 2), vertex(k + 1));
      }
    } else {
      for (let k = 1; k + 1 < n; k++) tris.push(vertex(k), vertex(k + 1), vertex(0));
    }
    const triCount = tris.length / 3;
    if (triCount === 0) return;

    const { n: nm, det } = normalMatrix(world);
    const flip = det < 0;
    const positions = new Float32Array(triCount * 9);
    const normals = new Float32Array(triCount * 9);
    const uvs = uv ? new Float32Array(triCount * 6) : null;
    const p = pos.data;

    for (let t = 0; t < triCount; t++) {
      for (let c = 0; c < 3; c++) {
        // Mirroring transforms reverse winding; swap two corners to keep normals and winding agreeing.
        const corner = flip && c > 0 ? 3 - c : c;
        const v = tris[t * 3 + corner]!;
        if (v >= vertexCount) throw new Error(`index ${v} out of range (${vertexCount} vertices)`);
        const x = p[v * 3]!, y = p[v * 3 + 1]!, z = p[v * 3 + 2]!;
        const o = t * 9 + c * 3;
        const wx = world[0]! * x + world[4]! * y + world[8]! * z + world[12]!;
        const wy = world[1]! * x + world[5]! * y + world[9]! * z + world[13]!;
        const wz = world[2]! * x + world[6]! * y + world[10]! * z + world[14]!;
        positions[o] = wx;
        positions[o + 1] = wy;
        positions[o + 2] = wz;
        if (wx < min[0]) min[0] = wx;
        if (wy < min[1]) min[1] = wy;
        if (wz < min[2]) min[2] = wz;
        if (wx > max[0]) max[0] = wx;
        if (wy > max[1]) max[1] = wy;
        if (wz > max[2]) max[2] = wz;
        if (nrm) {
          const a = nrm.data[v * 3]!, b = nrm.data[v * 3 + 1]!, d = nrm.data[v * 3 + 2]!;
          const nx = nm[0]! * a + nm[1]! * b + nm[2]! * d;
          const ny = nm[3]! * a + nm[4]! * b + nm[5]! * d;
          const nz = nm[6]! * a + nm[7]! * b + nm[8]! * d;
          const len = Math.hypot(nx, ny, nz) || 1;
          normals[o] = nx / len;
          normals[o + 1] = ny / len;
          normals[o + 2] = nz / len;
        }
        if (uvs && uv) {
          uvs[t * 6 + c * 2] = uv.data[v * uv.size]!;
          uvs[t * 6 + c * 2 + 1] = uv.data[v * uv.size + 1]!;
        }
      }
      if (!nrm) {
        // glTF: missing normals mean flat shading.
        const o = t * 9;
        const e1x = positions[o + 3]! - positions[o]!, e1y = positions[o + 4]! - positions[o + 1]!, e1z = positions[o + 5]! - positions[o + 2]!;
        const e2x = positions[o + 6]! - positions[o]!, e2y = positions[o + 7]! - positions[o + 1]!, e2z = positions[o + 8]! - positions[o + 2]!;
        let cx = e1y * e2z - e1z * e2y, cy = e1z * e2x - e1x * e2z, cz = e1x * e2y - e1y * e2x;
        const len = Math.hypot(cx, cy, cz) || 1;
        cx /= len; cy /= len; cz /= len;
        for (let c = 0; c < 3; c++) normals.set([cx, cy, cz], o + c * 3);
      }
    }
    triangleCount += triCount;
    const mesh: Mesh = uvs ? { positions, normals, uvs } : { positions, normals };
    meshes.push({ mesh, material: materialFor(prim.material) });
  };

  const visit = (nodeIndex: number, parent: Mat4, depth: number): void => {
    if (depth > 64) throw new Error('node hierarchy is deeper than 64 levels (cycle?)');
    const node = json.nodes?.[nodeIndex];
    if (!node) throw new Error(`missing node ${nodeIndex}`);
    const local: Mat4 = node.matrix
      ? Float64Array.from(node.matrix as number[])
      : composeTRS(node.translation ?? [0, 0, 0], node.rotation ?? [0, 0, 0, 1], node.scale ?? [1, 1, 1]);
    const world = multiply(parent, local);
    if (node.mesh !== undefined) {
      const mesh = json.meshes?.[node.mesh];
      if (!mesh) throw new Error(`node ${nodeIndex} references missing mesh ${node.mesh}`);
      for (const prim of mesh.primitives ?? []) emitPrimitive(prim, world);
    }
    for (const child of (node.children ?? []) as number[]) visit(child, world, depth + 1);
  };

  let roots: number[];
  const sceneIndex = json.scene ?? 0;
  if (json.scenes?.[sceneIndex]) {
    roots = json.scenes[sceneIndex].nodes ?? [];
  } else {
    const children = new Set<number>();
    for (const node of (json.nodes ?? []) as Json[]) for (const c of (node.children ?? []) as number[]) children.add(c);
    roots = ((json.nodes ?? []) as Json[]).map((_, i) => i).filter((i) => !children.has(i));
  }
  for (const root of roots) visit(root, identity(), 0);
  if (triangleCount === 0) throw new Error('the file contains no triangle meshes');

  const images = await Promise.all(imageLoads);
  return { meshes, materials, images, bounds: { min, max }, triangleCount, warnings };
}
