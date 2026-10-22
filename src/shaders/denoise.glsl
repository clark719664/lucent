// ---------------------------------------------------------------------------
// Shared by the denoiser passes. The illumination being filtered is radiance
// divided by the guide albedo, so texture detail never gets blurred: only
// lighting is, and the albedo is multiplied back in at display time.
// ---------------------------------------------------------------------------
uniform sampler2D uAlbedo; // guide albedo (rgb), coverage (a)
uniform sampler2D uNormal; // guide normal (xyz), primary depth (w)
uniform ivec2 uSize;

float luminance(vec3 c) {
  return dot(c, vec3(0.2126, 0.7152, 0.0722));
}

vec3 demodulate(vec3 c, vec3 albedo) {
  return c / max(albedo, vec3(1e-3));
}

vec3 unitNormal(vec3 n) {
  float l = length(n);
  return l > 1e-6 ? n / l : vec3(0.0, 0.0, 1.0);
}

bool inside(ivec2 q) {
  return q.x >= 0 && q.y >= 0 && q.x < uSize.x && q.y < uSize.y;
}
