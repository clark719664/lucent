#version 300 es
precision highp float;
precision highp sampler2D;

uniform sampler2D uColor;    // running mean radiance
uniform sampler2D uAlbedo;   // guide albedo, coverage
uniform sampler2D uDenoised; // filtered illumination
uniform float uDenoiseWeight; // 0 = raw accumulation
uniform vec2 uRenderSize;    // traced region; smaller than the view while orbiting
uniform vec2 uViewSize;
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

vec3 radiance(ivec2 p) {
  p = clamp(p, ivec2(0), ivec2(uRenderSize) - 1);
  vec3 raw = texelFetch(uColor, p, 0).rgb;
  if (uDenoiseWeight > 0.0) {
    vec4 a = texelFetch(uAlbedo, p, 0);
    if (a.w >= 0.5) return mix(raw, texelFetch(uDenoised, p, 0).rgb * max(a.rgb, vec3(1e-3)), uDenoiseWeight);
  }
  return raw;
}

void main() {
  vec3 c;
  if (uRenderSize == uViewSize) {
    c = radiance(ivec2(gl_FragCoord.xy));
  } else {
    // Catmull-Rom upsampling of the reduced-resolution preview: sharper than bilinear.
    vec2 src = gl_FragCoord.xy * (uRenderSize / uViewSize) - 0.5;
    ivec2 i = ivec2(floor(src));
    vec2 f = src - floor(src);
    vec2 w[4];
    w[0] = f * (-0.5 + f * (1.0 - 0.5 * f));
    w[1] = 1.0 + f * f * (-2.5 + 1.5 * f);
    w[2] = f * (0.5 + f * (2.0 - 1.5 * f));
    w[3] = f * f * (-0.5 + 0.5 * f);
    c = vec3(0.0);
    for (int y = 0; y < 4; y++) {
      for (int x = 0; x < 4; x++) c += radiance(i + ivec2(x - 1, y - 1)) * (w[x].x * w[y].y);
    }
    c = max(c, vec3(0.0));
  }
  c *= uExposure;
  if (uTonemap == 0) c = aces(c);
  else if (uTonemap == 1) c = c / (1.0 + c);
  c = linearToSrgb(clamp(c, 0.0, 1.0));
  c += (ign(gl_FragCoord.xy) - 0.5) / 255.0;
  fragColor = vec4(c, 1.0);
}
