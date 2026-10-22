import {
  createContext,
  createDataTexture,
  createTexture,
  createTextureArray,
  GLError,
  Program,
  RenderTarget,
  type GLCapabilities,
} from './gl/context';
import { preprocess, type ShaderSources } from './gl/preprocess';
import type { BVH } from './math/bvh';
import { cross, fromSpherical, normalize, scale, sub, type Vec3 } from './math/vec3';
import { bakeSky, buildEnvSampler, type HDRImage } from './scene/environment';
import { packScene, pickDistance, type Camera, type Ground, type PackedScene, type Scene } from './scene/scene';
import { SHEEN_LUT_SIZE, sheenAlbedoLUT } from './scene/sheen';
import atrousFrag from './shaders/atrous.frag?raw';
import bsdfGlsl from './shaders/bsdf.glsl?raw';
import commonGlsl from './shaders/common.glsl?raw';
import denoiseGlsl from './shaders/denoise.glsl?raw';
import displayFrag from './shaders/display.frag?raw';
import fullscreenVert from './shaders/fullscreen.vert?raw';
import lightsGlsl from './shaders/lights.glsl?raw';
import resampleFrag from './shaders/resample.frag?raw';
import sceneGlsl from './shaders/scene.glsl?raw';
import traceFrag from './shaders/trace.frag?raw';
import varianceFrag from './shaders/variance.frag?raw';

const TRACE_SOURCES: ShaderSources = {
  'trace.frag': traceFrag,
  'common.glsl': commonGlsl,
  'scene.glsl': sceneGlsl,
  'lights.glsl': lightsGlsl,
  'bsdf.glsl': bsdfGlsl,
};
const VARIANCE_SOURCES: ShaderSources = { 'variance.frag': varianceFrag, 'denoise.glsl': denoiseGlsl };
const ATROUS_SOURCES: ShaderSources = { 'atrous.frag': atrousFrag, 'denoise.glsl': denoiseGlsl };

export type Tonemap = 'aces' | 'reinhard' | 'none';

export interface RenderSettings {
  maxBounces: number;
  exposure: number;
  tonemap: Tonemap;
  /** Internal resolution as a fraction of the canvas' device-pixel size. */
  resolutionScale: number;
  /** Samples traced per animation frame; 0 adapts it to keep frames near 30 ms. */
  samplesPerFrame: number;
  /** Luminance cap for indirect contributions; 0 disables. */
  fireflyClamp: number;
  /** Stop accumulating after this many samples; 0 means never. */
  maxSamples: number;
  /** Edge-aware à-trous filtering of the displayed image. */
  denoise: boolean;
  /** Drop resolution while the camera moves if frames get slow. */
  adaptiveResolution: boolean;
  /** Reuse accumulated samples across camera moves by reprojecting them. */
  temporal: boolean;
}

export const DEFAULT_SETTINGS: RenderSettings = {
  maxBounces: 6,
  exposure: 1,
  tonemap: 'aces',
  resolutionScale: 1,
  samplesPerFrame: 0,
  fireflyClamp: 8,
  maxSamples: 0,
  denoise: true,
  adaptiveResolution: true,
  temporal: true,
};

export interface RenderStats {
  samples: number;
  elapsedMs: number;
  /** Million camera paths per second over the last second. */
  msamplesPerSec: number;
  /** Samples per pixel per second over the last second. */
  sppPerSec: number;
  /** Traced resolution; below `viewWidth × viewHeight` while previewing. */
  width: number;
  height: number;
  viewWidth: number;
  viewHeight: number;
  interactive: boolean;
  denoised: boolean;
  triangles: number;
  bvhNodes: number;
  textures: number;
  textureSize: number;
  renderer: string;
}

/** Texture units: 0–2 hold the accumulation being read; scene data starts at 3. */
const UNIT = {
  prevColor: 0,
  prevAlbedo: 1,
  prevNormal: 2,
  prevHistory: 12,
  triGeometry: 3,
  triAttributes: 4,
  bvh: 5,
  materials: 6,
  colorMaps: 7,
  dataMaps: 8,
  env: 9,
  envAlias: 10,
  sheen: 11,
} as const;

