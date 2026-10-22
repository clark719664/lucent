/**
 * Remote content for the gallery: Khronos glTF sample models and Poly Haven
 * HDRIs, fetched on demand (both hosts send CORS headers). Nothing here is
 * bundled, so the app stays small and works offline with the built-in scenes.
 */

export interface HDRIEntry {
  id: string;
  name: string;
}

/** CC0 HDRIs from polyhaven.com. */
export const HDRIS: readonly HDRIEntry[] = [
  { id: 'studio_small_08', name: 'Studio' },
  { id: 'brown_photostudio_02', name: 'Photo studio' },
  { id: 'venice_sunset', name: 'Venice sunset' },
  { id: 'royal_esplanade', name: 'Royal esplanade' },
  { id: 'kiara_1_dawn', name: 'Kiara dawn' },
  { id: 'sunflowers_puresky', name: 'Sunflowers sky' },
  { id: 'aerodynamics_workshop', name: 'Workshop' },
  { id: 'lebombo', name: 'Lebombo interior' },
];

export const hdriURL = (id: string): string => `https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/2k/${id}_2k.hdr`;

export interface GalleryModel {
  id: string;
  name: string;
  /** What the model exercises. */
  features: string;
  credit: string;
  /** Download size of the .glb, for the card. */
  megabytes: number;
  hdri: string;
  rotation?: number;
  exposure?: number;
  azimuth?: number;
  elevation?: number;
  distance?: number;
  thumbnail: string;
}

const KHRONOS = 'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models';

export const modelURL = (id: string): string => `${KHRONOS}/${id}/glTF-Binary/${id}.glb`;
const shot = (id: string, file = 'screenshot.jpg') => `${KHRONOS}/${id}/screenshot/${file}`;

export const MODELS: readonly GalleryModel[] = [
  {
    id: 'ToyCar', name: 'Toy Car', features: 'Clearcoat · sheen · transmission',
    credit: 'Guido Odendahl, Eric Chadwick · CC0', megabytes: 5.4, hdri: 'studio_small_08', thumbnail: shot('ToyCar'),
  },
  {
    id: 'DragonAttenuation', name: 'Dragon', features: 'Volumetric absorption · refraction',
    credit: 'Stanford CG Lab, Morgan McGuire · glTF CC0', megabytes: 6.4, hdri: 'venice_sunset', thumbnail: shot('DragonAttenuation'),
  },
  {
    id: 'SheenChair', name: 'Sheen Chair', features: 'Fabric sheen · texture transforms',
    credit: 'Wayfair · CC0', megabytes: 4.1, hdri: 'brown_photostudio_02', thumbnail: shot('SheenChair'),
  },
  {
    id: 'DamagedHelmet', name: 'Damaged Helmet', features: 'PBR maps · normal mapping · emissive',
    credit: 'theblueturtle_ (CC BY-NC), ctxwing (CC BY)', megabytes: 3.8, hdri: 'royal_esplanade', thumbnail: shot('DamagedHelmet', 'screenshot.png'),
  },
  {
    id: 'CarConcept', name: 'Car Concept', features: 'Clearcoat car paint · glass',
    credit: 'Darmstadt Graphics Group · CC BY', megabytes: 11.8, hdri: 'kiara_1_dawn', thumbnail: shot('CarConcept'),
  },
  {
    id: 'ChronographWatch', name: 'Chronograph Watch', features: 'Transmission · fine detail',
    credit: 'Darmstadt Graphics Group · CC BY', megabytes: 7.4, hdri: 'studio_small_08', thumbnail: shot('ChronographWatch'),
  },
  {
    id: 'AntiqueCamera', name: 'Antique Camera', features: 'Metal-rough textures',
    credit: 'UX3D · CC0', megabytes: 17.5, hdri: 'aerodynamics_workshop', thumbnail: shot('AntiqueCamera'),
  },
  {
    id: 'GlamVelvetSofa', name: 'Velvet Sofa', features: 'Sheen velvet',
    credit: 'Wayfair · CC BY', megabytes: 3.1, hdri: 'lebombo', thumbnail: shot('GlamVelvetSofa'),
  },
  {
    id: 'ABeautifulGame', name: 'A Beautiful Game', features: '1.5M triangles · glass pieces',
    credit: 'ASWF, Ed Mackey · CC BY', megabytes: 43, hdri: 'brown_photostudio_02', thumbnail: shot('ABeautifulGame'),
  },
];
