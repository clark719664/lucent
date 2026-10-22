// ---------------------------------------------------------------------------
// Explicit light sampling (next-event estimation) for sphere and quad emitters,
// an importance-sampled environment map, and a directional sun with finite
// angular size. Every pdf is in solid angle so it can be combined with BSDF
// pdfs using multiple importance sampling.
// ---------------------------------------------------------------------------
uniform vec4 uLights[MAX_LIGHTS * 4]; // see scene.ts for the layout
uniform int uLightCount;

uniform vec3 uSunDir;       // unit vector towards the sun
uniform vec3 uSunRadiance;  // colour * irradiance / solid angle
uniform float uSunCosAngle; // cos(angular radius)
uniform float uSunPdf;      // 1 / solid angle
uniform int uSunEnabled;

uniform sampler2D uEnvMap;   // equirect radiance (procedural sky baked, or an HDRI)
uniform sampler2D uEnvAlias; // per cell: keep probability, alias cell, pdfUV, alias pdfUV
uniform ivec2 uEnvGrid;
uniform vec2 uEnvRotation;   // cos, sin of the map's rotation about +Y
uniform float uEnvIntensity;
uniform int uEnvSampling;    // 0 when the map is black: skip light sampling
uniform int uEnvBackground;  // 0 = camera rays that miss see uBackdrop
uniform vec3 uBackdrop;

struct LightSample {
  vec3 dir;
  float dist;
  float pdf;
  vec3 radiance;
};

vec3 envToLocal(vec3 d) {
  return vec3(uEnvRotation.x * d.x - uEnvRotation.y * d.z, d.y, uEnvRotation.y * d.x + uEnvRotation.x * d.z);
}

vec3 envToWorld(vec3 l) {
  return vec3(uEnvRotation.x * l.x + uEnvRotation.y * l.z, l.y, -uEnvRotation.y * l.x + uEnvRotation.x * l.z);
}

// Equirect convention shared with environment.ts: v = 0 is straight up.
vec2 equirectUV(vec3 l) {
  return vec2(atan(l.z, l.x) * (0.5 * INV_PI) + 0.5, acos(clamp(l.y, -1.0, 1.0)) * INV_PI);
}

vec3 envRadiance(vec3 d) {
  return textureLod(uEnvMap, equirectUV(envToLocal(d)), 0.0).rgb * uEnvIntensity;
}

// Solid-angle pdf of `sampleEnvironment` producing direction `d`.
float envPdf(vec3 d) {
  vec3 l = envToLocal(d);
  float sinTheta = sqrt(max(0.0, 1.0 - l.y * l.y));
  if (sinTheta < 1e-6) return 0.0;
  ivec2 cell = min(ivec2(equirectUV(l) * vec2(uEnvGrid)), uEnvGrid - 1);
  return texelFetch(uEnvAlias, cell, 0).z / (2.0 * PI * PI * sinTheta);
}

// O(1) alias-table sample of a map cell, then a uniform point inside it.
LightSample sampleEnvironment() {
  LightSample ls;
  int n = uEnvGrid.x * uEnvGrid.y;
  int i = min(int(rand() * float(n)), n - 1);
  vec4 e = texelFetch(uEnvAlias, ivec2(i % uEnvGrid.x, i / uEnvGrid.x), 0);
  int cell = i;
  float pdfUV = e.z;
  if (rand() >= e.x) {
    cell = int(e.y);
    pdfUV = e.w;
  }
  vec2 uv = (vec2(float(cell % uEnvGrid.x), float(cell / uEnvGrid.x)) + rand2()) / vec2(uEnvGrid);
  float phi = (uv.x - 0.5) * TWO_PI;
  float theta = uv.y * PI;
  float sinTheta = sin(theta);
  ls.dir = envToWorld(vec3(sinTheta * cos(phi), cos(theta), sinTheta * sin(phi)));
  ls.dist = INF;
  ls.pdf = sinTheta > 1e-6 ? pdfUV / (2.0 * PI * PI * sinTheta) : 0.0;
  ls.radiance = textureLod(uEnvMap, uv, 0.0).rgb * uEnvIntensity;
  return ls;
}

// Radiance arriving from infinity along a path. The map and the sun disc are
// weighted against their light-sampling pdfs unless the bounce was specular.
vec3 environment(vec3 d, bool specularBounce, float bsdfPdf) {
  vec3 L = envRadiance(d);
  if (!specularBounce && uEnvSampling != 0) L *= misWeight(bsdfPdf, envPdf(d));
  if (uSunEnabled != 0 && dot(d, uSunDir) >= uSunCosAngle) {
    float w = specularBounce ? 1.0 : misWeight(bsdfPdf, uSunPdf);
    L += uSunRadiance * w;
  }
  return L;
}

vec3 sampleSunDirection(vec2 u) {
  vec3 t, b;
  basis(uSunDir, t, b);
  return toWorld(uniformCone(u, uSunCosAngle), t, b, uSunDir);
}

LightSample sampleLight(int index, vec3 p, vec2 u) {
  LightSample ls;
  ls.pdf = 0.0;
  vec4 l0 = uLights[index * 4];
  vec4 l1 = uLights[index * 4 + 1];
  vec4 l2 = uLights[index * 4 + 2];
  ls.radiance = uLights[index * 4 + 3].rgb;

  if (l0.w < 0.5) {
    // Sphere: sample the cone it subtends.
    vec3 toC = l0.xyz - p;
    float d2 = dot(toC, toC);
    float r = l1.w;
    if (d2 <= r * r) return ls;
    float cosMax = sqrt(max(0.0, 1.0 - r * r / d2));
    vec3 axis = toC * inversesqrt(d2);
    vec3 t, b;
    basis(axis, t, b);
    ls.dir = toWorld(uniformCone(u, cosMax), t, b, axis);
    ls.pdf = 1.0 / (TWO_PI * (1.0 - cosMax));
    float t0 = hitSphere(p, ls.dir, vec4(l0.xyz, r), INF);
    ls.dist = t0 < INF ? t0 : sqrt(d2);
  } else {
    // Quad: uniform area sample converted to solid angle.
    vec3 e1 = l1.xyz;
    vec3 e2 = l2.xyz;
    vec3 q = l0.xyz + e1 * u.x + e2 * u.y;
    vec3 toQ = q - p;
    float d2 = dot(toQ, toQ);
    float d = sqrt(d2);
    ls.dir = toQ / d;
    ls.dist = d;
    vec3 nCross = cross(e1, e2);
    float area = length(nCross);
    float cosL = abs(dot(nCross / area, ls.dir));
    if (cosL < 1e-4) return ls;
    ls.pdf = d2 / (cosL * area);
  }
  return ls;
}

// Solid-angle pdf of having sampled `hit` (reached along `dir` from `p`) via sampleLight.
float lightPdf(int index, vec3 p, vec3 dir, float dist) {
  vec4 l0 = uLights[index * 4];
  vec4 l1 = uLights[index * 4 + 1];
  vec4 l2 = uLights[index * 4 + 2];
  if (l0.w < 0.5) {
    vec3 toC = l0.xyz - p;
    float d2 = dot(toC, toC);
    float r = l1.w;
    if (d2 <= r * r) return 0.0;
    float cosMax = sqrt(max(0.0, 1.0 - r * r / d2));
    return 1.0 / (TWO_PI * (1.0 - cosMax));
  }
  vec3 nCross = cross(l1.xyz, l2.xyz);
  float area = length(nCross);
  float cosL = abs(dot(nCross / area, dir));
  if (cosL < 1e-4) return 0.0;
  return dist * dist / (cosL * area);
}
