// ---------------------------------------------------------------------------
// Surface scattering. Opaque surfaces layer a GGX clearcoat over Charlie sheen
// over a Lambert + GGX base, all sampled with one mixture pdf so every lobe
// takes part in MIS. Glass is an (optionally roughened) delta dielectric.
// ---------------------------------------------------------------------------
uniform sampler2D uSheenLUT; // directional albedo of the sheen lobe, see sheen.ts

const float SHEEN_LUT_SIZE = 16.0;
const float MIN_SHEEN_ROUGHNESS = 0.07;

struct Surface {
  vec3 albedo;
  float metallic;
  float roughness;
  float ior;
  float transmission;
  vec3 emission;
  float clearcoat;
  float clearcoatRoughness;
  vec3 sheenColor;
  float sheenRoughness;
  bool thinWalled;
  vec3 absorption; // Beer–Lambert coefficient inside the volume; 0 = clear
  vec3 n;          // shading normal (normal-mapped)
  vec3 nc;         // clearcoat normal (interpolated, not normal-mapped)
};

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

float fresnelSchlick(float cosTheta, float F0) {
  return F0 + (1.0 - F0) * pow(1.0 - clamp(cosTheta, 0.0, 1.0), 5.0);
}

float dielectricF0(float ior) {
  float r = (ior - 1.0) / (ior + 1.0);
  return r * r;
}

