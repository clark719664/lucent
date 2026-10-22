#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp sampler2DArray;

#include "common.glsl"
#include "scene.glsl"
#include "lights.glsl"
#include "bsdf.glsl"

uniform vec2 uResolution;
uniform uint uSeed;             // advances every sample, never resets
uniform sampler2D uPrevColor;   // running averages, see the outputs below
uniform sampler2D uPrevAlbedo;
uniform sampler2D uPrevNormal;
uniform sampler2D uPrevHistory; // samples behind each pixel's averages

// Temporal reprojection: when the camera has moved since the history was
// written, each sample looks its primary hit up in the previous view instead
// of discarding everything accumulated so far.
uniform int uReproject;
uniform vec3 uPrevCamPos;
uniform vec3 uPrevCamRight;
uniform vec3 uPrevCamUp;
uniform vec3 uPrevCamForward;
uniform float uPrevTanHalfFov;
uniform vec2 uPrevResolution;
uniform float uHistoryCap;      // bounds lag and ghosting while moving

uniform vec3 uCamPos;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform vec3 uCamForward;
uniform float uTanHalfFov;
uniform float uAperture;
uniform float uFocusDist;

uniform int uMaxBounces;
uniform float uClamp;         // max luminance an indirect sample may contribute

// Running means: radiance + luminance² (for the denoiser's variance), and the
// denoiser's guides — albedo + coverage, normal + depth — taken at the first
// non-mirror vertex so that reflections and refractions keep their detail.
layout(location = 0) out vec4 outColor;
layout(location = 1) out vec4 outAlbedo;
layout(location = 2) out vec4 outNormal;
layout(location = 3) out vec4 outHistory;

const float FAR = 1e4;

// Thin-lens camera ray with sub-pixel jitter for antialiasing.
void cameraRay(vec2 fragCoord, out vec3 ro, out vec3 rd) {
  vec2 uv = (fragCoord + rand2()) / uResolution * 2.0 - 1.0;
  float aspect = uResolution.x / uResolution.y;
  vec3 dir = normalize(uCamForward + uCamRight * (uv.x * aspect * uTanHalfFov) + uCamUp * (uv.y * uTanHalfFov));
  // Keep the focal plane planar: scale by 1 / cos(angle to forward).
  vec3 focus = uCamPos + dir * (uFocusDist / dot(dir, uCamForward));
  vec2 lens = concentricDisk(rand2()) * uAperture;
  ro = uCamPos + uCamRight * lens.x + uCamUp * lens.y;
  rd = normalize(focus - ro);
}

// Caps the luminance of a contribution to suppress fireflies on indirect bounces.
vec3 clampContribution(vec3 c, int bounce) {
  if (bounce == 0 || uClamp <= 0.0) return c;
  float l = luminance(c);
  return l > uClamp ? c * (uClamp / l) : c;
}

