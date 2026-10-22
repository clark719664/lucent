// ---------------------------------------------------------------------------
// Explicit light sampling (next-event estimation) for sphere and quad emitters
// plus a directional sun with finite angular size. Every pdf is in solid angle
// so it can be combined with BSDF pdfs using multiple importance sampling.
// ---------------------------------------------------------------------------
uniform vec4 uLights[MAX_LIGHTS * 4]; // see scene.ts for the layout
uniform int uLightCount;

uniform vec3 uSunDir;       // unit vector towards the sun
uniform vec3 uSunRadiance;  // colour * irradiance / solid angle
uniform vec3 uSunColor;     // tint used for the sky glow
uniform float uSunCosAngle; // cos(angular radius)
uniform float uSunPdf;      // 1 / solid angle
uniform int uSunEnabled;

uniform int uSkyEnabled;
uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizon;
uniform vec3 uSkyGround;
uniform float uSkyIntensity;

struct LightSample {
  vec3 dir;
  float dist;
  float pdf;
  vec3 radiance;
};

vec3 sky(vec3 d) {
  if (uSkyEnabled == 0) return vec3(0.0);
  float t = clamp(d.y, -1.0, 1.0);
  vec3 c = t >= 0.0
    ? mix(uSkyHorizon, uSkyZenith, pow(t, 0.55))
    : mix(uSkyHorizon, uSkyGround, clamp(-t * 4.0, 0.0, 1.0));
  if (uSunEnabled != 0) {
    float s = max(dot(d, uSunDir), 0.0);
    c += uSunColor * (0.12 * pow(s, 24.0) + 0.5 * pow(s, 400.0));
  }
  return c * uSkyIntensity;
}

// Radiance arriving from infinity. The sun disc is only added with an MIS
// weight because it is also sampled explicitly at diffuse/glossy vertices.
vec3 environment(vec3 d, bool specularBounce, float bsdfPdf) {
  vec3 L = sky(d);
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