const TEXTURE_BUDGET_BYTES = 256 * 1024 * 1024;
const MOTION_HOLD_MS = 160;
/** Frame time above which the moving preview drops resolution, and below which it recovers. */
const PREVIEW_SLOW_MS = 40;
const PREVIEW_FAST_MS = 24;
const PREVIEW_MIN_SCALE = 0.5;
/** Samples a reprojected pixel may carry while moving; lower means less lag, more noise. */
const HISTORY_CAP = 8;
const ATROUS_STEPS = [1, 2, 4, 8, 16];
/** Noise falls as 1/√n, so the filter's reach shrinks as samples accumulate. */
const atrousLevels = (spp: number): number => (spp <= 4 ? 5 : spp <= 16 ? 4 : spp <= 64 ? 3 : spp <= 256 ? 2 : 1);
/** Weight of the denoised image: full until 128 spp, then a fade to the raw image by 1024. */
const denoiseWeight = (spp: number): number => Math.min(1, Math.max(0, (1024 - spp) / (1024 - 128)));

const nextPow2 = (n: number) => 2 ** Math.ceil(Math.log2(Math.max(1, n)));

interface CameraState {
  position: Vec3;
  forward: Vec3;
  right: Vec3;
  up: Vec3;
  tanHalfFov: number;
}

function cameraBasis(cam: Camera): { forward: Vec3; right: Vec3; up: Vec3 } {
  const forward = normalize(sub(cam.target, cam.position));
  const worldUp: Vec3 = Math.abs(forward[1]) > 0.999 ? [0, 0, 1] : [0, 1, 0];
  const right = normalize(cross(forward, worldUp));
  return { forward, right, up: cross(right, forward) };
}

/**
 * Progressive GPU path tracer.
 *
 * Each frame traces one or more paths per pixel into ping-ponged MRT targets
 * (radiance, albedo guide, normal/depth guide), optionally runs the denoiser on
 * the running average, then a display pass tone-maps it onto the canvas. Any
 * change to the camera, scene or lighting resets the average.
 */
export class Renderer {
  readonly caps: GLCapabilities;
  readonly settings: RenderSettings = { ...DEFAULT_SETTINGS };

  private readonly gl: WebGL2RenderingContext;
  private readonly trace: Program;
  private readonly display: Program;
  private readonly variance: Program;
  private readonly atrous: Program;
  private readonly resample: Program;
  private readonly vao: WebGLVertexArrayObject;
  private readonly sheenLUT: WebGLTexture;

  private accum: [RenderTarget, RenderTarget] | null = null;
  private filtered: [RenderTarget, RenderTarget] | null = null;
  private sceneTextures: WebGLTexture[] = [];
  private textureArrays: WebGLTexture[] = [];
  private envTextures: WebGLTexture[] = [];
  private envSource: HDRImage | null = null;
  private envKey = '';
  private packed: PackedScene | null = null;
  private scene: Scene | null = null;
  private textureSize = 0;
  private camera: CameraState = { position: [0, 0, 0], forward: [0, 0, -1], right: [1, 0, 0], up: [0, 1, 0], tanHalfFov: 1 };
  /** Camera and resolution the accumulated history was traced with. */
  private history: { camera: CameraState; width: number; height: number } | null = null;
  private reprojectPending = false;

