import { describe, expect, it } from 'vitest';
import { loadGLTF, parseGLB, textureTransform } from '../src/loaders/gltf';
import { makeGLB, pack, toBase64 } from './helpers/glb';

const noFetch = async (uri: string): Promise<ArrayBuffer> => {
  throw new Error(`unexpected fetch of ${uri}`);
};

const FLOAT = 5126;

/** One triangle in the XY plane, facing +Z, with normals and UVs, as a GLB. */
function triangleGLB(node: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]);
  const uvs = new Float32Array([0, 0, 1, 0, 0, 1]);
  const indices = new Uint16Array([0, 1, 2]);
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  const { bytes, offsets } = pack(positions, normals, uvs, indices, png);
  const json = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, ...node }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 }, baseColorFactor: [1, 0.5, 0.25, 1] } }],
    textures: [{ source: 0 }],
    images: [{ bufferView: 4, mimeType: 'image/png' }],
    accessors: [
      { bufferView: 0, componentType: FLOAT, count: 3, type: 'VEC3' },
      { bufferView: 1, componentType: FLOAT, count: 3, type: 'VEC3' },
      { bufferView: 2, componentType: FLOAT, count: 3, type: 'VEC2' },
      { bufferView: 3, componentType: 5123, count: 3, type: 'SCALAR' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: offsets[0], byteLength: 36 },
      { buffer: 0, byteOffset: offsets[1], byteLength: 36 },
      { buffer: 0, byteOffset: offsets[2], byteLength: 24 },
      { buffer: 0, byteOffset: offsets[3], byteLength: 6 },
      { buffer: 0, byteOffset: offsets[4], byteLength: 4 },
    ],
    buffers: [{ byteLength: bytes.length }],
    ...extra,
  };
  return makeGLB(json, bytes);
}

const vertex = (p: Float32Array, i: number) => [p[i * 3]!, p[i * 3 + 1]!, p[i * 3 + 2]!].map((x) => +x.toFixed(5) + 0);

describe('parseGLB', () => {
  it('splits the JSON and BIN chunks', () => {
    const glb = makeGLB({ asset: { version: '2.0' } }, new Uint8Array([1, 2, 3]));
    const { json, bin } = parseGLB(glb);
    expect(json.asset.version).toBe('2.0');
    expect(Array.from(bin!.subarray(0, 3))).toEqual([1, 2, 3]);
  });

  it('rejects other files', () => {
    expect(() => parseGLB(new TextEncoder().encode('{"asset":{}}').buffer as ArrayBuffer)).toThrow(/magic/);
  });
});