// Resolves textures, checkers and normal maps into the BSDF inputs at a hit.
Surface surfaceAt(Hit hit, vec3 wo, out vec3 emission) {
  Material m = fetchMaterial(hit.material);
  Surface s;
  vec2 uv = transformUV(hit.uv, m.uv0, m.uv1);

  s.albedo = m.albedo;
  if (m.checkerScale > 0.0) {
    // Half-cell offset keeps surfaces lying exactly on a lattice plane (y = 0 floors) stable.
    vec3 q = floor(hit.position * m.checkerScale + 0.5);
    if (mod(q.x + q.y + q.z, 2.0) >= 0.5) s.albedo = m.albedo2;
  }
  if (m.maps.x >= 0) s.albedo *= textureLod(uColorMaps, vec3(uv, float(m.maps.x)), 0.0).rgb;

  s.metallic = m.metallic;
  s.roughness = m.roughness;
  if (m.maps.y >= 0) {
    vec4 mr = textureLod(uDataMaps, vec3(uv, float(m.maps.y)), 0.0);
    s.roughness *= mr.g;
    s.metallic *= mr.b;
  }

  emission = m.emission;
  if (m.maps.w >= 0) emission *= textureLod(uColorMaps, vec3(uv, float(m.maps.w)), 0.0).rgb;

  s.nc = hit.normal;
  s.n = hit.normal;
  if (m.maps.z >= 0 && dot(hit.dpdu, hit.dpdu) > 0.0) {
    // Tangent frame from the triangle's UV derivatives, built on the outward normal so
    // back faces see the mirrored perturbation. glTF's +Y points to decreasing v.
    vec3 N = hit.frontFace ? hit.normal : -hit.normal;
    vec3 T = normalize(hit.dpdu - N * dot(N, hit.dpdu));
    vec3 B = cross(N, T);
    if (dot(B, -hit.dpdv) < 0.0) B = -B;
    vec3 tn = textureLod(uDataMaps, vec3(uv, float(m.maps.z)), 0.0).xyz * 2.0 - 1.0;
    tn.xy *= m.normalScale;
    vec3 mapped = normalize(T * tn.x + B * tn.y + N * max(tn.z, 1e-3));
    mapped = hit.frontFace ? mapped : -mapped;
    if (dot(mapped, wo) > 1e-3 && dot(mapped, hit.geomNormal) > 0.0) s.n = mapped;
  }

  s.ior = m.ior;
  s.transmission = m.transmission * (1.0 - s.metallic);
  s.emission = emission;
  s.clearcoat = m.clearcoat;
  s.clearcoatRoughness = m.clearcoatRoughness;
  s.sheenColor = m.sheenColor;
  s.sheenRoughness = m.sheenRoughness;
  s.thinWalled = m.thinWalled;
  s.absorption = m.attenuationDistance > 0.0
    ? -log(max(m.attenuationColor, vec3(1e-4))) / m.attenuationDistance
    : vec3(0.0);
  return s;
}

struct Guide {
  vec3 albedo;
  vec3 normal;
  float depth;
  float coverage;
  vec3 position; // primary hit, for reprojection
  float reuse;   // 0–1: how view-independent the primary surface is, so how much history it may keep
  bool done;
};

