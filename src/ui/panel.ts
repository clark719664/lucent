import type { Renderer, RenderStats, Tonemap } from '../renderer';
import { PRESETS } from '../scene/presets';
import type { Scene } from '../scene/scene';
import { formatCount, formatDuration, h } from './dom';

export interface PanelEvents {
  onSelectScene: (index: number) => void;
  onLightingChange: () => void;
  onCameraChange: () => void;
  onSettingsChange: () => void;
  onResolutionChange: () => void;
  onReset: () => void;
  onScreenshot: () => void;
}

interface SliderSpec {
  label: string;
  min: number;
  max: number;
  step: number;
  get: () => number;
  set: (v: number) => void;
  format?: (v: number) => string;
  onInput: () => void;
}

/** Builds the control panel. Pure DOM, no framework. */
export class Panel {
  readonly root: HTMLElement;
  private readonly statsEl: HTMLElement;
  private readonly sliders: { spec: SliderSpec; input: HTMLInputElement; value: HTMLElement }[] = [];
  private readonly sceneDesc: HTMLElement;
  private readonly pauseBtn: HTMLButtonElement;
  private scene: Scene;

  constructor(
    private readonly renderer: Renderer,
    initialScene: number,
    events: PanelEvents,
  ) {
    this.scene = renderer.currentScene ?? PRESETS[initialScene]!();
    this.statsEl = h('div', { class: 'stats' });
    this.sceneDesc = h('p', { class: 'scene-desc' }, this.scene.description);
    this.pauseBtn = h('button', { class: 'btn', onClick: () => this.togglePause() }, 'Pause');

    const sceneSelect = h('select', {
      class: 'select',
      onChange: (e: Event) => events.onSelectScene(Number((e.target as HTMLSelectElement).value)),
    }, ...PRESETS.map((p, i) => h('option', { value: i, selected: i === initialScene }, p().name)));

    const tonemapSelect = h('select', {
      class: 'select',
      onChange: (e: Event) => {
        renderer.settings.tonemap = (e.target as HTMLSelectElement).value as Tonemap;
      },
    }, ...(['aces', 'reinhard', 'none'] as const).map((t) =>
      h('option', { value: t, selected: renderer.settings.tonemap === t }, t === 'aces' ? 'ACES filmic' : t === 'reinhard' ? 'Reinhard' : 'Clip'),
    ));

    const s = renderer.settings;
    const cam = () => this.scene.camera;
    const sun = () => this.scene.sun;
    const sky = () => this.scene.sky;

    this.root = h('aside', { class: 'panel' },
      h('header', { class: 'panel-header' },
        h('div', { class: 'brand' },
          h('span', { class: 'brand-dot' }),
          h('h1', {}, 'Lucent'),
        ),
        h('p', { class: 'tagline' }, 'Progressive GPU path tracer · WebGL2'),
      ),

      this.section('Scene',
        sceneSelect,
        this.sceneDesc,
        h('div', { class: 'row' },
          this.pauseBtn,
          h('button', { class: 'btn', onClick: () => events.onReset() }, 'Restart'),
          h('button', { class: 'btn btn-accent', onClick: () => events.onScreenshot() }, 'Save PNG'),
        ),
      ),

      this.section('Camera',
        this.slider({ label: 'Field of view', min: 10, max: 110, step: 1, get: () => cam().fov, set: (v) => (cam().fov = v), format: (v) => `${v}°`, onInput: events.onCameraChange }),
        this.slider({ label: 'Aperture', min: 0, max: 0.25, step: 0.001, get: () => cam().aperture, set: (v) => (cam().aperture = v), format: (v) => v.toFixed(3), onInput: events.onCameraChange }),
        this.slider({ label: 'Focus distance', min: 0.2, max: 20, step: 0.01, get: () => cam().focusDistance, set: (v) => (cam().focusDistance = v), format: (v) => v.toFixed(2), onInput: events.onCameraChange }),
        h('p', { class: 'hint' }, 'Click anywhere in the image to focus there.'),
      ),

      this.section('Lighting',
        this.slider({ label: 'Sun elevation', min: -5, max: 90, step: 0.5, get: () => sun().elevation, set: (v) => (sun().elevation = v), format: (v) => `${v}°`, onInput: events.onLightingChange }),
        this.slider({ label: 'Sun azimuth', min: 0, max: 360, step: 1, get: () => sun().azimuth, set: (v) => (sun().azimuth = v), format: (v) => `${v}°`, onInput: events.onLightingChange }),
        this.slider({ label: 'Sun intensity', min: 0, max: 60, step: 0.5, get: () => sun().intensity, set: (v) => (sun().intensity = v), onInput: events.onLightingChange }),
        this.slider({ label: 'Sun size', min: 0.25, max: 8, step: 0.05, get: () => sun().angularRadius, set: (v) => (sun().angularRadius = v), format: (v) => `${v.toFixed(2)}°`, onInput: events.onLightingChange }),
        this.slider({ label: 'Sky intensity', min: 0, max: 4, step: 0.05, get: () => sky().intensity, set: (v) => (sky().intensity = v), format: (v) => v.toFixed(2), onInput: events.onLightingChange }),
      ),

      this.section('Integrator',
        this.slider({ label: 'Max bounces', min: 1, max: 24, step: 1, get: () => s.maxBounces, set: (v) => (s.maxBounces = v), onInput: events.onSettingsChange }),
        this.slider({ label: 'Firefly clamp', min: 0, max: 50, step: 0.5, get: () => s.fireflyClamp, set: (v) => (s.fireflyClamp = v), format: (v) => (v === 0 ? 'off' : v.toFixed(1)), onInput: events.onSettingsChange }),
        this.slider({ label: 'Samples / frame', min: 1, max: 8, step: 1, get: () => s.samplesPerFrame, set: (v) => (s.samplesPerFrame = v), onInput: () => undefined }),
        this.slider({ label: 'Resolution', min: 0.25, max: 2, step: 0.25, get: () => s.resolutionScale, set: (v) => (s.resolutionScale = v), format: (v) => `${Math.round(v * 100)}%`, onInput: events.onResolutionChange }),
      ),

      this.section('Display',
        this.slider({ label: 'Exposure', min: 0.05, max: 6, step: 0.05, get: () => s.exposure, set: (v) => (s.exposure = v), format: (v) => `${v.toFixed(2)}×`, onInput: () => undefined }),
        h('label', { class: 'field' }, h('span', {}, 'Tone mapping'), tonemapSelect),
      ),

      this.section('Stats', this.statsEl),

      h('footer', { class: 'panel-footer' },
        h('kbd', {}, 'Space'), ' pause · ', h('kbd', {}, 'R'), ' restart · ', h('kbd', {}, 'S'), ' save · ', h('kbd', {}, 'H'), ' hide panel',
      ),
    );
  }

