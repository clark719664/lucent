import { createContext, createDataTexture, Program, RenderTarget, type GLCapabilities } from './gl/context';
import { preprocess, type ShaderSources } from './gl/preprocess';
import { cross, fromSpherical, normalize, scale, sub, type Vec3 } from './math/vec3';
import { packScene, pickDistance, type Camera, type PackedScene, type Scene, type Sky, type Sun } from './scene/scene';
import bsdfGlsl from './shaders/bsdf.glsl?raw';
import commonGlsl from './shaders/common.glsl?raw';
import displayFrag from './shaders/display.frag?raw';
import fullscreenVert from './shaders/fullscreen.vert?raw';
import lightsGlsl from './shaders/lights.glsl?raw';
import sceneGlsl from './shaders/scene.glsl?raw';
import traceFrag from './shaders/trace.frag?raw';

const SOURCES: ShaderSources = {
  'trace.frag': traceFrag,
  'common.glsl': commonGlsl,
  'scene.glsl': sceneGlsl,
  'lights.glsl': lightsGlsl,
  'bsdf.glsl': bsdfGlsl,
};

export type Tonemap = 'aces' | 'reinhard' | 'none';

export interface RenderSettings {
  maxBounces: number;
  exposure: number;
  tonemap: Tonemap;
  /** Internal resolution as a fraction of the canvas' device-pixel size. */
  resolutionScale: number;
  /** Samples traced per animation frame; higher is faster to converge but less responsive. */
  samplesPerFrame: number;
  /** Luminance cap for indirect contributions; 0 disables. */
  fireflyClamp: number;
  /** Stop accumulating after this many samples; 0 means never. */
  maxSamples: number;
}

export const DEFAULT_SETTINGS: RenderSettings = {
  maxBounces: 6,
  exposure: 1,
  tonemap: 'aces',
  resolutionScale: 1,
  samplesPerFrame: 1,
  fireflyClamp: 8,
  maxSamples: 0,
};

export interface RenderStats {
  samples: number;
  elapsedMs: number;
  /** Million primary samples per second over the last second. */
  msamplesPerSec: number;
  width: number;
  height: number;
  triangles: number;
  bvhNodes: number;
  renderer: string;
}

/**
 * Progressive GPU path tracer.
 *
 * Each frame traces one (or more) paths per pixel into a ping-ponged RGBA32F
 * accumulation buffer, then a display pass tone-maps the running average onto
 * the canvas. Any change to the camera, scene or lighting resets the average.
 */
export class Renderer {
  readonly caps: GLCapabilities;
  readonly settings: RenderSettings = { ...DEFAULT_SETTINGS };

  private readonly gl: WebGL2RenderingContext;
  private readonly trace: Program;
  private readonly display: Program;
  private readonly vao: WebGLVertexArrayObject;

  private targets: [RenderTarget, RenderTarget] | null = null;
  private textures: WebGLTexture[] = [];
  private packed: PackedScene | null = null;
  private scene: Scene | null = null;

  private frame = 0;
  private startTime = 0;
  private sampleWindow = { time: 0, samples: 0, rate: 0 };
  private width = 1;
  private height = 1;
  private paused = false;
  private elapsedAtPause = 0;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.caps = createContext(canvas);
    this.gl = this.caps.gl;
    const gl = this.gl;
    this.trace = new Program(gl, fullscreenVert, preprocess('trace.frag', SOURCES), SOURCES);
    this.display = new Program(gl, fullscreenVert, displayFrag);
    const vao = gl.createVertexArray();
    if (!vao) throw new Error('Failed to create VAO');
    this.vao = vao;
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

  /** Uploads a scene; subsequent frames render it from scratch. */
  loadScene(scene: Scene): void {
    const gl = this.gl;
    for (const t of this.textures) gl.deleteTexture(t);
    this.textures = [];

    const packed = packScene(scene);
    this.packed = packed;
    this.scene = scene;

    const triTex = createDataTexture(gl, packed.triangles);
    const bvhTex = createDataTexture(gl, packed.bvhNodes);
    const matTex = createDataTexture(gl, packed.materials);
    this.textures = [triTex, bvhTex, matTex];

    this.trace.use();
    this.bindSceneTextures();
    this.trace.i1('uTriangles', 1);
    this.trace.i1('uBVH', 2);
    this.trace.i1('uMaterials', 3);
    this.trace.i1('uPrevious', 0);
    this.trace.i1('uTriCount', packed.triCount);

    this.trace.f4v('uSpheres', packed.spheres);
    this.trace.i1v('uSphereMaterial', packed.sphereMaterials);
    this.trace.i1v('uSphereLight', packed.sphereLights);
    this.trace.i1('uSphereCount', packed.sphereCount);
    this.trace.f4v('uLights', packed.lights);
    this.trace.i1('uLightCount', packed.lightCount);

    this.uploadLighting(scene.sun, scene.sky);
    this.uploadCamera(scene.camera);
    this.reset();
  }

  /** Scene data lives on units 1–3; unit 0 is reserved for the accumulation buffer. */
  private bindSceneTextures(): void {
    const gl = this.gl;
    this.textures.forEach((tex, i) => {
      gl.activeTexture(gl.TEXTURE1 + i);
      gl.bindTexture(gl.TEXTURE_2D, tex);
    });
  }