  /** Effective samples per pixel behind the image (capped while moving). */
  private frame = 0;
  /** RNG stream index; advances every sample and never resets, so moving frames never repeat noise. */
  private seed = 0;
  private startTime = 0;
  private sampleWindow = { time: 0, samples: 0, paths: 0, sppRate: 0, pathRate: 0 };
  private width = 1;
  private height = 1;
  private renderWidth = 1;
  private renderHeight = 1;
  private paused = false;
  private elapsedAtPause = 0;
  private lastMotion = -Infinity;
  private lastFrameTime = 0;
  private interactive = false;
  private previewScale = 1;
  private autoSpp = 1;
  private denoisedFrame = -1;
  private denoised: RenderTarget | null = null;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.caps = createContext(canvas);
    this.gl = this.caps.gl;
    const gl = this.gl;
    this.trace = new Program(gl, fullscreenVert, preprocess('trace.frag', TRACE_SOURCES), TRACE_SOURCES);
    this.display = new Program(gl, fullscreenVert, displayFrag);
    this.variance = new Program(gl, fullscreenVert, preprocess('variance.frag', VARIANCE_SOURCES), VARIANCE_SOURCES);
    this.atrous = new Program(gl, fullscreenVert, preprocess('atrous.frag', ATROUS_SOURCES), ATROUS_SOURCES);
    this.resample = new Program(gl, fullscreenVert, resampleFrag);
    const vao = gl.createVertexArray();
    if (!vao) throw new Error('Failed to create VAO');
    this.vao = vao;

    this.sheenLUT = createTexture(gl, SHEEN_LUT_SIZE, SHEEN_LUT_SIZE,
      { internalFormat: gl.R16F, format: gl.RED, type: gl.FLOAT, filter: gl.LINEAR }, sheenAlbedoLUT());

