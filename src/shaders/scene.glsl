// ---------------------------------------------------------------------------
// Scene storage and intersection. Geometry lives in RGBA32F textures that are
// addressed as flat arrays; `TEX_WIDTH` must match the TypeScript uploader.
// ---------------------------------------------------------------------------
const int TEX_WIDTH = 2048;
const int TEX_SHIFT = 11;
const int TEX_MASK = 2047;

const int MAX_SPHERES = 64;
const int MAX_LIGHTS = 8;
const int MATERIAL_TEXELS = 10;

uniform sampler2D uTriGeometry;   // 3 texels per triangle: v0 (w = material) v1 (w = light) v2 (w = alpha test)
uniform sampler2D uTriAttributes; // 4 texels per triangle: (n0, u0) (n1, u1) (n2, u2) (v0, v1, v2, -)
uniform sampler2D uBVH;           // 2 texels per node: (min, leftFirst) (max, count)
uniform sampler2D uMaterials;     // 10 texels per material, see material.ts
uniform sampler2DArray uColorMaps; // sRGB layers: base colour, emissive
uniform sampler2DArray uDataMaps;  // linear layers: metal-rough, normal

uniform vec4 uSpheres[MAX_SPHERES];      // xyz = centre, w = radius
uniform int uSphereMaterial[MAX_SPHERES];
uniform int uSphereLight[MAX_SPHERES];   // light index or -1
uniform int uSphereCount;
uniform int uTriCount;
uniform int uGroundMaterial;             // -1 = no ground plane
uniform float uGroundHeight;

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
  float alpha;
  vec3 albedo2;
  int alphaMode;
  ivec4 maps; // base colour, metal-rough, normal, emissive (layer or -1)
  float normalScale;
  float clearcoat;
  float clearcoatRoughness;
  float alphaCutoff;
  vec3 sheenColor;
  float sheenRoughness;
  vec3 attenuationColor;
  float attenuationDistance;
  vec3 uv0;
  vec3 uv1;
  bool thinWalled;
};

Material fetchMaterial(int index) {
  int base = index * MATERIAL_TEXELS;
  vec4 t0 = fetchTexel(uMaterials, base);
  vec4 t1 = fetchTexel(uMaterials, base + 1);
  vec4 t2 = fetchTexel(uMaterials, base + 2);
  vec4 t3 = fetchTexel(uMaterials, base + 3);
  vec4 t4 = fetchTexel(uMaterials, base + 4);
  vec4 t5 = fetchTexel(uMaterials, base + 5);
  vec4 t6 = fetchTexel(uMaterials, base + 6);
  vec4 t7 = fetchTexel(uMaterials, base + 7);
  vec4 t8 = fetchTexel(uMaterials, base + 8);
  vec4 t9 = fetchTexel(uMaterials, base + 9);
  Material m;
  m.albedo = t0.rgb;
  m.metallic = t0.w;
  m.roughness = t1.x;
  m.ior = t1.y;
  m.transmission = t1.z;
  m.checkerScale = t1.w;
  m.emission = t2.rgb;
  m.alpha = t2.w;
  m.albedo2 = t3.rgb;
  m.alphaMode = int(t3.w);
  m.maps = ivec4(t4);
  m.normalScale = t5.x;
  m.clearcoat = t5.y;
  m.clearcoatRoughness = t5.z;
  m.alphaCutoff = t5.w;
  m.sheenColor = t6.rgb;
  m.sheenRoughness = t6.w;
  m.attenuationColor = t7.rgb;
  m.attenuationDistance = t7.w;
  m.uv0 = t8.xyz;
  m.thinWalled = t8.w > 0.5;
  m.uv1 = t9.xyz;
  return m;
}

vec2 transformUV(vec2 uv, vec3 row0, vec3 row1) {
  return vec2(dot(row0, vec3(uv, 1.0)), dot(row1, vec3(uv, 1.0)));
}

struct Hit {
  float t;
  vec3 position;
  vec3 normal;     // shading normal, always facing the incoming ray
  vec3 geomNormal; // geometric normal, same hemisphere as `normal`
  bool frontFace;  // did we hit the outside of the surface?
  int material;
  int light;       // explicit light index for MIS, or -1
  vec2 uv;
  vec3 dpdu;       // surface derivatives for normal mapping; zero without UVs
  vec3 dpdv;
};

