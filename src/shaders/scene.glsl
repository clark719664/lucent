// ---------------------------------------------------------------------------
// Scene storage and intersection. Geometry lives in RGBA32F textures that are
// addressed as flat arrays; `TEX_WIDTH` must match the TypeScript uploader.
// ---------------------------------------------------------------------------
const int TEX_WIDTH = 2048;
const int TEX_SHIFT = 11;
const int TEX_MASK = 2047;

const int MAX_SPHERES = 64;
const int MAX_LIGHTS = 8;

uniform sampler2D uTriangles;  // 6 texels per triangle: v0(w=mat) v1(w=light) v2 n0 n1 n2
uniform sampler2D uBVH;        // 2 texels per node: (min, leftFirst) (max, count)
uniform sampler2D uMaterials;  // 4 texels per material

uniform vec4 uSpheres[MAX_SPHERES];      // xyz = centre, w = radius
uniform int uSphereMaterial[MAX_SPHERES];
uniform int uSphereLight[MAX_SPHERES];   // light index or -1
uniform int uSphereCount;
uniform int uTriCount;

vec4 fetchTexel(sampler2D tex, int i) {
  return texelFetch(tex, ivec2(i & TEX_MASK, i >> TEX_SHIFT), 0);
}

struct Material {
  vec3 albedo;
  float metallic;
  float roughness;
  float ior;
  float transmission;
  float checkerScale;
  vec3 emission;
  vec3 albedo2;
};

Material fetchMaterial(int index) {
  int base = index * 4;
  vec4 a = fetchTexel(uMaterials, base);
  vec4 b = fetchTexel(uMaterials, base + 1);
  vec4 c = fetchTexel(uMaterials, base + 2);
  vec4 d = fetchTexel(uMaterials, base + 3);
  Material m;
  m.albedo = a.rgb;
  m.metallic = a.w;
  m.roughness = b.x;
  m.ior = b.y;
  m.transmission = b.z;
  m.checkerScale = b.w;
  m.emission = c.rgb;
  m.albedo2 = d.rgb;
  return m;
}

struct Hit {
  float t;
  vec3 position;
  vec3 normal;     // shading normal, always facing the incoming ray
  vec3 geomNormal; // geometric normal, same hemisphere as `normal`
  bool frontFace;  // did we hit the outside of the surface?
  int material;
  int light;       // explicit light index for MIS, or -1
};

// Möller–Trumbore, two-sided. Writes barycentrics so callers can interpolate normals.
bool hitTriangle(vec3 ro, vec3 rd, vec3 v0, vec3 v1, vec3 v2, float tMax, out float t, out vec2 bary) {
  vec3 e1 = v1 - v0;
  vec3 e2 = v2 - v0;
  vec3 p = cross(rd, e2);
  float det = dot(e1, p);
  if (abs(det) < 1e-9) return false;
  float invDet = 1.0 / det;
  vec3 s = ro - v0;
  float u = dot(s, p) * invDet;
  if (u < 0.0 || u > 1.0) return false;
  vec3 q = cross(s, e1);
  float v = dot(rd, q) * invDet;
  if (v < 0.0 || u + v > 1.0) return false;
  t = dot(e2, q) * invDet;
  if (t <= EPS || t >= tMax) return false;
  bary = vec2(u, v);
  return true;
}

float hitSphere(vec3 ro, vec3 rd, vec4 s, float tMax) {
  vec3 oc = ro - s.xyz;
  float b = dot(oc, rd);
  float c = dot(oc, oc) - s.w * s.w;
  float disc = b * b - c;
  if (disc < 0.0) return INF;
  float sq = sqrt(disc);
  float t = -b - sq;
  if (t > EPS && t < tMax) return t;
  t = -b + sq;
  if (t > EPS && t < tMax) return t;
  return INF;
}

// Slab test against a node's box. Returns entry distance or INF.
float hitAABB(vec3 ro, vec3 invDir, vec3 bmin, vec3 bmax, float tMax) {
  vec3 t0 = (bmin - ro) * invDir;
  vec3 t1 = (bmax - ro) * invDir;
  vec3 tmin = min(t0, t1);
  vec3 tmax = max(t0, t1);
  float tn = max(max(tmin.x, tmin.y), max(tmin.z, 0.0));
  float tf = min(min(tmax.x, tmax.y), min(tmax.z, tMax));
  return tf >= tn ? tn : INF;
}

