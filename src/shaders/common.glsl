// ---------------------------------------------------------------------------
// Constants, RNG and sampling helpers shared by the path tracer.
// ---------------------------------------------------------------------------
const float PI = 3.14159265358979323846;
const float INV_PI = 0.31830988618379067154;
const float TWO_PI = 6.28318530717958647692;
const float INF = 1e30;
const float EPS = 1e-4;

// PCG hash (Jarzynski & Olano 2020). Fast, well-distributed, no texture lookups.
uint g_seed;

uint pcg(inout uint state) {
  uint s = state;
  state = s * 747796405u + 2891336453u;
  uint word = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (word >> 22u) ^ word;
}

float rand() {
  return float(pcg(g_seed)) * (1.0 / 4294967296.0);
}

vec2 rand2() {
  return vec2(rand(), rand());
}

// Orthonormal basis from a unit normal (Duff et al. 2017, "Building an Orthonormal Basis, Revisited").
void basis(in vec3 n, out vec3 t, out vec3 b) {
  float s = n.z >= 0.0 ? 1.0 : -1.0;
  float a = -1.0 / (s + n.z);
  float c = n.x * n.y * a;
  t = vec3(1.0 + s * n.x * n.x * a, s * c, -s * n.x);
  b = vec3(c, s + n.y * n.y * a, -n.y);
}

vec3 toWorld(vec3 v, vec3 t, vec3 b, vec3 n) {
  return t * v.x + b * v.y + n * v.z;
}

vec3 toLocal(vec3 v, vec3 t, vec3 b, vec3 n) {
  return vec3(dot(v, t), dot(v, b), dot(v, n));
}

// Cosine-weighted hemisphere sample in tangent space (z up). pdf = z / PI.
vec3 cosineHemisphere(vec2 u) {
  float r = sqrt(u.x);
  float phi = TWO_PI * u.y;
  float x = r * cos(phi);
  float y = r * sin(phi);
  return vec3(x, y, sqrt(max(0.0, 1.0 - u.x)));
}

// Uniform sample inside a cone of half-angle acos(cosThetaMax) about +Z.
vec3 uniformCone(vec2 u, float cosThetaMax) {
  float cosTheta = 1.0 - u.x * (1.0 - cosThetaMax);
  float sinTheta = sqrt(max(0.0, 1.0 - cosTheta * cosTheta));
  float phi = TWO_PI * u.y;
  return vec3(sinTheta * cos(phi), sinTheta * sin(phi), cosTheta);
}

// Concentric disk mapping (Shirley & Chiu); keeps bokeh evenly sampled.
vec2 concentricDisk(vec2 u) {
  vec2 o = 2.0 * u - 1.0;
  if (o.x == 0.0 && o.y == 0.0) return vec2(0.0);
  float r, theta;
  if (abs(o.x) > abs(o.y)) {
    r = o.x;
    theta = (PI / 4.0) * (o.y / o.x);
  } else {
    r = o.y;
    theta = (PI / 2.0) - (PI / 4.0) * (o.x / o.y);
  }
  return r * vec2(cos(theta), sin(theta));
}

float luminance(vec3 c) {
  return dot(c, vec3(0.2126, 0.7152, 0.0722));
}

// Power heuristic (beta = 2) for multiple importance sampling.
float misWeight(float a, float b) {
  float a2 = a * a;
  float b2 = b * b;
  return a2 / max(a2 + b2, 1e-10);
}
