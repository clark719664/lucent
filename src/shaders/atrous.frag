#version 300 es
precision highp float;
precision highp sampler2D;

#include "denoise.glsl"

uniform sampler2D uInput; // illumination (rgb), variance (a)
uniform int uStep;        // 1, 2, 4, 8, 16: the à-trous "holes"

uniform vec3 uCamPos;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform vec3 uCamForward;
uniform float uTanHalfFov;

uniform float uSigmaL; // luminance edge-stop, in standard deviations
uniform float uSigmaN; // normal edge-stop exponent
uniform float uSigmaP; // plane-distance edge-stop, in pixel footprints

out vec4 fragColor;

vec3 primaryDir(ivec2 p) {
  vec2 uv = (vec2(p) + 0.5) / vec2(uSize) * 2.0 - 1.0;
  float aspect = float(uSize.x) / float(uSize.y);
  return normalize(uCamForward + uCamRight * (uv.x * aspect * uTanHalfFov) + uCamUp * (uv.y * uTanHalfFov));
}

// One iteration of the edge-avoiding à-trous wavelet filter (Dammertz et al. 2010)
// with SVGF's variance-guided luminance weight (Schied et al. 2017).
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 cp = texelFetch(uInput, p, 0);
  if (texelFetch(uAlbedo, p, 0).w < 0.5) {
    fragColor = cp;
    return;
  }
  vec4 np = texelFetch(uNormal, p, 0);
  vec3 n = unitNormal(np.xyz);
  vec3 P = uCamPos + primaryDir(p) * np.w;
  float footprint = 2.0 * uTanHalfFov * np.w / float(uSize.y);

  // The luminance edge-stop uses a 3×3 blur of the variance, which is itself noisy.
  float var = 0.0;
  float wv = 0.0;
  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      ivec2 q = p + ivec2(dx, dy);
      if (!inside(q)) continue;
      float k = (dx == 0 ? 0.5 : 0.25) * (dy == 0 ? 0.5 : 0.25);
      var += texelFetch(uInput, q, 0).a * k;
      wv += k;
    }
  }
  float denom = uSigmaL * sqrt(max(var / wv, 0.0)) + 1e-6;
  float lp = luminance(cp.rgb);

  const float h[3] = float[3](0.375, 0.25, 0.0625);
  vec3 sum = cp.rgb * (h[0] * h[0]);
  float sumVar = cp.a * (h[0] * h[0]) * (h[0] * h[0]);
  float wsum = h[0] * h[0];

  for (int dy = -2; dy <= 2; dy++) {
    for (int dx = -2; dx <= 2; dx++) {
      if (dx == 0 && dy == 0) continue;
      ivec2 q = p + ivec2(dx, dy) * uStep;
      if (!inside(q) || texelFetch(uAlbedo, q, 0).w < 0.5) continue;
      vec4 cq = texelFetch(uInput, q, 0);
      vec4 nq = texelFetch(uNormal, q, 0);
      float k = h[abs(dx)] * h[abs(dy)];
      float wn = pow(max(0.0, dot(n, unitNormal(nq.xyz))), uSigmaN);
      vec3 Q = uCamPos + primaryDir(q) * nq.w;
      float reach = uSigmaP * footprint * float(uStep) * length(vec2(dx, dy));
      float wp = exp(-abs(dot(n, Q - P)) / (reach + 1e-6));
      float wl = exp(-abs(lp - luminance(cq.rgb)) / denom);
      float w = k * wn * wp * wl;
      sum += cq.rgb * w;
      sumVar += cq.a * w * w;
      wsum += w;
    }
  }
  fragColor = vec4(sum / wsum, sumVar / (wsum * wsum));
}