vec3 tracePath(vec3 ro, vec3 rd, out Guide guide) {
  vec3 radiance = vec3(0.0);
  vec3 throughput = vec3(1.0);
  bool specularBounce = true;
  float bsdfPdf = 0.0;
  vec3 guideTint = vec3(1.0);
  guide = Guide(vec3(1.0), -rd, FAR, 0.0, vec3(0.0), 1.0, false);

  for (int bounce = 0; bounce <= uMaxBounces; bounce++) {
    Hit hit;
    if (!traceScene(ro, rd, INF, hit)) {
      vec3 env = bounce == 0 && uEnvBackground == 0 ? uBackdrop : environment(rd, specularBounce, bsdfPdf);
      radiance += clampContribution(throughput * env, bounce);
      if (!guide.done) {
        guide.albedo = guideTint;
        guide.normal = -rd;
        guide.done = true;
      }
      break;
    }
    if (bounce == 0) {
      guide.depth = hit.t;
      guide.coverage = 1.0;
      guide.position = hit.position;
    }

    vec3 wo = -rd;
    vec3 emission;
    Surface s = surfaceAt(hit, wo, emission);
    vec3 ng = hit.geomNormal;

    // Leaving a volume: absorb along the segment just travelled inside it.
    if (!hit.frontFace && !s.thinWalled && s.transmission > 0.0) throughput *= exp(-s.absorption * hit.t);

    if (any(greaterThan(emission, vec3(0.0)))) {
      float w = 1.0;
      if (!specularBounce && hit.light >= 0) {
        float pl = lightPdf(hit.light, ro, rd, hit.t) / float(uLightCount);
        w = misWeight(bsdfPdf, pl);
      }
      radiance += clampContribution(throughput * emission * w, bounce);
      if (!guide.done) {
        guide.albedo = guideTint;
        guide.normal = s.n;
        guide.done = true;
      }
      // Explicit lights are black bodies; textured glTF emitters also reflect.
      if (hit.light >= 0) break;
    }

    bool glass = s.transmission > 0.0 && rand() < s.transmission;
    if (bounce == 0) {
      // Reflections and refractions do not move with the surface, so reprojecting them smears.
      float sharp = 1.0 - smoothstep(0.1, 0.7, s.roughness);
      float glossy = max(sharp * mix(0.5, 1.0, s.metallic), s.transmission);
      glossy = max(glossy, s.clearcoat * 0.5 * (1.0 - smoothstep(0.08, 0.5, s.clearcoatRoughness)));
      guide.reuse = 1.0 - glossy;
    }
    bool mirror = !glass && s.metallic > 0.9 && s.roughness < 0.1;
    if (!guide.done && !((glass || mirror) && bounce < 3)) {
      guide.albedo = guideTint * s.albedo;
      guide.normal = s.n;
      guide.done = true;
    }

    if (glass) {
      vec3 wi, weight;
      bool reflected;
      if (!sampleDielectric(s, hit.frontFace, ng, wo, wi, weight, reflected)) break;
      throughput *= weight;
      if (!guide.done) guideTint *= weight;
      ro = offsetRay(hit.position, reflected ? ng : -ng);
      rd = wi;
      specularBounce = true;
    } else {
      if (!guide.done) guideTint *= s.albedo;
      vec3 shadowOrigin = offsetRay(hit.position, ng);
      vec3 n = s.n;

      // --- Next-event estimation: sun ---------------------------------------
      if (uSunEnabled != 0) {
        vec3 wi = sampleSunDirection(rand2());
        float NdotL = dot(n, wi);
        if (NdotL > 0.0 && dot(ng, wi) > 0.0 && !occluded(shadowOrigin, wi, INF)) {
          float pb;
          vec3 f = evalOpaque(s, wo, wi, pb);
          float w = misWeight(uSunPdf, pb);
          radiance += clampContribution(throughput * f * NdotL * uSunRadiance * (w / uSunPdf), bounce);
        }
      }

      // --- Next-event estimation: environment map -----------------------------
      if (uEnvSampling != 0) {
        LightSample ls = sampleEnvironment();
        float NdotL = dot(n, ls.dir);
        if (ls.pdf > 0.0 && NdotL > 0.0 && dot(ng, ls.dir) > 0.0 && !occluded(shadowOrigin, ls.dir, INF)) {
          float pb;
          vec3 f = evalOpaque(s, wo, ls.dir, pb);
          float w = misWeight(ls.pdf, pb);
          radiance += clampContribution(throughput * f * NdotL * ls.radiance * (w / ls.pdf), bounce);
        }
      }

      // --- Next-event estimation: one emitter chosen uniformly --------------
      if (uLightCount > 0) {
        int li = min(int(rand() * float(uLightCount)), uLightCount - 1);
        LightSample ls = sampleLight(li, hit.position, rand2());
        float NdotL = dot(n, ls.dir);
        if (ls.pdf > 0.0 && NdotL > 0.0 && dot(ng, ls.dir) > 0.0 &&
            !occluded(shadowOrigin, ls.dir, ls.dist * (1.0 - 1e-4))) {
          float pl = ls.pdf / float(uLightCount);
          float pb;
          vec3 f = evalOpaque(s, wo, ls.dir, pb);
          float w = misWeight(pl, pb);
          radiance += clampContribution(throughput * f * NdotL * ls.radiance * (w / pl), bounce);
        }
      }

      // --- Continue the path -------------------------------------------------
      BSDFSample bs = sampleOpaque(s, wo);
      if (bs.pdf <= 0.0 || dot(bs.dir, ng) <= 0.0) break;
      throughput *= bs.weight;
      bsdfPdf = bs.pdf;
      specularBounce = false;
      ro = shadowOrigin;
      rd = bs.dir;
    }

    // Russian roulette once the path has had a chance to carry energy.
    if (bounce >= 2) {
      float p = min(0.95, max3(throughput));
      if (rand() >= p) break;
      throughput /= p;
    }
  }
  return radiance;
}

