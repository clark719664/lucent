#version 300 es
precision highp float;

// Resamples an uploaded image into one texture-array layer. The source is
// mipmapped, so downscaling picks the right level from screen derivatives.
uniform sampler2D uSource;
uniform float uSize;

out vec4 fragColor;

void main() {
  fragColor = texture(uSource, gl_FragCoord.xy / uSize);
}