  /** Re-uploads sun and sky after the UI edits them. */
  uploadLighting(sun: Sun, sky: Sky): void {
    const p = this.trace;
    p.use();
    const dir = fromSpherical((sun.elevation * Math.PI) / 180, (sun.azimuth * Math.PI) / 180);
    const cosAngle = Math.cos((sun.angularRadius * Math.PI) / 180);
    const solidAngle = 2 * Math.PI * (1 - cosAngle);
    const enabled = sun.intensity > 0 && sun.elevation > -sun.angularRadius;
    p.i1('uSunEnabled', enabled ? 1 : 0);
    p.f3('uSunDir', dir);
    p.f3('uSunColor', sun.color);
    p.f3('uSunRadiance', scale(sun.color, sun.intensity / solidAngle));
    p.f1('uSunCosAngle', cosAngle);
    p.f1('uSunPdf', 1 / solidAngle);
    p.i1('uSkyEnabled', sky.enabled ? 1 : 0);
    p.f3('uSkyZenith', sky.zenith);
    p.f3('uSkyHorizon', sky.horizon);
    p.f3('uSkyGround', sky.ground);
    p.f1('uSkyIntensity', sky.intensity);
    this.reset();
  }

  uploadCamera(cam: Camera): void {
    const p = this.trace;
    p.use();
    const forward = normalize(sub(cam.target, cam.position));
    const worldUp: Vec3 = Math.abs(forward[1]) > 0.999 ? [0, 0, 1] : [0, 1, 0];
    const right = normalize(cross(forward, worldUp));
    const up = cross(right, forward);
    p.f3('uCamPos', cam.position);
    p.f3('uCamRight', right);
    p.f3('uCamUp', up);
    p.f3('uCamForward', forward);
    p.f1('uTanHalfFov', Math.tan((cam.fov * Math.PI) / 360));
    p.f1('uAperture', cam.aperture);
    p.f1('uFocusDist', cam.focusDistance);
    this.reset();
  }

  /** Call after any settings change that affects the integrator. */
  applySettings(): void {
    this.trace.use();
    this.trace.i1('uMaxBounces', this.settings.maxBounces);
    this.trace.f1('uClamp', this.settings.fireflyClamp);
  }

  /** Resets accumulation; cheap, so callers can be liberal. */
  reset(): void {
    this.frame = 0;
    this.startTime = performance.now();
    this.elapsedAtPause = 0;
    this.sampleWindow = { time: performance.now(), samples: 0, rate: 0 };
    this.targets?.[0].clear();
    this.targets?.[1].clear();
  }

  /** Matches the internal buffers to the canvas' CSS size × DPR × resolution scale. */
  resize(): boolean {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr * this.settings.resolutionScale));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr * this.settings.resolutionScale));
    if (w === this.width && h === this.height && this.targets) return false;
    this.width = w;
    this.height = h;
    this.canvas.width = w;
    this.canvas.height = h;
    this.targets?.forEach((t) => t.dispose());
    this.targets = [new RenderTarget(this.gl, w, h), new RenderTarget(this.gl, w, h)];
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
    const forward = normalize(sub(cam.target, cam.position));
    const worldUp: Vec3 = Math.abs(forward[1]) > 0.999 ? [0, 0, 1] : [0, 1, 0];
    const right = normalize(cross(forward, worldUp));
    const up = cross(right, forward);
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

  /** Traces up to `samplesPerFrame` samples then presents. Returns true if any work was done. */
  render(): boolean {
    if (!this.targets || !this.packed) return false;
    const gl = this.gl;
    const { maxSamples, samplesPerFrame } = this.settings;
    const canTrace = !this.paused && (maxSamples === 0 || this.frame < maxSamples);

    if (canTrace) {
      this.trace.use();
      gl.bindVertexArray(this.vao);
      this.bindSceneTextures();
      this.trace.f2('uResolution', this.width, this.height);
      for (let i = 0; i < samplesPerFrame; i++) {
        const read: RenderTarget = this.targets[0];
        const write: RenderTarget = this.targets[1];
        write.bind();
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, read.texture);
        this.trace.u1('uFrame', this.frame);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        this.targets = [write, read];
        this.frame++;
        this.sampleWindow.samples++;
      }
    }

    // Present the latest average.
    const latest = this.targets[0];
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    this.display.use();
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, latest.texture);
    this.display.i1('uImage', 0);
    this.display.f1('uExposure', this.settings.exposure);
    this.display.i1('uTonemap', this.settings.tonemap === 'aces' ? 0 : this.settings.tonemap === 'reinhard' ? 1 : 2);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    const now = performance.now();
    if (now - this.sampleWindow.time > 1000) {
      const secs = (now - this.sampleWindow.time) / 1000;
      this.sampleWindow.rate = (this.sampleWindow.samples * this.width * this.height) / secs / 1e6;
      this.sampleWindow.time = now;
      this.sampleWindow.samples = 0;
    }
    return canTrace;
  }

  stats(): RenderStats {
    return {
      samples: this.frame,
      elapsedMs: this.paused ? this.elapsedAtPause : performance.now() - this.startTime,
      msamplesPerSec: this.sampleWindow.rate,
      width: this.width,
      height: this.height,
      triangles: this.packed?.triCount ?? 0,
      bvhNodes: this.packed?.bvhNodeCount ?? 0,
      renderer: this.caps.renderer,
    };
  }

  /** Encodes the current canvas as a PNG blob. */
  screenshot(): Promise<Blob> {
    this.render();
    return new Promise((resolve, reject) => {
      this.canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png');
    });
  }

  dispose(): void {
    this.targets?.forEach((t) => t.dispose());
    for (const t of this.textures) this.gl.deleteTexture(t);
    this.trace.dispose();
    this.display.dispose();
    this.gl.deleteVertexArray(this.vao);
  }
}