// Continuous pixel position of `d` (a point relative to the old camera, or a direction) in the previous view.
bool projectToPrevious(vec3 d, out vec2 prevPix) {
  float z = dot(d, uPrevCamForward);
  if (z <= 1e-6) return false;
  float aspect = uPrevResolution.x / uPrevResolution.y;
  vec2 ndc = vec2(dot(d, uPrevCamRight) / (z * uPrevTanHalfFov * aspect), dot(d, uPrevCamUp) / (z * uPrevTanHalfFov));
  prevPix = (ndc * 0.5 + 0.5) * uPrevResolution;
  return all(greaterThanEqual(prevPix, vec2(0.0))) && all(lessThan(prevPix, uPrevResolution));
}

// Bilinear fetch of the previous averages from the taps that saw the same surface (or the same sky).
bool reprojectHistory(Guide g, vec3 rd, out vec4 color, out vec4 albedo, out vec4 normal, out float samples) {
  color = vec4(0.0);
  albedo = vec4(0.0);
  normal = vec4(0.0);
  samples = 0.0;
  bool surface = g.coverage > 0.5;
  vec3 d = surface ? g.position - uPrevCamPos : rd;
  vec2 prevPix;
  if (!projectToPrevious(d, prevPix)) return false;
  float expected = length(d);
  vec2 f = prevPix - 0.5;
  ivec2 base = ivec2(floor(f));
  vec2 t = f - floor(f);
  float wsum = 0.0;
  for (int i = 0; i < 4; i++) {
    ivec2 o = ivec2(i & 1, i >> 1);
    ivec2 q = base + o;
    if (any(lessThan(q, ivec2(0))) || any(greaterThanEqual(q, ivec2(uPrevResolution)))) continue;
    vec4 a = texelFetch(uPrevAlbedo, q, 0);
    vec4 n = texelFetch(uPrevNormal, q, 0);
    bool same = surface
      ? a.w > 0.5 && abs(n.w - expected) < 0.02 * expected && dot(normalize(n.xyz + vec3(1e-6)), g.normal) > 0.85
      : a.w < 0.5;
    if (!same) continue;
    float w = (o.x == 1 ? t.x : 1.0 - t.x) * (o.y == 1 ? t.y : 1.0 - t.y);
    color += texelFetch(uPrevColor, q, 0) * w;
    albedo += a * w;
    normal += n * w;
    samples += texelFetch(uPrevHistory, q, 0).r * w;
    wsum += w;
  }
  if (wsum < 1e-3) return false;
  color /= wsum;
  albedo /= wsum;
  normal /= wsum;
  samples = min(samples / wsum, uHistoryCap * g.reuse);
  return true;
}

void main() {
  ivec2 pix = ivec2(gl_FragCoord.xy);
  uint pixelIndex = uint(pix.x) + uint(pix.y) * uint(uResolution.x);
  g_seed = pixelIndex * 1973u + uSeed * 9277u + 26699u;
  pcg(g_seed);

  vec3 ro, rd;
  cameraRay(gl_FragCoord.xy, ro, rd);
  Guide guide;
  vec3 color = tracePath(ro, rd, guide);

  // Guard against NaNs poisoning the running average.
  if (any(isnan(color)) || any(isinf(color))) color = vec3(0.0);
  float lum = luminance(color);

  vec4 prevColor, prevAlbedo, prevNormal;
  float n;
  if (uReproject == 0) {
    prevColor = texelFetch(uPrevColor, pix, 0);
    prevAlbedo = texelFetch(uPrevAlbedo, pix, 0);
    prevNormal = texelFetch(uPrevNormal, pix, 0);
    n = texelFetch(uPrevHistory, pix, 0).r;
  } else if (!reprojectHistory(guide, rd, prevColor, prevAlbedo, prevNormal, n)) {
    n = 0.0; // disoccluded: start this pixel over
  }

  float k = 1.0 / (n + 1.0);
  outColor = mix(prevColor, vec4(color, lum * lum), k);
  outAlbedo = mix(prevAlbedo, vec4(guide.albedo, guide.coverage), k);
  outNormal = mix(prevNormal, vec4(guide.normal, guide.depth), k);
  outHistory = vec4(n + 1.0);
}