float fresnelDielectric(float cosTheta, float ior) {
  return fresnelSchlick(cosTheta, dielectricF0(ior));
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

// Charlie sheen distribution (Estevez & Kulla 2017) and Neubelt's visibility.
float D_Charlie(float alpha, float NdotH) {
  float inv = 1.0 / alpha;
  float sin2 = max(1.0 - NdotH * NdotH, 0.0);
  return (2.0 + inv) * pow(sin2, inv * 0.5) / TWO_PI;
}

float V_Neubelt(float NdotL, float NdotV) {
  return 1.0 / (4.0 * (NdotL + NdotV - NdotL * NdotV));
}

float sheenAlbedo(float NdotV, float roughness) {
  vec2 uv = (vec2(NdotV, roughness) * (SHEEN_LUT_SIZE - 1.0) + 0.5) / SHEEN_LUT_SIZE;
  return texture(uSheenLUT, uv).r;
}

// Probability of choosing the base specular lobe; roughly the average Fresnel at this view angle.
float specularProbability(vec3 F0, float metallic, float NdotV) {
  float f = luminance(fresnelSchlick(NdotV, F0));
  return mix(clamp(f, 0.1, 0.9), 1.0, metallic);
}

// Probability of sampling the clearcoat, from its reflectance relative to the base's.
float coatProbability(Surface s, vec3 wo) {
  if (s.clearcoat <= 0.0) return 0.0;
  float Fc = s.clearcoat * fresnelSchlick(max(dot(s.nc, wo), 0.0), 0.04);
  float base = (1.0 - Fc) * max(luminance(s.albedo), 0.04);
  return clamp(Fc / (Fc + base), 0.15, 0.85);
}

vec3 baseF0(Surface s) {
  return mix(vec3(dielectricF0(s.ior)), s.albedo, s.metallic);
}

// Evaluates the opaque BSDF (not multiplied by cosine) and its sampling pdf.
// All vectors are world space; `wo` points to the viewer.
vec3 evalOpaque(Surface s, vec3 wo, vec3 wi, out float pdf) {
  vec3 n = s.n;
  float NdotL = dot(n, wi);
  float NdotV = dot(n, wo);
  pdf = 0.0;
  if (NdotL <= 0.0 || NdotV <= 0.0) return vec3(0.0);

  float a = alphaFromRoughness(s.roughness);
  vec3 H = normalize(wo + wi);
  float NdotH = max(dot(n, H), 0.0);
  float VdotH = max(dot(wo, H), 0.0);

  vec3 F0 = baseF0(s);
  vec3 F = fresnelSchlick(VdotH, F0);
  float D = D_GGX(NdotH, a);
  float G1v = G1_GGX(NdotV, a);
  float G = G1v * G1_GGX(NdotL, a);

  vec3 specular = D * G * F / max(4.0 * NdotV * NdotL, 1e-6);
  vec3 diffuse = (1.0 - F) * s.albedo * (1.0 - s.metallic) * INV_PI;
  vec3 f = diffuse + specular;

  float pSpec = specularProbability(F0, s.metallic, NdotV);
  pdf = mix(NdotL * INV_PI, G1v * D / max(4.0 * NdotV, 1e-6), pSpec);

  float sheenMax = max3(s.sheenColor);
  if (sheenMax > 0.0) {
    float sr = max(s.sheenRoughness, MIN_SHEEN_ROUGHNESS);
    vec3 sheen = s.sheenColor * D_Charlie(sr * sr, NdotH) * V_Neubelt(NdotL, NdotV);
    float scale = 1.0 - sheenMax * max(sheenAlbedo(NdotV, sr), sheenAlbedo(NdotL, sr));
    f = sheen + f * scale;
  }

  float pCoat = coatProbability(s, wo);
  if (pCoat > 0.0) {
    float cV = dot(s.nc, wo);
    float cL = dot(s.nc, wi);
    vec3 coat = vec3(0.0);
    float pdfCoat = 0.0;
    if (cV > 0.0 && cL > 0.0) {
      float ac = alphaFromRoughness(s.clearcoatRoughness);
      float cH = max(dot(s.nc, H), 0.0);
      float Dc = D_GGX(cH, ac);
      float G1c = G1_GGX(cV, ac);
      coat = vec3(Dc * G1c * G1_GGX(cL, ac) * fresnelSchlick(VdotH, 0.04) / (4.0 * cV * cL));
      pdfCoat = G1c * Dc / (4.0 * cV);
    }
    float Fcv = fresnelSchlick(max(cV, 0.0), 0.04);
    f = f * (1.0 - s.clearcoat * Fcv) + s.clearcoat * coat;
    pdf = mix(pdf, pdfCoat, pCoat);
  }
  return f;
}

struct BSDFSample {
  vec3 dir;
  vec3 weight; // f * cos / pdf
  float pdf;
};

BSDFSample sampleOpaque(Surface s, vec3 wo) {
  BSDFSample bs;
  bs.pdf = 0.0;
  bs.weight = vec3(0.0);

  vec3 wi;
  if (rand() < coatProbability(s, wo)) {
    vec3 t, b;
    basis(s.nc, t, b);
    vec3 woL = toLocal(wo, t, b, s.nc);
    if (woL.z <= 0.0) return bs;
    vec3 H = sampleGGXVNDF(woL, alphaFromRoughness(s.clearcoatRoughness), rand2());
    wi = toWorld(reflect(-woL, H), t, b, s.nc);
  } else {
    vec3 t, b;
    basis(s.n, t, b);
    vec3 woL = toLocal(wo, t, b, s.n);
    if (woL.z <= 0.0) return bs;
    vec3 wiL;
    if (rand() < specularProbability(baseF0(s), s.metallic, woL.z)) {
      vec3 H = sampleGGXVNDF(woL, alphaFromRoughness(s.roughness), rand2());
      wiL = reflect(-woL, H);
    } else {
      wiL = cosineHemisphere(rand2());
    }
    wi = toWorld(wiL, t, b, s.n);
  }

  float NdotL = dot(s.n, wi);
  if (NdotL <= 0.0) return bs;
  float pdf;
  vec3 f = evalOpaque(s, wo, wi, pdf);
  if (pdf <= 0.0) return bs;
  bs.dir = wi;
  bs.pdf = pdf;
  bs.weight = f * NdotL / pdf;
  return bs;
}

// Delta dielectric with a microfacet-perturbed normal for roughness. Thin-walled
// surfaces transmit without bending (a sheet, not a solid). Returns false if the
// sampled direction ends up on the wrong side of the surface (path is terminated).
bool sampleDielectric(Surface s, bool frontFace, vec3 ng, vec3 wo,
                      out vec3 wi, out vec3 weight, out bool reflected) {
  vec3 n = s.n;
  vec3 t, b;
  basis(n, t, b);
  vec3 woL = toLocal(wo, t, b, n);
  if (woL.z <= 0.0) return false;

  vec3 H = n;
  if (s.roughness > 0.0) {
    vec3 HL = sampleGGXVNDF(woL, alphaFromRoughness(s.roughness), rand2());
    H = toWorld(HL, t, b, n);
  }
  float cosI = dot(wo, H);
  if (cosI <= 0.0) { H = n; cosI = woL.z; }

  float eta = frontFace ? 1.0 / s.ior : s.ior;
  float sin2T = eta * eta * (1.0 - cosI * cosI);
  float Fr = fresnelDielectric(cosI, s.ior);
  if (s.thinWalled) Fr = 2.0 * Fr / (1.0 + Fr); // both interfaces of the sheet
  else if (sin2T > 1.0) Fr = 1.0;

  if (rand() < Fr) {
    wi = reflect(-wo, H);
    weight = vec3(1.0);
    reflected = true;
    return dot(wi, ng) > 0.0;
  }
  wi = s.thinWalled ? -wo : refract(-wo, H, eta);
  weight = s.albedo;
  reflected = false;
  return dot(wi, ng) < 0.0;
}
