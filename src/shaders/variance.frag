#version 300 es
precision highp float;
precision highp sampler2D;

#include "denoise.glsl"

uniform sampler2D uColor; // running mean radiance (rgb), running mean luminance² (a)
uniform float uSamples;

out vec4 fragColor;

// Demodulates and estimates the variance of each pixel's mean. With enough
// samples the accumulator's second moment gives it directly; for the first few
// (the moving camera) it is estimated from similar neighbours, as in SVGF.
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 c = texelFetch(uColor, p, 0);
  vec4 a = texelFetch(uAlbedo, p, 0);
  if (a.w < 0.5) {
    fragColor = vec4(c.rgb, 0.0);
    return;
  }
  vec3 illum = demodulate(c.rgb, a.rgb);
  float la = max(luminance(a.rgb), 1e-3);

  float variance;
  if (uSamples >= 4.0) {
    float l = luminance(c.rgb);
    variance = max(0.0, c.a - l * l) / (la * la) / uSamples;
  } else {
    vec4 np = texelFetch(uNormal, p, 0);
    vec3 n = unitNormal(np.xyz);
    float s1 = 0.0;
    float s2 = 0.0;
    float ws = 0.0;
    for (int dy = -3; dy <= 3; dy++) {
      for (int dx = -3; dx <= 3; dx++) {
        ivec2 q = p + ivec2(dx, dy);
        if (!inside(q)) continue;
        vec4 aq = texelFetch(uAlbedo, q, 0);
        if (aq.w < 0.5) continue;
        vec4 nq = texelFetch(uNormal, q, 0);
        float w = pow(max(0.0, dot(n, unitNormal(nq.xyz))), 32.0) * step(abs(np.w - nq.w), 0.1 * np.w);
        float l = luminance(demodulate(texelFetch(uColor, q, 0).rgb, aq.rgb));
        s1 += w * l;
        s2 += w * l * l;
        ws += w;
      }
    }
    float m1 = s1 / max(ws, 1e-6);
    variance = max(0.0, s2 / max(ws, 1e-6) - m1 * m1) / uSamples;
  }
  fragColor = vec4(illum, variance);
}
