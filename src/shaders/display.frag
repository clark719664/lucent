#version 300 es
precision highp float;

uniform sampler2D uImage;
uniform float uExposure;
uniform int uTonemap; // 0 = ACES, 1 = Reinhard, 2 = none (clip)

out vec4 fragColor;

// Narkowicz 2015 fit of the ACES filmic curve.
vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

vec3 linearToSrgb(vec3 c) {
  vec3 lo = c * 12.92;
  vec3 hi = 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055;
  return mix(lo, hi, step(0.0031308, c));
}

// Interleaved gradient noise for 8-bit dithering (Jimenez 2014).
float ign(vec2 p) {
  return fract(52.9829189 * fract(0.06711056 * p.x + 0.00583715 * p.y));
}

void main() {
  vec3 c = texelFetch(uImage, ivec2(gl_FragCoord.xy), 0).rgb * uExposure;
  if (uTonemap == 0) c = aces(c);
  else if (uTonemap == 1) c = c / (1.0 + c);
  c = linearToSrgb(clamp(c, 0.0, 1.0));
  c += (ign(gl_FragCoord.xy) - 0.5) / 255.0;
  fragColor = vec4(c, 1.0);
}
