import { checker, glass, light, matte, metal, material, type Material } from './material';
import { box, floor, quad, torusKnot, transform } from './mesh';
import { proceduralEnvironment } from './environment';
import type { Scene, Sphere } from './scene';

type PresetSpec = Omit<Scene, 'env' | 'ground' | 'textures'>;

/** Presets light themselves with the procedural sky and model their own floors. */
const preset = (spec: PresetSpec): Scene => ({
  ...spec,
  env: proceduralEnvironment(),
  ground: { enabled: false, height: 0, material: matte([0.5, 0.5, 0.5]) },
  textures: [],
});

export const defaultSun = (overrides: Partial<Scene['sun']> = {}): Scene['sun'] => ({
  elevation: 38,
  azimuth: 215,
  color: [1, 0.93, 0.82],
  intensity: 7,
  angularRadius: 1.2,
  ...overrides,
});

export const daySky = (intensity = 1): Scene['sky'] => ({
  enabled: true,
  zenith: [0.22, 0.42, 0.85],
  horizon: [0.78, 0.86, 0.98],
  ground: [0.28, 0.25, 0.22],
  intensity,
});

const noSky: Scene['sky'] = {
  enabled: false,
  zenith: [0, 0, 0],
  horizon: [0, 0, 0],
  ground: [0, 0, 0],
  intensity: 0,
};

/** Classic Cornell box: the "hello world" of global illumination. */
function cornell(): Scene {
  const white = matte([0.73, 0.73, 0.73]);
  const red = matte([0.65, 0.05, 0.05]);
  const green = matte([0.12, 0.45, 0.15]);
  const lamp = light([1, 0.85, 0.65], 17);

  const s = 1;
  const h = 2 * s;
  const walls = [
    { mesh: floor([0, 0, 0], s), material: white },
    { mesh: quad([-s, h, s], [-s, h, -s], [s, h, -s], [s, h, s]), material: white }, // ceiling
    { mesh: quad([-s, 0, -s], [-s, h, -s], [s, h, -s], [s, 0, -s]), material: white }, // back
    { mesh: quad([-s, 0, s], [-s, h, s], [-s, h, -s], [-s, 0, -s]), material: red }, // left
    { mesh: quad([s, 0, -s], [s, h, -s], [s, h, s], [s, 0, s]), material: green }, // right
    { mesh: quad([-0.25, h - 0.002, 0.25], [-0.25, h - 0.002, -0.25], [0.25, h - 0.002, -0.25], [0.25, h - 0.002, 0.25]), material: lamp },
  ];
  const tallBlock = transform(box([-0.3, 0, -0.3], [0.3, 1.2, 0.3]), { rotateY: 0.3, translate: [-0.35, 0, -0.3] });
  const shortBlock = transform(box([-0.3, 0, -0.3], [0.3, 0.6, 0.3]), { rotateY: -0.28, translate: [0.38, 0, 0.35] });

  return preset({
    name: 'Cornell Box',
    exposure: 1,
    description: 'Diffuse interreflection, colour bleeding and soft shadows from a single area light.',
    camera: { position: [0, 1, 3.9], target: [0, 1, 0], fov: 40, aperture: 0, focusDistance: 3.9 },
    sun: defaultSun({ intensity: 0 }),
    sky: noSky,
    spheres: [
      { center: [0.38, 0.6 + 0.32, 0.35], radius: 0.32, material: glass([1, 1, 1], 1.5) },
    ],
    meshes: [
      ...walls,
      { mesh: tallBlock, material: white },
      { mesh: shortBlock, material: white },
    ],
  });
}