// Möller–Trumbore, two-sided. Writes barycentrics so callers can interpolate attributes.
bool hitTriangle(vec3 ro, vec3 rd, vec3 v0, vec3 v1, vec3 v2, float tMax, out float t, out vec2 bary) {
  vec3 e1 = v1 - v0;
  vec3 e2 = v2 - v0;
  vec3 p = cross(rd, e2);
  float det = dot(e1, p);
  if (abs(det) < 1e-12) return false;
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

float hitGround(vec3 ro, vec3 rd, float tMax) {
  if (uGroundMaterial < 0 || abs(rd.y) < 1e-9) return INF;
  float t = (uGroundHeight - ro.y) / rd.y;
  return t > EPS && t < tMax ? t : INF;
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

vec2 triangleUV(int tri, vec2 bary, out vec2 uv0, out vec2 uv1, out vec2 uv2) {
  int a = tri * 4;
  vec4 a0 = fetchTexel(uTriAttributes, a);
  vec4 a1 = fetchTexel(uTriAttributes, a + 1);
  vec4 a2 = fetchTexel(uTriAttributes, a + 2);
  vec4 a3 = fetchTexel(uTriAttributes, a + 3);
  uv0 = vec2(a0.w, a3.x);
  uv1 = vec2(a1.w, a3.y);
  uv2 = vec2(a2.w, a3.z);
  return uv0 * (1.0 - bary.x - bary.y) + uv1 * bary.x + uv2 * bary.y;
}

// Any-hit for alpha-tested triangles: does this hit block the ray?
bool alphaOpaque(int tri, vec2 bary, int matIndex) {
  vec2 uv0, uv1, uv2;
  vec2 uv = triangleUV(tri, bary, uv0, uv1, uv2);
  int base = matIndex * MATERIAL_TEXELS;
  float alpha = fetchTexel(uMaterials, base + 2).w;
  int mode = int(fetchTexel(uMaterials, base + 3).w);
  int map = int(fetchTexel(uMaterials, base + 4).x);
  if (map >= 0) {
    vec2 tuv = transformUV(uv, fetchTexel(uMaterials, base + 8).xyz, fetchTexel(uMaterials, base + 9).xyz);
    alpha *= textureLod(uColorMaps, vec3(tuv, float(map)), 0.0).a;
  }
  if (mode == 1) return alpha >= fetchTexel(uMaterials, base + 5).w;
  return rand() < alpha;
}

// Closest-hit BVH traversal with a small explicit stack and near-first ordering.
bool traceScene(vec3 ro, vec3 rd, float tMax, out Hit hit) {
  float closest = tMax;
  int bestTri = -1;
  vec2 bestBary = vec2(0.0);
  int bestSphere = -1;
  bool ground = false;

  for (int i = 0; i < uSphereCount; i++) {
    float t = hitSphere(ro, rd, uSpheres[i], closest);
    if (t < closest) {
      closest = t;
      bestSphere = i;
    }
  }
  float tg = hitGround(ro, rd, closest);
  if (tg < closest) {
    closest = tg;
    bestSphere = -1;
    ground = true;
  }

  if (uTriCount > 0) {
    vec3 invDir = 1.0 / rd;
    int stack[40];
    int sp = 0;
    int node = 0;
    for (int iter = 0; iter < 8192; iter++) {
      vec4 a = fetchTexel(uBVH, node * 2);
      vec4 b = fetchTexel(uBVH, node * 2 + 1);
      int leftFirst = int(a.w);
      int count = int(b.w);

      if (count > 0) {
        for (int k = 0; k < count; k++) {
          int tri = leftFirst + k;
          int base = tri * 3;
          vec4 v0 = fetchTexel(uTriGeometry, base);
          vec3 v1 = fetchTexel(uTriGeometry, base + 1).xyz;
          vec4 v2 = fetchTexel(uTriGeometry, base + 2);
          float t;
          vec2 bary;
          if (hitTriangle(ro, rd, v0.xyz, v1, v2.xyz, closest, t, bary) &&
              (v2.w < 0.5 || alphaOpaque(tri, bary, int(v0.w)))) {
            closest = t;
            bestTri = tri;
            bestBary = bary;
            bestSphere = -1;
            ground = false;
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
        if (tr != INF && sp < 40) stack[sp++] = right;
      }
    }
  }

  if (bestTri < 0 && bestSphere < 0 && !ground) return false;

  hit.t = closest;
  hit.position = ro + rd * closest;
  hit.uv = vec2(0.0);
  hit.dpdu = vec3(0.0);
  hit.dpdv = vec3(0.0);
  hit.light = -1;

  if (ground) {
    hit.frontFace = rd.y < 0.0;
    hit.normal = vec3(0.0, hit.frontFace ? 1.0 : -1.0, 0.0);
    hit.geomNormal = hit.normal;
    hit.material = uGroundMaterial;
    hit.uv = hit.position.xz;
    return true;
  }

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

  int g = bestTri * 3;
  vec4 p0 = fetchTexel(uTriGeometry, g);
  vec4 p1 = fetchTexel(uTriGeometry, g + 1);
  vec3 p2 = fetchTexel(uTriGeometry, g + 2).xyz;
  int at = bestTri * 4;
  vec3 n0 = fetchTexel(uTriAttributes, at).xyz;
  vec3 n1 = fetchTexel(uTriAttributes, at + 1).xyz;
  vec3 n2 = fetchTexel(uTriAttributes, at + 2).xyz;
  vec2 uv0, uv1, uv2;
  hit.uv = triangleUV(bestTri, bestBary, uv0, uv1, uv2);

  vec3 e1 = p1.xyz - p0.xyz;
  vec3 e2 = p2 - p0.xyz;
  vec2 d1 = uv1 - uv0;
  vec2 d2 = uv2 - uv0;
  float det = d1.x * d2.y - d1.y * d2.x;
  if (abs(det) > 1e-12) {
    float r = 1.0 / det;
    hit.dpdu = (e1 * d2.y - e2 * d1.y) * r;
    hit.dpdv = (e2 * d1.x - e1 * d2.x) * r;
  }

  float w = 1.0 - bestBary.x - bestBary.y;
  vec3 ng = normalize(cross(e1, e2));
  vec3 ns = normalize(n0 * w + n1 * bestBary.x + n2 * bestBary.y);
  hit.frontFace = dot(rd, ng) < 0.0;
  if (!hit.frontFace) { ng = -ng; ns = -ns; }
  // Guard against shading normals that face away from the ray (common at silhouettes).
  if (dot(ns, ng) < 0.05) ns = ng;
  hit.normal = ns;
  hit.geomNormal = ng;
  hit.material = int(p0.w);
  hit.light = int(p1.w);
  return true;
}

// Any-hit query for shadow rays; exits on the first occluder.
bool occluded(vec3 ro, vec3 rd, float tMax) {
  for (int i = 0; i < uSphereCount; i++) {
    if (hitSphere(ro, rd, uSpheres[i], tMax) < tMax) return true;
  }
  if (hitGround(ro, rd, tMax) < tMax) return true;
  if (uTriCount == 0) return false;

  vec3 invDir = 1.0 / rd;
  int stack[40];
  int sp = 0;
  int node = 0;
  for (int iter = 0; iter < 8192; iter++) {
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
        int tri = leftFirst + k;
        int base = tri * 3;
        vec4 v0 = fetchTexel(uTriGeometry, base);
        vec3 v1 = fetchTexel(uTriGeometry, base + 1).xyz;
        vec4 v2 = fetchTexel(uTriGeometry, base + 2);
        float t;
        vec2 bary;
        if (hitTriangle(ro, rd, v0.xyz, v1, v2.xyz, tMax, t, bary) &&
            (v2.w < 0.5 || alphaOpaque(tri, bary, int(v0.w)))) return true;
      }
      if (sp == 0) return false;
      node = stack[--sp];
    } else {
      node = leftFirst;
      if (sp < 40) stack[sp++] = leftFirst + 1;
    }
  }
  return false;
}