// Closest-hit BVH traversal with a small explicit stack and near-first ordering.
bool traceScene(vec3 ro, vec3 rd, float tMax, out Hit hit) {
  float closest = tMax;
  int bestTri = -1;
  vec2 bestBary = vec2(0.0);
  int bestSphere = -1;

  for (int i = 0; i < uSphereCount; i++) {
    float t = hitSphere(ro, rd, uSpheres[i], closest);
    if (t < closest) {
      closest = t;
      bestSphere = i;
    }
  }

  if (uTriCount > 0) {
    vec3 invDir = 1.0 / rd;
    int stack[32];
    int sp = 0;
    int node = 0;
    for (int iter = 0; iter < 2048; iter++) {
      vec4 a = fetchTexel(uBVH, node * 2);
      vec4 b = fetchTexel(uBVH, node * 2 + 1);
      int leftFirst = int(a.w);
      int count = int(b.w);

      if (count > 0) {
        for (int k = 0; k < count; k++) {
          int tri = leftFirst + k;
          int base = tri * 6;
          vec3 v0 = fetchTexel(uTriangles, base).xyz;
          vec3 v1 = fetchTexel(uTriangles, base + 1).xyz;
          vec3 v2 = fetchTexel(uTriangles, base + 2).xyz;
          float t;
          vec2 bary;
          if (hitTriangle(ro, rd, v0, v1, v2, closest, t, bary)) {
            closest = t;
            bestTri = tri;
            bestBary = bary;
            bestSphere = -1;
          }
        }
        if (sp == 0) break;
        node = stack[--sp];
        continue;
      }

      int left = leftFirst;
      int right = leftFirst + 1;
      vec4 la = fetchTexel(uBVH, left * 2);
      vec4 lb = fetchTexel(uBVH, left * 2 + 1);
      vec4 ra = fetchTexel(uBVH, right * 2);
      vec4 rb = fetchTexel(uBVH, right * 2 + 1);
      float tl = hitAABB(ro, invDir, la.xyz, lb.xyz, closest);
      float tr = hitAABB(ro, invDir, ra.xyz, rb.xyz, closest);

      if (tl > tr) {
        float tt = tl; tl = tr; tr = tt;
        int ti = left; left = right; right = ti;
      }
      if (tl == INF) {
        if (sp == 0) break;
        node = stack[--sp];
      } else {
        node = left;
        if (tr != INF && sp < 32) stack[sp++] = right;
      }
    }
  }

  if (bestTri < 0 && bestSphere < 0) return false;

  hit.t = closest;
  hit.position = ro + rd * closest;

  if (bestSphere >= 0) {
    vec4 s = uSpheres[bestSphere];
    vec3 n = (hit.position - s.xyz) / s.w;
    hit.frontFace = dot(rd, n) < 0.0;
    hit.normal = hit.frontFace ? n : -n;
    hit.geomNormal = hit.normal;
    hit.material = uSphereMaterial[bestSphere];
    hit.light = uSphereLight[bestSphere];
    return true;
  }

  int base = bestTri * 6;
  vec4 t0 = fetchTexel(uTriangles, base);
  vec4 t1 = fetchTexel(uTriangles, base + 1);
  vec3 v2 = fetchTexel(uTriangles, base + 2).xyz;
  vec3 n0 = fetchTexel(uTriangles, base + 3).xyz;
  vec3 n1 = fetchTexel(uTriangles, base + 4).xyz;
  vec3 n2 = fetchTexel(uTriangles, base + 5).xyz;
  float w = 1.0 - bestBary.x - bestBary.y;
  vec3 ng = normalize(cross(t1.xyz - t0.xyz, v2 - t0.xyz));
  vec3 ns = normalize(n0 * w + n1 * bestBary.x + n2 * bestBary.y);
  hit.frontFace = dot(rd, ng) < 0.0;
  if (!hit.frontFace) { ng = -ng; ns = -ns; }
  // Guard against shading normals that face away from the ray (common at silhouettes).
  if (dot(ns, ng) < 0.05) ns = ng;
  hit.normal = ns;
  hit.geomNormal = ng;
  hit.material = int(t0.w);
  hit.light = int(t1.w);
  return true;
}

// Any-hit query for shadow rays; exits on the first occluder.
bool occluded(vec3 ro, vec3 rd, float tMax) {
  for (int i = 0; i < uSphereCount; i++) {
    if (hitSphere(ro, rd, uSpheres[i], tMax) < tMax) return true;
  }
  if (uTriCount == 0) return false;

  vec3 invDir = 1.0 / rd;
  int stack[32];
  int sp = 0;
  int node = 0;
  for (int iter = 0; iter < 2048; iter++) {
    vec4 a = fetchTexel(uBVH, node * 2);
    vec4 b = fetchTexel(uBVH, node * 2 + 1);
    if (hitAABB(ro, invDir, a.xyz, b.xyz, tMax) == INF) {
      if (sp == 0) return false;
      node = stack[--sp];
      continue;
    }
    int leftFirst = int(a.w);
    int count = int(b.w);
    if (count > 0) {
      for (int k = 0; k < count; k++) {
        int base = (leftFirst + k) * 6;
        vec3 v0 = fetchTexel(uTriangles, base).xyz;
        vec3 v1 = fetchTexel(uTriangles, base + 1).xyz;
        vec3 v2 = fetchTexel(uTriangles, base + 2).xyz;
        float t;
        vec2 bary;
        if (hitTriangle(ro, rd, v0, v1, v2, tMax, t, bary)) return true;
      }
      if (sp == 0) return false;
      node = stack[--sp];
    } else {
      node = leftFirst;
      if (sp < 32) stack[sp++] = leftFirst + 1;
    }
  }
  return false;
}
