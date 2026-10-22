import type { Vec3 } from '../math/vec3';
import { add, cross, normalize, scale, sub } from '../math/vec3';

/**
 * Triangle soup with per-vertex normals: 9 floats per triangle in each array.
 * Non-indexed on purpose; the GPU reads triangles straight out of a texture.
 */
export interface Mesh {
  positions: Float32Array;
  normals: Float32Array;
}

export const triangleCount = (m: Mesh): number => m.positions.length / 9;

export function mergeMeshes(meshes: readonly Mesh[]): Mesh {
  const total = meshes.reduce((n, m) => n + m.positions.length, 0);
  const positions = new Float32Array(total);
  const normals = new Float32Array(total);
  let offset = 0;
  for (const m of meshes) {
    positions.set(m.positions, offset);
    normals.set(m.normals, offset);
    offset += m.positions.length;
  }
  return { positions, normals };
}

/** Builds a mesh from an explicit triangle list with flat (face) normals. */
export function fromTriangles(tris: readonly (readonly [Vec3, Vec3, Vec3])[]): Mesh {
  const positions = new Float32Array(tris.length * 9);
  const normals = new Float32Array(tris.length * 9);
  tris.forEach(([a, b, c], i) => {
    const n = normalize(cross(sub(b, a), sub(c, a)));
    positions.set([...a, ...b, ...c], i * 9);
    normals.set([...n, ...n, ...n], i * 9);
  });
  return { positions, normals };
}

/** A quad given four corners in counter-clockwise order (normal faces the viewer). */
export function quad(a: Vec3, b: Vec3, c: Vec3, d: Vec3): Mesh {
  return fromTriangles([
    [a, b, c],
    [a, c, d],
  ]);
}

/** Horizontal square of half-size `half` centred at `center`, normal +Y. */
export function floor(center: Vec3, half: number): Mesh {
  const [x, y, z] = center;
  return quad(
    [x - half, y, z + half],
    [x + half, y, z + half],
    [x + half, y, z - half],
    [x - half, y, z - half],
  );
}

/** Axis-aligned box; `inward` flips the winding so faces point into the box (rooms). */
export function box(min: Vec3, max: Vec3, inward = false): Mesh {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const p = (x: number, y: number, z: number): Vec3 => [x, y, z];
  const faces: [Vec3, Vec3, Vec3, Vec3][] = [
    [p(x0, y0, z1), p(x1, y0, z1), p(x1, y1, z1), p(x0, y1, z1)], // +Z
    [p(x1, y0, z0), p(x0, y0, z0), p(x0, y1, z0), p(x1, y1, z0)], // -Z
    [p(x1, y0, z1), p(x1, y0, z0), p(x1, y1, z0), p(x1, y1, z1)], // +X
    [p(x0, y0, z0), p(x0, y0, z1), p(x0, y1, z1), p(x0, y1, z0)], // -X
    [p(x0, y1, z1), p(x1, y1, z1), p(x1, y1, z0), p(x0, y1, z0)], // +Y
    [p(x0, y0, z0), p(x1, y0, z0), p(x1, y0, z1), p(x0, y0, z1)], // -Y
  ];
  return mergeMeshes(
    faces.map(([a, b, c, d]) => (inward ? quad(d, c, b, a) : quad(a, b, c, d))),
  );
}

export interface TorusKnotOptions {
  p?: number;
  q?: number;
  radius?: number;
  tube?: number;
  tubularSegments?: number;
  radialSegments?: number;
}

/**
 * Parametric (p, q) torus knot with smooth normals from the Frenet-like frame.
 * Defaults give a trefoil with ~8k triangles, a good BVH workout.
 */
export function torusKnot(options: TorusKnotOptions = {}): Mesh {
  const {
    p = 2,
    q = 3,
    radius = 1,
    tube = 0.32,
    tubularSegments = 200,
    radialSegments = 20,
  } = options;

  const curve = (t: number): Vec3 => {
    const cu = Math.cos(t);
    const su = Math.sin(t);
    const quOverP = (q / p) * t;
    const cs = Math.cos(quOverP);
    return [radius * (2 + cs) * 0.5 * cu, radius * (2 + cs) * su * 0.5, radius * Math.sin(quOverP) * 0.5];
  };

  // Ring of vertices around each point on the curve.
  const ring: Vec3[][] = [];
  const ringNormals: Vec3[][] = [];
  for (let i = 0; i < tubularSegments; i++) {
    const u = (i / tubularSegments) * p * Math.PI * 2;
    const P1 = curve(u);
    const P2 = curve(u + 0.01);
    const T = sub(P2, P1);
    const N0 = add(P2, P1);
    const B = normalize(cross(T, N0));
    const N = normalize(cross(B, T));
    const verts: Vec3[] = [];
    const norms: Vec3[] = [];
    for (let j = 0; j < radialSegments; j++) {
      const v = (j / radialSegments) * Math.PI * 2;
      const cx = -tube * Math.cos(v);
      const cy = tube * Math.sin(v);
      const offset = add(scale(N, cx), scale(B, cy));
      verts.push(add(P1, offset));
      norms.push(normalize(offset));
    }
    ring.push(verts);
    ringNormals.push(norms);
  }

  const triCount = tubularSegments * radialSegments * 2;
  const positions = new Float32Array(triCount * 9);
  const normals = new Float32Array(triCount * 9);
  let o = 0;
  const emit = (i0: number, j0: number, i1: number, j1: number, i2: number, j2: number) => {
    positions.set([...ring[i0]![j0]!, ...ring[i1]![j1]!, ...ring[i2]![j2]!], o);
    normals.set([...ringNormals[i0]![j0]!, ...ringNormals[i1]![j1]!, ...ringNormals[i2]![j2]!], o);
    o += 9;
  };
  for (let i = 0; i < tubularSegments; i++) {
    const i1 = (i + 1) % tubularSegments;
    for (let j = 0; j < radialSegments; j++) {
      const j1 = (j + 1) % radialSegments;
      emit(i, j, i1, j, i1, j1);
      emit(i, j, i1, j1, i, j1);
    }
  }
  return { positions, normals };
}

/** Returns a transformed copy: scale, then rotate about Y, then translate. */
export function transform(
  mesh: Mesh,
  { translate = [0, 0, 0] as Vec3, scale: s = 1, rotateY = 0 }: { translate?: Vec3; scale?: number; rotateY?: number },
): Mesh {
  const cos = Math.cos(rotateY);
  const sin = Math.sin(rotateY);
  const positions = new Float32Array(mesh.positions.length);
  const normals = new Float32Array(mesh.normals.length);
  for (let i = 0; i < mesh.positions.length; i += 3) {
    const x = mesh.positions[i]! * s;
    const y = mesh.positions[i + 1]! * s;
    const z = mesh.positions[i + 2]! * s;
    positions[i] = x * cos + z * sin + translate[0];
    positions[i + 1] = y + translate[1];
    positions[i + 2] = -x * sin + z * cos + translate[2];
    const nx = mesh.normals[i]!;
    const ny = mesh.normals[i + 1]!;
    const nz = mesh.normals[i + 2]!;
    normals[i] = nx * cos + nz * sin;
    normals[i + 1] = ny;
    normals[i + 2] = -nx * sin + nz * cos;
  }
  return { positions, normals };
}