describe('loadGLTF', () => {
  it('reads an indexed, textured triangle from a GLB', async () => {
    const asset = await loadGLTF(triangleGLB(), noFetch);
    expect(asset.triangleCount).toBe(1);
    const { mesh, material } = asset.meshes[0]!;
    expect(vertex(mesh.positions, 1)).toEqual([1, 0, 0]);
    expect(vertex(mesh.normals, 0)).toEqual([0, 0, 1]);
    expect(Array.from(mesh.uvs!)).toEqual([0, 0, 1, 0, 0, 1]);
    const m = asset.materials[material]!;
    expect(m.albedo).toEqual([1, 0.5, 0.25]);
    expect(m.baseColorMap).toBe(0);
    expect(asset.images).toHaveLength(1);
    expect(asset.images[0]!.mimeType).toBe('image/png');
    expect(Array.from(asset.images[0]!.data)).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(asset.bounds).toEqual({ min: [0, 0, 0], max: [1, 1, 0] });
  });

  it('applies TRS node transforms, rotating normals with the geometry', async () => {
    // 90° about +Y maps +X to -Z and +Z to +X.
    const s = Math.SQRT1_2;
    const asset = await loadGLTF(triangleGLB({ translation: [1, 2, 3], rotation: [0, s, 0, s], scale: [2, 2, 2] }), noFetch);
    const { positions, normals } = asset.meshes[0]!.mesh;
    expect(vertex(positions, 0)).toEqual([1, 2, 3]);
    expect(vertex(positions, 1)).toEqual([1, 2, 1]);
    expect(vertex(positions, 2)).toEqual([1, 4, 3]);
    expect(vertex(normals, 0)).toEqual([1, 0, 0]);
  });

  it('accumulates transforms down the node hierarchy', async () => {
    const glb = triangleGLB({}, {
      scenes: [{ nodes: [1] }],
      nodes: [
        { mesh: 0, translation: [0, 0, 5] },
        { children: [0], matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 0, 0, 1] },
      ],
    });
    const asset = await loadGLTF(glb, noFetch);
    expect(vertex(asset.meshes[0]!.mesh.positions, 0)).toEqual([10, 0, 5]);
  });

  it('keeps winding and normals consistent under a mirroring transform', async () => {
    const asset = await loadGLTF(triangleGLB({ scale: [-1, 1, 1] }), noFetch);
    const { positions: p, normals } = asset.meshes[0]!.mesh;
    const e1 = [p[3]! - p[0]!, p[4]! - p[1]!, p[5]! - p[2]!];
    const e2 = [p[6]! - p[0]!, p[7]! - p[1]!, p[8]! - p[2]!];
    const gz = e1[0]! * e2[1]! - e1[1]! * e2[0]!;
    expect(Math.sign(gz)).toBe(Math.sign(normals[2]!));
    expect(normals[2]).toBeCloseTo(1);
  });

  it('generates flat normals when NORMAL is missing', async () => {
    const positions = new Float32Array([0, 0, 0, 0, 0, 1, 1, 0, 0]);
    const { bytes } = pack(positions);
    const json = {
      asset: { version: '2.0' },
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      accessors: [{ bufferView: 0, componentType: FLOAT, count: 3, type: 'VEC3' }],
      bufferViews: [{ buffer: 0, byteLength: 36 }],
      buffers: [{ byteLength: bytes.length }],
    };
    const asset = await loadGLTF(makeGLB(json, bytes), noFetch);
    expect(vertex(asset.meshes[0]!.mesh.normals, 2)).toEqual([0, 1, 0]);
    // No material on the primitive: glTF's default white, metallic, rough material.
    const m = asset.materials[asset.meshes[0]!.material]!;
    expect([m.albedo, m.metallic, m.roughness]).toEqual([[1, 1, 1], 1, 1]);
  });

  it('reads interleaved, normalized and strip-ordered vertex data', async () => {
    // Interleaved: float32 xyz + uint16 normalized uv per vertex (16 bytes stride).
    const stride = 16;
    const buf = new ArrayBuffer(stride * 4);
    const dv = new DataView(buf);
    const verts = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0]];
    verts.forEach((v, i) => {
      v.forEach((c, k) => dv.setFloat32(i * stride + k * 4, c, true));
      dv.setUint16(i * stride + 12, v[0]! * 65535, true);
      dv.setUint16(i * stride + 14, 32768, true);
    });
    const bytes = new Uint8Array(buf);
    const json = {
      asset: { version: '2.0' },
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ mode: 5, attributes: { POSITION: 0, TEXCOORD_0: 1 } }] }],
      accessors: [
        { bufferView: 0, componentType: FLOAT, count: 4, type: 'VEC3' },
        { bufferView: 0, byteOffset: 12, componentType: 5123, normalized: true, count: 4, type: 'VEC2' },
      ],
      bufferViews: [{ buffer: 0, byteLength: bytes.length, byteStride: stride }],
      buffers: [{ byteLength: bytes.length }],
    };
    const asset = await loadGLTF(makeGLB(json, bytes), noFetch);
    const { positions: p, normals: n, uvs } = asset.meshes[0]!.mesh;
    expect(asset.triangleCount).toBe(2);
    // Strip triangles (0,1,2) and (1,3,2) both face +Z.
    expect(n[2]).toBeCloseTo(1);
    expect(n[11]).toBeCloseTo(1);
    expect(vertex(p, 4)).toEqual([1, 1, 0]);
    expect(uvs![2]).toBeCloseTo(1);
    expect(uvs![3]).toBeCloseTo(32768 / 65535);
  });

  it('applies sparse accessor overrides', async () => {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const sparseIdx = new Uint16Array([2]);
    const sparseVal = new Float32Array([0, 7, 0]);
    const { bytes, offsets } = pack(positions, sparseIdx, sparseVal);
    const json = {
      asset: { version: '2.0' },
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      accessors: [{
        bufferView: 0, componentType: FLOAT, count: 3, type: 'VEC3',
        sparse: { count: 1, indices: { bufferView: 1, componentType: 5123 }, values: { bufferView: 2 } },
      }],
      bufferViews: [
        { buffer: 0, byteOffset: offsets[0], byteLength: 36 },
        { buffer: 0, byteOffset: offsets[1], byteLength: 2 },
        { buffer: 0, byteOffset: offsets[2], byteLength: 12 },
      ],
      buffers: [{ byteLength: bytes.length }],
    };
    const asset = await loadGLTF(makeGLB(json, bytes), noFetch);
    expect(vertex(asset.meshes[0]!.mesh.positions, 2)).toEqual([0, 7, 0]);
  });

  it('loads .gltf JSON with data-URI buffers and only fetches images that are used', async () => {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const uvs = new Float32Array([0, 0, 1, 0, 0, 1]);
    const { bytes, offsets } = pack(positions, uvs);
    const json = {
      asset: { version: '2.0' },
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, material: 0 }] }],
      materials: [{ normalTexture: { index: 0, scale: 0.5 } }],
      textures: [{ source: 1 }],
      images: [{ uri: 'unused.png' }, { uri: 'tex%20normal.jpg' }],
      accessors: [
        { bufferView: 0, componentType: FLOAT, count: 3, type: 'VEC3' },
        { bufferView: 1, componentType: FLOAT, count: 3, type: 'VEC2' },
      ],
      bufferViews: [
        { buffer: 0, byteOffset: offsets[0], byteLength: 36 },
        { buffer: 0, byteOffset: offsets[1], byteLength: 24 },
      ],
      buffers: [{ byteLength: bytes.length, uri: `data:application/octet-stream;base64,${toBase64(bytes)}` }],
    };
    const fetched: string[] = [];
    const asset = await loadGLTF(new TextEncoder().encode(JSON.stringify(json)).buffer as ArrayBuffer, async (uri) => {
      fetched.push(uri);
      return new Uint8Array([9]).buffer;
    });
    expect(fetched).toEqual(['tex%20normal.jpg']);
    expect(asset.images[0]!.mimeType).toBe('image/jpeg');
    const m = asset.materials[0]!;
    expect([m.normalMap, m.normalScale, m.baseColorMap]).toEqual([0, 0.5, -1]);
  });

  it('maps PBR extensions onto the material model', async () => {
    const glb = triangleGLB({}, {
      materials: [{
        alphaMode: 'MASK',
        alphaCutoff: 0.3,
        emissiveFactor: [1, 0.5, 0],
        pbrMetallicRoughness: { metallicFactor: 0.25, roughnessFactor: 0.75 },
        extensions: {
          KHR_materials_emissive_strength: { emissiveStrength: 4 },
          KHR_materials_transmission: { transmissionFactor: 0.9 },
          KHR_materials_ior: { ior: 1.33 },
          KHR_materials_volume: { thicknessFactor: 0.1, attenuationDistance: 2, attenuationColor: [1, 0.5, 0.5] },
          KHR_materials_clearcoat: { clearcoatFactor: 1, clearcoatRoughnessFactor: 0.1 },
          KHR_materials_sheen: { sheenColorFactor: [0.2, 0.3, 0.4], sheenRoughnessFactor: 0.5 },
          KHR_materials_iridescence: { iridescenceFactor: 1 },
        },
      }],
    });
    const asset = await loadGLTF(glb, noFetch);
    const m = asset.materials[0]!;
    expect(m.alphaMode).toBe('mask');
    expect(m.alphaCutoff).toBe(0.3);
    expect(m.emission).toEqual([4, 2, 0]);
    expect([m.metallic, m.roughness, m.transmission, m.ior]).toEqual([0.25, 0.75, 0.9, 1.33]);
    expect([m.thinWalled, m.attenuationDistance, m.attenuationColor]).toEqual([false, 2, [1, 0.5, 0.5]]);
    expect([m.clearcoat, m.clearcoatRoughness, m.sheenRoughness]).toEqual([1, 0.1, 0.5]);
    expect(m.sheenColor).toEqual([0.2, 0.3, 0.4]);
    expect(asset.warnings.some((w) => w.includes('KHR_materials_iridescence'))).toBe(true);
    // No textures referenced, so the embedded image is not returned.
    expect(asset.images).toHaveLength(0);
  });

  it('treats transmission without a volume as thin-walled', async () => {
    const asset = await loadGLTF(triangleGLB({}, {
      materials: [{ extensions: { KHR_materials_transmission: { transmissionFactor: 1 } } }],
    }), noFetch);
    expect(asset.materials[0]!.thinWalled).toBe(true);
  });

  it('refuses files that require unsupported compression', async () => {
    const glb = triangleGLB({}, { extensionsRequired: ['KHR_draco_mesh_compression'] });
    await expect(loadGLTF(glb, noFetch)).rejects.toThrow(/KHR_draco_mesh_compression/);
  });

  it('rejects glTF 1.0', async () => {
    const buf = new TextEncoder().encode(JSON.stringify({ asset: { version: '1.0' } })).buffer as ArrayBuffer;
    await expect(loadGLTF(buf, noFetch)).rejects.toThrow(/only 2.0/);
  });
});

describe('textureTransform', () => {
  const apply = (m: readonly number[], u: number, v: number) =>
    [m[0]! * u + m[1]! * v + m[2]!, m[3]! * u + m[4]! * v + m[5]!].map((x) => +x.toFixed(6) + 0);

  it('is the identity without the extension', () => {
    expect(apply(textureTransform(undefined), 0.3, 0.7)).toEqual([0.3, 0.7]);
  });

  it('scales, then rotates counter-clockwise, then offsets', () => {
    const m = textureTransform({ offset: [0.5, 0.25], scale: [2, 3], rotation: Math.PI / 2 });
    // scale (1, 0) → (2, 0); rotate 90° → (0, 2); offset → (0.5, 2.25)
    expect(apply(m, 1, 0)).toEqual([0.5, 2.25]);
    // scale (0, 1) → (0, 3); rotate 90° → (-3, 0); offset → (-2.5, 0.25)
    expect(apply(m, 0, 1)).toEqual([-2.5, 0.25]);
  });
});
