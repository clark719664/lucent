// ---------------------------------------------------------------------------
// Surface scattering. Opaque surfaces use a Lambert + GGX microfacet model
// with visible-normal sampling; glass is a (optionally roughened) dielectric
// handled as a delta lobe.
// ---------------------------------------------------------------------------
float D_GGX(float NdotH, float a) {
  float a2 = a * a;
  float d = NdotH * NdotH * (a2 - 1.0) + 1.0;
  return a2 / (PI * d * d);
}

// Smith G1 for GGX (height-correlated form is overkill here).
float G1_GGX(float NdotX, float a) {
  float a2 = a * a;
  return 2.0 * NdotX / (NdotX + sqrt(a2 + (1.0 - a2) * NdotX * NdotX));
}

vec3 fresnelSchlick(float cosTheta, vec3 F0) {
  float f = pow(1.0 - clamp(cosTheta, 0.0, 1.0), 5.0);
  return F0 + (1.0 - F0) * f;
}

float fresnelDielectric(float cosTheta, float ior) {
  float f0 = (1.0 - ior) / (1.0 + ior);
  f0 *= f0;
  return f0 + (1.0 - f0) * pow(1.0 - clamp(cosTheta, 0.0, 1.0), 5.0);
}

// Heitz 2018, "Sampling the GGX Distribution of Visible Normals". Tangent space, Ve = view dir.
vec3 sampleGGXVNDF(vec3 Ve, float a, vec2 u) {
  vec3 Vh = normalize(vec3(a * Ve.x, a * Ve.y, Ve.z));
  float lensq = Vh.x * Vh.x + Vh.y * Vh.y;
  vec3 T1 = lensq > 0.0 ? vec3(-Vh.y, Vh.x, 0.0) * inversesqrt(lensq) : vec3(1.0, 0.0, 0.0);
  vec3 T2 = cross(Vh, T1);
  float r = sqrt(u.x);
  float phi = TWO_PI * u.y;
  float t1 = r * cos(phi);
  float t2 = r * sin(phi);
  float s = 0.5 * (1.0 + Vh.z);
  t2 = (1.0 - s) * sqrt(max(0.0, 1.0 - t1 * t1)) + s * t2;
  vec3 Nh = t1 * T1 + t2 * T2 + sqrt(max(0.0, 1.0 - t1 * t1 - t2 * t2)) * Vh;
  return normalize(vec3(a * Nh.x, a * Nh.y, max(0.0, Nh.z)));
}

float alphaFromRoughness(float roughness) {
  return max(roughness * roughness, 1e-3);
}

// Probability of choosing the specular lobe; roughly the average Fresnel at this view angle.
float specularProbability(vec3 F0, float metallic, float NdotV) {
  float f = luminance(fresnelSchlick(NdotV, F0));
  return mix(clamp(f, 0.1, 0.9), 1.0, metallic);
}

// Evaluates the opaque BSDF (not multiplied by cosine) and its sampling pdf.
// All vectors are world space; `n` is the shading normal, `wo` points to the viewer.
vec3 evalOpaque(vec3 albedo, float metallic, float roughness, vec3 n, vec3 wo, vec3 wi, out float pdf) {
  float NdotL = dot(n, wi);
  float NdotV = dot(n, wo);
  pdf = 0.0;
  if (NdotL <= 0.0 || NdotV <= 0.0) return vec3(0.0);

  float a = alphaFromRoughness(roughness);
  vec3 H = normalize(wo + wi);
  float NdotH = max(dot(n, H), 0.0);
  float VdotH = max(dot(wo, H), 0.0);

  vec3 F0 = mix(vec3(0.04), albedo, metallic);
  vec3 F = fresnelSchlick(VdotH, F0);
  float D = D_GGX(NdotH, a);
  float G1v = G1_GGX(NdotV, a);
  float G = G1v * G1_GGX(NdotL, a);

  vec3 specular = D * G * F / max(4.0 * NdotV * NdotL, 1e-6);
  vec3 diffuse = (1.0 - F) * albedo * (1.0 - metallic) * INV_PI;

  float pSpec = specularProbability(F0, metallic, NdotV);
  float pdfSpec = G1v * D / max(4.0 * NdotV, 1e-6);
  float pdfDiff = NdotL * INV_PI;
  pdf = mix(pdfDiff, pdfSpec, pSpec);
  return diffuse + specular;
}

struct BSDFSample {
  vec3 dir;
  vec3 weight; // f * cos / pdf
  float pdf;
};

BSDFSample sampleOpaque(vec3 albedo, float metallic, float roughness, vec3 n, vec3 wo) {
  BSDFSample s;
  s.pdf = 0.0;
  s.weight = vec3(0.0);

  vec3 t, b;
  basis(n, t, b);
  vec3 woL = toLocal(wo, t, b, n);
  if (woL.z <= 0.0) return s;

  vec3 F0 = mix(vec3(0.04), albedo, metallic);
  float pSpec = specularProbability(F0, metallic, woL.z);
  vec3 wiL;
  if (rand() < pSpec) {
    vec3 H = sampleGGXVNDF(woL, alphaFromRoughness(roughness), rand2());
    wiL = reflect(-woL, H);
  } else {
    wiL = cosineHemisphere(rand2());
  }
  if (wiL.z <= 0.0) return s;

  vec3 wi = toWorld(wiL, t, b, n);
  float pdf;
  vec3 f = evalOpaque(albedo, metallic, roughness, n, wo, wi, pdf);
  if (pdf <= 0.0) return s;
  s.dir = wi;
  s.pdf = pdf;
  s.weight = f * wiL.z / pdf;
  return s;
}

// Delta dielectric with a microfacet-perturbed normal for roughness. Returns false if the
// sampled direction ends up on the wrong side of the surface (path is terminated).
bool sampleDielectric(vec3 albedo, float roughness, float ior, bool frontFace, vec3 n, vec3 ng, vec3 wo,
                      out vec3 wi, out vec3 weight, out bool reflected) {
  vec3 t, b;
  basis(n, t, b);
  vec3 woL = toLocal(wo, t, b, n);
  if (woL.z <= 0.0) return false;

  vec3 H = n;
  if (roughness > 0.0) {
    vec3 HL = sampleGGXVNDF(woL, alphaFromRoughness(roughness), rand2());
    H = toWorld(HL, t, b, n);
  }
  float cosI = dot(wo, H);
  if (cosI <= 0.0) { H = n; cosI = woL.z; }

  float eta = frontFace ? 1.0 / ior : ior;
  float sin2T = eta * eta * (1.0 - cosI * cosI);
  float Fr = sin2T > 1.0 ? 1.0 : fresnelDielectric(cosI, ior);

  if (rand() < Fr) {
    wi = reflect(-wo, H);
    weight = vec3(1.0);
    reflected = true;
    return dot(wi, ng) > 0.0;
  }
  wi = refract(-wo, H, eta);
  weight = albedo;
  reflected = false;
  return dot(wi, ng) < 0.0;
}