  /** Points the sliders at a new scene object and refreshes their values. */
  setScene(scene: Scene): void {
    this.scene = scene;
    this.sceneDesc.textContent = scene.description;
    this.refresh();
  }

  refresh(): void {
    for (const { spec, input, value } of this.sliders) {
      const v = spec.get();
      input.value = String(v);
      value.textContent = spec.format ? spec.format(v) : String(v);
    }
  }

  togglePause(): void {
    this.renderer.setPaused(!this.renderer.isPaused);
    this.syncPauseButton();
  }

  syncPauseButton(): void {
    this.pauseBtn.textContent = this.renderer.isPaused ? 'Resume' : 'Pause';
  }

  updateStats(st: RenderStats): void {
    const rows: [string, string][] = [
      ['Samples / pixel', formatCount(st.samples)],
      ['Elapsed', formatDuration(st.elapsedMs)],
      ['Throughput', `${st.msamplesPerSec.toFixed(1)} Msamples/s`],
      ['Resolution', `${st.width} × ${st.height}`],
      ['Triangles', formatCount(st.triangles)],
      ['BVH nodes', formatCount(st.bvhNodes)],
      ['GPU', st.renderer],
    ];
    this.statsEl.replaceChildren(
      ...rows.map(([k, v]) => h('div', { class: 'stat' }, h('span', { class: 'stat-k' }, k), h('span', { class: 'stat-v', title: v }, v))),
    );
  }

  private section(title: string, ...children: (Node | string)[]): HTMLElement {
    const body = h('div', { class: 'section-body' }, ...children);
    const el = h('details', { class: 'section', open: true },
      h('summary', {}, title),
      body,
    );
    return el;
  }

  private slider(spec: SliderSpec): HTMLElement {
    const value = h('span', { class: 'field-value' });
    const input = h('input', {
      type: 'range',
      min: spec.min,
      max: spec.max,
      step: spec.step,
      value: spec.get(),
      onInput: (e: Event) => {
        const v = Number((e.target as HTMLInputElement).value);
        spec.set(v);
        value.textContent = spec.format ? spec.format(v) : String(v);
        spec.onInput();
      },
    });
    this.sliders.push({ spec, input, value });
    value.textContent = spec.format ? spec.format(spec.get()) : String(spec.get());
    return h('label', { class: 'field' },
      h('span', {}, spec.label, value),
      input,
    );
  }
}
