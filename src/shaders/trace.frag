#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

#include "common.glsl"
#include "scene.glsl"
#include "lights.glsl"
#include "bsdf.glsl"

uniform vec2 uResolution;
uniform uint uFrame;          // samples accumulated so far
uniform sampler2D uPrevious;  // running average

uniform vec3 uCamPos;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform vec3 uCamForward;
uniform float uTanHalfFov;
uniform float uAperture;
uniform float uFocusDist;

uniform int uMaxBounces;
uniform float uClamp;         // max luminance an indirect sample may contribute

out vec4 fragColor;

const float RAY_OFFSET = 1e-3;

vec3 surfaceAlbedo(Material m, vec3 p) {
  if (m.checkerScale <= 0.0) return m.albedo;
  // Half-cell offset keeps surfaces lying exactly on a lattice plane (y = 0 floors) stable.
  vec3 q = floor(p * m.checkerScale + 0.5);
  float c = mod(q.x + q.y + q.z, 2.0);
  return c < 0.5 ? m.albedo : m.albedo2;
}

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

vec3 tracePath(vec3 ro, vec3 rd) {
  vec3 radiance = vec3(0.0);
  vec3 throughput = vec3(1.0);
  bool specularBounce = true;
  float bsdfPdf = 0.0;

  for (int bounce = 0; bounce <= uMaxBounces; bounce++) {
    Hit hit;
    if (!traceScene(ro, rd, INF, hit)) {
      radiance += clampContribution(throughput * environment(rd, specularBounce, bsdfPdf), bounce);
      break;
    }

    Material m = fetchMaterial(hit.material);

    if (any(greaterThan(m.emission, vec3(0.0)))) {
      float w = 1.0;
      if (!specularBounce && hit.light >= 0) {
        float pl = lightPdf(hit.light, ro, rd, hit.t) / float(uLightCount);
        w = misWeight(bsdfPdf, pl);
      }
      radiance += clampContribution(throughput * m.emission * w, bounce);
      break; // emitters are treated as black bodies
    }

    vec3 albedo = surfaceAlbedo(m, hit.position);
    vec3 wo = -rd;
    vec3 n = hit.normal;
    vec3 ng = hit.geomNormal;

    bool glass = m.transmission > 0.0 && rand() < m.transmission;
    if (glass) {
      vec3 wi, weight;
      bool reflected;
      if (!sampleDielectric(albedo, m.roughness, m.ior, hit.frontFace, n, ng, wo, wi, weight, reflected)) break;
      throughput *= weight;
      ro = hit.position + ng * (reflected ? RAY_OFFSET : -RAY_OFFSET);
      rd = wi;
      specularBounce = true;
    } else {
      vec3 shadowOrigin = hit.position + ng * RAY_OFFSET;

      // --- Next-event estimation: sun ---------------------------------------
      if (uSunEnabled != 0) {
        vec3 wi = sampleSunDirection(rand2());
        float NdotL = dot(n, wi);
        if (NdotL > 0.0 && dot(ng, wi) > 0.0 && !occluded(shadowOrigin, wi, INF)) {
          float pb;
          vec3 f = evalOpaque(albedo, m.metallic, m.roughness, n, wo, wi, pb);
          float w = misWeight(uSunPdf, pb);
          radiance += clampContribution(throughput * f * NdotL * uSunRadiance * (w / uSunPdf), bounce);
        }
      }

      // --- Next-event estimation: one emitter chosen uniformly --------------
      if (uLightCount > 0) {
        int li = min(int(rand() * float(uLightCount)), uLightCount - 1);
        LightSample ls = sampleLight(li, hit.position, rand2());
        float NdotL = dot(n, ls.dir);
        if (ls.pdf > 0.0 && NdotL > 0.0 && dot(ng, ls.dir) > 0.0 &&
            !occluded(shadowOrigin, ls.dir, ls.dist - RAY_OFFSET)) {
          float pl = ls.pdf / float(uLightCount);
          float pb;
          vec3 f = evalOpaque(albedo, m.metallic, m.roughness, n, wo, ls.dir, pb);
          float w = misWeight(pl, pb);
          radiance += clampContribution(throughput * f * NdotL * ls.radiance * (w / pl), bounce);
        }
      }

      // --- Continue the path -------------------------------------------------
      BSDFSample s = sampleOpaque(albedo, m.metallic, m.roughness, n, wo);
      if (s.pdf <= 0.0 || dot(s.dir, ng) <= 0.0) break;
      throughput *= s.weight;
      bsdfPdf = s.pdf;
      specularBounce = false;
      ro = shadowOrigin;
      rd = s.dir;
    }

    // Russian roulette once the path has had a chance to carry energy.
    if (bounce >= 2) {
      float p = min(0.95, max(throughput.r, max(throughput.g, throughput.b)));
      if (rand() >= p) break;
      throughput /= p;
    }
  }
  return radiance;
}

void main() {
  ivec2 pix = ivec2(gl_FragCoord.xy);
  uint pixelIndex = uint(pix.x) + uint(pix.y) * uint(uResolution.x);
  g_seed = pixelIndex * 1973u + uFrame * 9277u + 26699u;
  pcg(g_seed);

  vec3 ro, rd;
  cameraRay(gl_FragCoord.xy, ro, rd);
  vec3 color = tracePath(ro, rd);

  // Guard against NaNs poisoning the running average.
  if (any(isnan(color)) || any(isinf(color))) color = vec3(0.0);

  vec3 prev = texelFetch(uPrevious, pix, 0).rgb;
  float n = float(uFrame);
  fragColor = vec4((prev * n + color) / (n + 1.0), 1.0);
}