    const t = this.trace;
    t.use();
    t.i1('uPrevColor', UNIT.prevColor);
    t.i1('uPrevAlbedo', UNIT.prevAlbedo);
    t.i1('uPrevNormal', UNIT.prevNormal);
    t.i1('uPrevHistory', UNIT.prevHistory);
    t.f1('uHistoryCap', HISTORY_CAP);
    t.i1('uTriGeometry', UNIT.triGeometry);
    t.i1('uTriAttributes', UNIT.triAttributes);
    t.i1('uBVH', UNIT.bvh);
    t.i1('uMaterials', UNIT.materials);
    t.i1('uColorMaps', UNIT.colorMaps);
    t.i1('uDataMaps', UNIT.dataMaps);
    t.i1('uEnvMap', UNIT.env);
    t.i1('uEnvAlias', UNIT.envAlias);
    t.i1('uSheenLUT', UNIT.sheen);
  }

  get currentScene(): Scene | null {
    return this.scene;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    // Exclude paused time from the elapsed counter.
    if (!paused) this.startTime = performance.now() - this.elapsedAtPause;
    else this.elapsedAtPause = performance.now() - this.startTime;
  }

  /** Uploads a scene; subsequent frames render it from scratch. `bvh` may be prebuilt (see buildBVHAsync). */
  loadScene(scene: Scene, bvh?: BVH): void {
    const gl = this.gl;
    for (const t of [...this.sceneTextures, ...this.textureArrays]) gl.deleteTexture(t);
    this.sceneTextures = [];
    this.textureArrays = [];

    const packed = packScene(scene, bvh);
    this.packed = packed;
    this.scene = scene;

    this.sceneTextures = [
      createDataTexture(gl, packed.triGeometry),
      createDataTexture(gl, packed.triAttributes),
      createDataTexture(gl, packed.bvhNodes),
      createDataTexture(gl, packed.materials),
    ];
    this.textureArrays = this.buildTextureArrays(scene, packed);

    const p = this.trace;
    p.use();
    p.i1('uTriCount', packed.triCount);
    p.f4v('uSpheres', packed.spheres);
    p.i1v('uSphereMaterial', packed.sphereMaterials);
    p.i1v('uSphereLight', packed.sphereLights);
    p.i1('uSphereCount', packed.sphereCount);
    p.f4v('uLights', packed.lights);
    p.i1('uLightCount', packed.lightCount);

    this.uploadGround(scene.ground);
    this.uploadLighting(scene);
    this.uploadCamera(scene.camera, false);
    this.reset();
  }

  /** Resamples every referenced image into one sRGB and one linear texture array. */
  private buildTextureArrays(scene: Scene, packed: PackedScene): WebGLTexture[] {
    const used = [...packed.colorLayers, ...packed.dataLayers];
    let size = 1;
    if (used.length > 0) {
      const largest = Math.max(...used.map((i) => Math.max(scene.textures[i]!.image.width, scene.textures[i]!.image.height)));
      size = Math.min(2048, this.caps.maxTextureSize, nextPow2(largest));
      while (size > 256 && used.length * size * size * 4 > TEXTURE_BUDGET_BYTES) size /= 2;
    }
    for (const layers of [packed.colorLayers, packed.dataLayers]) {
      if (layers.length > this.caps.maxArrayLayers) {
        throw new GLError(`scene uses ${layers.length} textures; this GPU allows ${this.caps.maxArrayLayers} per array`);
      }
    }
    this.textureSize = used.length > 0 ? size : 0;
    const images = (layers: number[]) => layers.map((i) => scene.textures[i]!.image);
    return [
      createTextureArray(this.gl, images(packed.colorLayers), size, true, this.resample, this.vao),
      createTextureArray(this.gl, images(packed.dataLayers), size, false, this.resample, this.vao),
    ];
  }

  /** Scene data lives on units 3+; units 0–2 are reserved for the accumulation buffer. */
  private bindSceneTextures(): void {
    const gl = this.gl;
    const bind = (unit: number, target: number, tex: WebGLTexture | undefined) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(target, tex ?? null);
    };
    bind(UNIT.triGeometry, gl.TEXTURE_2D, this.sceneTextures[0]);
    bind(UNIT.triAttributes, gl.TEXTURE_2D, this.sceneTextures[1]);
    bind(UNIT.bvh, gl.TEXTURE_2D, this.sceneTextures[2]);
    bind(UNIT.materials, gl.TEXTURE_2D, this.sceneTextures[3]);
    bind(UNIT.colorMaps, gl.TEXTURE_2D_ARRAY, this.textureArrays[0]);
    bind(UNIT.dataMaps, gl.TEXTURE_2D_ARRAY, this.textureArrays[1]);
    bind(UNIT.env, gl.TEXTURE_2D, this.envTextures[0]);
    bind(UNIT.envAlias, gl.TEXTURE_2D, this.envTextures[1]);
    bind(UNIT.sheen, gl.TEXTURE_2D, this.sheenLUT);
  }

  /** Re-uploads sun, sky and environment after the UI edits them. Rebuilds maps only when their inputs changed. */
  uploadLighting(scene: Scene): void {
    const { sun, sky, env } = scene;
    const p = this.trace;
    p.use();
    const dir = fromSpherical((sun.elevation * Math.PI) / 180, (sun.azimuth * Math.PI) / 180);
    const cosAngle = Math.cos((sun.angularRadius * Math.PI) / 180);
    const solidAngle = 2 * Math.PI * (1 - cosAngle);
    const enabled = !env.map && sun.intensity > 0 && sun.elevation > -sun.angularRadius;
    p.i1('uSunEnabled', enabled ? 1 : 0);
    p.f3('uSunDir', dir);
    p.f3('uSunRadiance', scale(sun.color, sun.intensity / solidAngle));
    p.f1('uSunCosAngle', cosAngle);
    p.f1('uSunPdf', 1 / solidAngle);

    if (env.map) {
      if (env.map !== this.envSource) this.uploadEnvironmentMap(env.map);
    } else {
      const key = JSON.stringify([sky, sun]);
      if (key !== this.envKey || this.envSource) {
        this.uploadEnvironmentMap(bakeSky(sky, sun));
        this.envSource = null;
        this.envKey = key;
      }
    }
    // The procedural sky is baked in world orientation at unit intensity.
    const rot = env.map ? (env.rotation * Math.PI) / 180 : 0;
    p.use();
    p.f2('uEnvRotation', Math.cos(rot), Math.sin(rot));
    p.f1('uEnvIntensity', env.map ? env.intensity : 1);
    p.i1('uEnvBackground', env.background ? 1 : 0);
    p.f3('uBackdrop', env.backdrop);
    this.reset();
  }

  private uploadEnvironmentMap(img: HDRImage): void {
    const gl = this.gl;
    if (img.width > this.caps.maxTextureSize) {
      throw new GLError(`environment is ${img.width} px wide; this GPU allows ${this.caps.maxTextureSize}`);
    }
    for (const t of this.envTextures) gl.deleteTexture(t);
    const sampler = buildEnvSampler(img);
    this.envTextures = [
      createTexture(gl, img.width, img.height, {
        internalFormat: gl.RGB32F,
        format: gl.RGB,
        type: gl.FLOAT,
        filter: this.caps.floatLinear ? gl.LINEAR : gl.NEAREST,
        wrapS: gl.REPEAT,
      }, img.data),
      createTexture(gl, sampler.gridWidth, sampler.gridHeight,
        { internalFormat: gl.RGBA32F, format: gl.RGBA, type: gl.FLOAT }, sampler.table),
    ];
    this.envSource = img;
    this.envKey = '';
    const p = this.trace;
    p.use();
    p.i2('uEnvGrid', sampler.gridWidth, sampler.gridHeight);
    p.i1('uEnvSampling', sampler.total > 0 ? 1 : 0);
  }

  uploadGround(ground: Ground): void {
    if (!this.packed) return;
    this.trace.use();
    this.trace.i1('uGroundMaterial', ground.enabled ? this.packed.groundMaterial : -1);
    this.trace.f1('uGroundHeight', ground.height);
    this.reset();
  }

  /** `moving` marks the change as interactive, which switches to the low-resolution preview. */
  uploadCamera(cam: Camera, moving = true): void {
    const { forward, right, up } = cameraBasis(cam);
    const tanHalfFov = Math.tan((cam.fov * Math.PI) / 360);
    this.camera = { position: [...cam.position], forward, right, up, tanHalfFov };
    const p = this.trace;
    p.use();
    p.f3('uCamPos', cam.position);
    p.f3('uCamRight', right);
    p.f3('uCamUp', up);
    p.f3('uCamForward', forward);
    p.f1('uTanHalfFov', tanHalfFov);
    p.f1('uAperture', cam.aperture);
    p.f1('uFocusDist', cam.focusDistance);
    if (moving) this.lastMotion = performance.now();
    this.invalidateView();
  }

  /** The view changed but the scene did not: reproject the history if allowed, else start over. */
  private invalidateView(): void {
    if (this.settings.temporal && this.history && this.frame > 0) {
      this.reprojectPending = true;
      this.frame = Math.min(this.frame, HISTORY_CAP);
      this.startTime = performance.now();
      this.denoisedFrame = -1;
    } else {
      this.reset();
    }
  }

  /** Call after any settings change that affects the integrator. */
  applySettings(): void {
    this.trace.use();
    this.trace.i1('uMaxBounces', this.settings.maxBounces);
    this.trace.f1('uClamp', this.settings.fireflyClamp);
    this.denoisedFrame = -1;
  }

  /** Resets accumulation; cheap, so callers can be liberal. */
  reset(): void {
    this.frame = 0;
    this.history = null;
    this.reprojectPending = false;
    this.startTime = performance.now();
    this.elapsedAtPause = 0;
    this.denoisedFrame = -1;
    this.sampleWindow = { time: performance.now(), samples: 0, paths: 0, sppRate: 0, pathRate: 0 };
    this.accum?.[0].clear();
    this.accum?.[1].clear();
  }

  /** Matches the internal buffers to the canvas' CSS size × DPR × resolution scale. */
  resize(): boolean {
    const gl = this.gl;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr * this.settings.resolutionScale));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr * this.settings.resolutionScale));
    if (w === this.width && h === this.height && this.accum) return false;
    this.width = w;
    this.height = h;
    this.renderWidth = w;
    this.renderHeight = h;
    this.canvas.width = w;
    this.canvas.height = h;
    this.accum?.forEach((t) => t.dispose());
    this.filtered?.forEach((t) => t.dispose());
    const guides = [gl.RGBA32F, gl.RGBA16F, gl.RGBA16F, gl.R32F];
    this.accum = [new RenderTarget(gl, w, h, guides), new RenderTarget(gl, w, h, guides)];
    this.filtered = [new RenderTarget(gl, w, h), new RenderTarget(gl, w, h)];
    this.reset();
    return true;
  }

  /** Converts a canvas-space click into a focus distance using the CPU BVH. */
  pickFocus(clientX: number, clientY: number): number | null {
    if (!this.scene || !this.packed) return null;
    const rect = this.canvas.getBoundingClientRect();
    const u = ((clientX - rect.left) / rect.width) * 2 - 1;
    const v = (1 - (clientY - rect.top) / rect.height) * 2 - 1;
    const cam = this.scene.camera;
    const { forward, right, up } = cameraBasis(cam);
    const tanHalf = Math.tan((cam.fov * Math.PI) / 360);
    const aspect = rect.width / rect.height;
    const dir = normalize([
      forward[0] + right[0] * u * aspect * tanHalf + up[0] * v * tanHalf,
      forward[1] + right[1] * u * aspect * tanHalf + up[1] * v * tanHalf,
      forward[2] + right[2] * u * aspect * tanHalf + up[2] * v * tanHalf,
    ]);
    const t = pickDistance(this.packed, { origin: cam.position, dir });
    if (t === null) return null;
    // Convert ray distance to distance along the view axis (the focal plane is planar).
    return t * (dir[0] * forward[0] + dir[1] * forward[1] + dir[2] * forward[2]);
  }

  /**
   * Picks the traced resolution. While the camera moves, a frame slower than
   * PREVIEW_SLOW_MS steps the resolution down (never below half) and a fast one
   * steps it back up; throttled frames from a hidden page are ignored.
   */
  private updatePreview(now: number, dt: number): void {
    const moving = now - this.lastMotion < MOTION_HOLD_MS;
    this.interactive = moving;
    if (moving && this.settings.adaptiveResolution && dt > 0 && dt < 250) {
      if (dt > PREVIEW_SLOW_MS) this.previewScale = Math.max(PREVIEW_MIN_SCALE, this.previewScale * 0.85);
      else if (dt < PREVIEW_FAST_MS) this.previewScale = Math.min(1, this.previewScale * 1.1);
    }
    const s = moving && this.settings.adaptiveResolution ? this.previewScale : 1;
    const rw = Math.max(1, Math.round(this.width * s));
    const rh = Math.max(1, Math.round(this.height * s));
    if (rw !== this.renderWidth || rh !== this.renderHeight) {
      this.renderWidth = rw;
      this.renderHeight = rh;
      this.invalidateView();
    }
  }

  /** Traces this frame's samples, filters, then presents. Returns true if any tracing was done. */
  render(): boolean {
    if (!this.accum || !this.filtered || !this.packed) return false;
    const gl = this.gl;
    const now = performance.now();
    const dt = this.lastFrameTime ? now - this.lastFrameTime : 0;
    this.lastFrameTime = now;
    this.updatePreview(now, dt);

    const { maxSamples, samplesPerFrame } = this.settings;
    const auto = samplesPerFrame <= 0;
    let spp = this.interactive ? 1 : auto ? this.autoSpp : samplesPerFrame;
    if (maxSamples > 0) spp = Math.min(spp, maxSamples - this.frame);
    const canTrace = !this.paused && spp > 0;
    const rw = this.renderWidth;
    const rh = this.renderHeight;

    if (canTrace) {
      if (auto && !this.interactive && dt > 0) {
        if (dt < 24) this.autoSpp = Math.min(32, this.autoSpp + 1);
        else if (dt > 40) this.autoSpp = Math.max(1, Math.floor(this.autoSpp * 0.75));
      }
      this.traceSamples(spp, rw, rh);
    }

    const latest = this.accum[0];
    const denoise = this.settings.denoise && this.frame > 0 && denoiseWeight(this.frame) > 0;
    if (denoise && this.denoisedFrame !== this.frame) {
      this.runDenoiser(latest, rw, rh);
      this.denoisedFrame = this.frame;
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    const d = this.display;
    d.use();
    gl.bindVertexArray(this.vao);
    this.bindUnits([latest.textures[0]!, latest.textures[1]!, (this.denoised ?? this.filtered[0]).texture]);
    d.i1('uColor', 0);
    d.i1('uAlbedo', 1);
    d.i1('uDenoised', 2);
    d.f1('uDenoiseWeight', denoise ? denoiseWeight(this.frame) : 0);
    d.f2('uRenderSize', rw, rh);
    d.f2('uViewSize', this.width, this.height);
    d.f1('uExposure', this.settings.exposure);
    d.i1('uTonemap', this.settings.tonemap === 'aces' ? 0 : this.settings.tonemap === 'reinhard' ? 1 : 2);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    const w = this.sampleWindow;
    if (now - w.time > 1000) {
      const secs = (now - w.time) / 1000;
      w.sppRate = w.samples / secs;
      w.pathRate = w.paths / secs / 1e6;
      w.time = now;
      w.samples = 0;
      w.paths = 0;
    }
    return canTrace;
  }

  private traceSamples(count: number, rw: number, rh: number): void {
    const gl = this.gl;
    this.trace.use();
    gl.bindVertexArray(this.vao);
    this.bindSceneTextures();
    this.trace.f2('uResolution', rw, rh);
    const units = [UNIT.prevColor, UNIT.prevAlbedo, UNIT.prevNormal, UNIT.prevHistory];
    for (let i = 0; i < count; i++) {
      const read: RenderTarget = this.accum![0];
      const write: RenderTarget = this.accum![1];
      write.bind(rw, rh);
      read.textures.forEach((tex, k) => {
        gl.activeTexture(gl.TEXTURE0 + units[k]!);
        gl.bindTexture(gl.TEXTURE_2D, tex);
      });
      const reproject = this.reprojectPending && this.history !== null;
      if (reproject) {
        const { camera: c, width, height } = this.history!;
        this.trace.f3('uPrevCamPos', c.position);
        this.trace.f3('uPrevCamRight', c.right);
        this.trace.f3('uPrevCamUp', c.up);
        this.trace.f3('uPrevCamForward', c.forward);
        this.trace.f1('uPrevTanHalfFov', c.tanHalfFov);
        this.trace.f2('uPrevResolution', width, height);
      }
      this.trace.i1('uReproject', reproject ? 1 : 0);
      this.trace.u1('uSeed', this.seed++);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      this.reprojectPending = false;
      this.history = { camera: this.camera, width: rw, height: rh };
      this.accum = [write, read];
      this.frame++;
      this.sampleWindow.samples++;
      this.sampleWindow.paths += rw * rh;
    }
  }

  /**
   * Traces `samples` full-resolution samples and waits for the GPU (a 1-pixel readback;
   * Chrome's gl.finish does not block),
   * so the timing is real even when the page is throttled. Also reports the
   * denoiser's cost for one run at this resolution.
   */
  benchmark(samples: number): { traceMs: number; mpathsPerSec: number; denoiseMs: number; width: number; height: number } {
    const gl = this.gl;
    if (!this.accum) throw new Error('benchmark before resize()');
    this.reset();
    this.renderWidth = this.width;
    this.renderHeight = this.height;
    const pixel = new Float32Array(4);
    const sync = (target: RenderTarget) => {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, target.framebuffer);
      gl.readBuffer(gl.COLOR_ATTACHMENT0);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, pixel);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    };
    this.traceSamples(1, this.width, this.height);
    sync(this.accum[0]);
    let t0 = performance.now();
    this.traceSamples(samples, this.width, this.height);
    sync(this.accum[0]);
    const traceMs = performance.now() - t0;
    t0 = performance.now();
    this.runDenoiser(this.accum[0], this.width, this.height);
    sync(this.denoised!);
    const denoiseMs = performance.now() - t0;
    this.denoisedFrame = this.frame;
    return {
      traceMs,
      mpathsPerSec: (samples * this.width * this.height) / (traceMs / 1000) / 1e6,
      denoiseMs,
      width: this.width,
      height: this.height,
    };
  }

  private bindUnits(textures: WebGLTexture[]): void {
    const gl = this.gl;
    textures.forEach((tex, unit) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
    });
  }

  /** Variance estimate, then up to five à-trous iterations ping-ponging between the filter targets. */
  private runDenoiser(source: RenderTarget, rw: number, rh: number): void {
    const gl = this.gl;
    const [a, b] = this.filtered!;
    gl.bindVertexArray(this.vao);

    const v = this.variance;
    v.use();
    a.bind(rw, rh);
    this.bindUnits([source.textures[0]!, source.textures[1]!, source.textures[2]!, source.textures[3]!]);
    v.i1('uColor', 0);
    v.i1('uAlbedo', 1);
    v.i1('uNormal', 2);
    v.i1('uHistory', 3);
    v.i2('uSize', rw, rh);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    const t = this.atrous;
    const cam = this.scene!.camera;
    const { forward, right, up, tanHalfFov } = this.camera;
    t.use();
    t.i1('uInput', 0);
    t.i1('uAlbedo', 1);
    t.i1('uNormal', 2);
    t.i2('uSize', rw, rh);
    t.f3('uCamPos', cam.position);
    t.f3('uCamRight', right);
    t.f3('uCamUp', up);
    t.f3('uCamForward', forward);
    t.f1('uTanHalfFov', tanHalfFov);
    t.f1('uSigmaL', 4);
    t.f1('uSigmaN', 64);
    t.f1('uSigmaP', 1.5);
    let read = a;
    let write = b;
    for (const step of ATROUS_STEPS.slice(0, atrousLevels(this.frame))) {
      write.bind(rw, rh);
      this.bindUnits([read.texture, source.textures[1]!, source.textures[2]!]);
      t.i1('uStep', step);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      [read, write] = [write, read];
    }
    this.denoised = read;
  }

  stats(): RenderStats {
    return {
      samples: this.frame,
      elapsedMs: this.paused ? this.elapsedAtPause : performance.now() - this.startTime,
      msamplesPerSec: this.sampleWindow.pathRate,
      sppPerSec: this.sampleWindow.sppRate,
      width: this.renderWidth,
      height: this.renderHeight,
      viewWidth: this.width,
      viewHeight: this.height,
      interactive: this.interactive,
      denoised: this.settings.denoise && this.frame > 0 && denoiseWeight(this.frame) > 0,
      triangles: this.packed?.triCount ?? 0,
      bvhNodes: this.packed?.bvhNodeCount ?? 0,
      textures: (this.packed?.colorLayers.length ?? 0) + (this.packed?.dataLayers.length ?? 0),
      textureSize: this.textureSize,
      renderer: this.caps.renderer,
    };
  }

  /** Encodes the current canvas (denoised and tone-mapped, as displayed) as a PNG blob. */
  screenshot(): Promise<Blob> {
    this.render();
    return new Promise((resolve, reject) => {
      this.canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png');
    });
  }

  dispose(): void {
    this.accum?.forEach((t) => t.dispose());
    this.filtered?.forEach((t) => t.dispose());
    for (const t of [...this.sceneTextures, ...this.textureArrays, ...this.envTextures, this.sheenLUT]) this.gl.deleteTexture(t);
    for (const p of [this.trace, this.display, this.variance, this.atrous, this.resample]) p.dispose();
    this.gl.deleteVertexArray(this.vao);
  }
}