/** Outdoor showroom: sun, sky, a gold trefoil knot and a few hero spheres. */
function showroom(): Scene {
  const ground = checker([0.82, 0.8, 0.76], [0.18, 0.18, 0.2], 0.9, 0.85);
  const knot = transform(torusKnot({ tube: 0.3, tubularSegments: 220, radialSegments: 22 }), {
    scale: 0.75,
    translate: [0, 0.78, 0],
    rotateY: 0.4,
  });

  const spheres: Sphere[] = [
    { center: [-1.9, 0.55, 0.9], radius: 0.55, material: glass([0.95, 0.98, 1], 1.5) },
    { center: [1.85, 0.5, 1.1], radius: 0.5, material: metal([0.95, 0.64, 0.54], 0.05) },
    { center: [1.4, 0.35, -1.6], radius: 0.35, material: matte([0.9, 0.25, 0.2], 0.8) },
    { center: [-1.1, 0.3, -1.9], radius: 0.3, material: material({ albedo: [0.2, 0.5, 0.95], roughness: 0.25, metallic: 0 }) },
    { center: [0.2, 0.22, 2.1], radius: 0.22, material: glass([0.9, 1, 0.9], 1.33, 0.08) },
  ];

  return preset({
    name: 'Showroom',
    exposure: 0.55,
    description: 'Sun + sky lighting, a BVH-accelerated 9,680-triangle gold knot, caustics and depth of field.',
    camera: { position: [0.9, 1.6, 5.9], target: [0, 0.72, 0], fov: 38, aperture: 0.05, focusDistance: 5.9 },
    sun: defaultSun(),
    sky: daySky(1),
    spheres,
    meshes: [
      { mesh: floor([0, 0, 0], 30), material: ground },
      { mesh: knot, material: metal([1, 0.78, 0.35], 0.18) },
    ],
  });
}

/** Grid of spheres sweeping roughness (x) against metallic (y). */
function materialStudy(): Scene {
  const spheres: Sphere[] = [];
  const cols = 7;
  const rows = 4;
  const spacing = 0.9;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const roughness = x / (cols - 1);
      const t = y / (rows - 1);
      let m: Material;
      if (y === 0) m = glass([1, 1, 1], 1.5, roughness * 0.6);
      else if (y === 1) m = material({ albedo: [0.95, 0.35, 0.25], metallic: 0, roughness: Math.max(0.03, roughness) });
      else if (y === 2) m = material({ albedo: [0.4, 0.75, 0.95], metallic: t, roughness: Math.max(0.03, roughness) });
      else m = metal([0.98, 0.84, 0.6], Math.max(0.03, roughness));
      spheres.push({
        center: [(x - (cols - 1) / 2) * spacing, 0.4, (y - (rows - 1) / 2) * spacing],
        radius: 0.38,
        material: m,
      });
    }
  }
  return preset({
    name: 'Material Study',
    exposure: 0.5,
    description: 'Roughness sweeps left→right. Rows: rough glass, dielectric, dielectric→metal, gold.',
    camera: { position: [0, 4.6, 5.6], target: [0, 0.2, 0], fov: 38, aperture: 0, focusDistance: 7 },
    sun: defaultSun({ elevation: 55, azimuth: 160, intensity: 7 }),
    sky: daySky(1.0),
    spheres,
    meshes: [{ mesh: floor([0, 0, 0], 30), material: matte([0.6, 0.6, 0.62], 0.9) }],
  });
}

/** Night scene: only emissive spheres light the world, a stress test for light sampling. */
function nocturne(): Scene {
  const ground = checker([0.35, 0.35, 0.38], [0.08, 0.08, 0.09], 1.2, 0.3);
  const knot = transform(torusKnot({ p: 3, q: 4, tube: 0.22, tubularSegments: 260, radialSegments: 18 }), {
    scale: 0.8,
    translate: [0, 0.9, 0],
    rotateY: -0.6,
  });
  return preset({
    name: 'Nocturne',
    exposure: 1,
    description: 'No sky. Three coloured emitters sampled explicitly; glass and chrome catch the rest.',
    camera: { position: [-1.2, 1.9, 4.8], target: [0, 0.7, 0], fov: 40, aperture: 0.06, focusDistance: 4.6 },
    sun: defaultSun({ intensity: 0 }),
    sky: noSky,
    spheres: [
      { center: [-2.2, 1.6, -1.2], radius: 0.28, material: light([1, 0.45, 0.2], 60) },
      { center: [2.4, 2.2, -0.6], radius: 0.22, material: light([0.3, 0.6, 1], 80) },
      { center: [0.3, 3.2, 2.4], radius: 0.18, material: light([0.95, 0.95, 1], 90) },
      { center: [1.5, 0.5, 1.4], radius: 0.5, material: glass([0.9, 0.95, 1], 1.5) },
      { center: [-1.6, 0.45, 1.2], radius: 0.45, material: metal([0.95, 0.95, 0.97], 0.03) },
    ],
    meshes: [
      { mesh: floor([0, 0, 0], 30), material: ground },
      { mesh: knot, material: material({ albedo: [0.85, 0.2, 0.55], metallic: 0.6, roughness: 0.3 }) },
    ],
  });
}

export const PRESETS: readonly (() => Scene)[] = [showroom, cornell, materialStudy, nocturne];

export const presetNames = (): string[] => PRESETS.map((p) => p().name);
