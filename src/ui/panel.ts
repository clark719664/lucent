import { HDRIS } from '../gallery';
import { matchPreset, pickPerformance, PRESET_LABELS, type PresetName } from '../perf';
import type { Renderer, RenderStats, Tonemap } from '../renderer';
import type { Scene } from '../scene/scene';
import { formatCount, formatDuration, h } from './dom';

export interface PanelEvents {
  onOpenGallery: () => void;
  onOpenFile: () => void;
  /** `sky`, a Poly Haven id from `HDRIS`, or `custom` for the last dropped .hdr. */
  onSelectEnvironment: (id: string) => void;
  onLightingChange: () => void;
  onGroundChange: () => void;
  onCameraChange: () => void;
  onSettingsChange: () => void;
  onResolutionChange: () => void;
  onReset: () => void;
  onScreenshot: () => void;
  onPresetChange: (preset: PresetName) => void;
  onScan: () => void;
  /** Any performance knob moved; settings are already updated. */
  onPerformanceChange: () => void;
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

interface ToggleSpec {
  label: string;
  get: () => boolean;
  set: (v: boolean) => void;
  onChange: () => void;
}

/** "ANGLE (AMD, AMD Radeon RX 7600 (0x…) Direct3D11 …)" → "AMD Radeon RX 7600". */
export const gpuName = (renderer: string): string =>
  /^ANGLE \([^,]+, ([^,(]+)/.exec(renderer)?.[1]?.trim() ?? renderer;

/** Builds the control panel. Pure DOM, no framework. */
export class Panel {
  readonly root: HTMLElement;
  private readonly statsEl: HTMLElement;
  private readonly sliders: { spec: SliderSpec; input: HTMLInputElement; value: HTMLElement }[] = [];
  private readonly toggles: { spec: ToggleSpec; input: HTMLInputElement }[] = [];
  private readonly choices: { get: () => string; select: HTMLSelectElement }[] = [];
  private readonly presetSelect: HTMLSelectElement;
  private readonly scanNote: HTMLElement;
  private readonly sceneName: HTMLElement;
  private readonly sceneDesc: HTMLElement;
  private readonly pauseBtn: HTMLButtonElement;
  private readonly envSelect: HTMLSelectElement;
  private readonly customOption: HTMLOptionElement;
  private readonly sunSection: HTMLElement;
  private readonly hdriFields: HTMLElement;
  private scene: Scene;

  constructor(
    private readonly renderer: Renderer,
    scene: Scene,
    events: PanelEvents,
  ) {
    this.scene = scene;
    this.statsEl = h('div', { class: 'stats' });
    this.sceneName = h('h2', { class: 'scene-name' }, scene.name);
    this.sceneDesc = h('p', { class: 'scene-desc' }, scene.description);
    this.pauseBtn = h('button', { class: 'btn', onClick: () => this.togglePause() }, 'Pause');

    this.customOption = h('option', { value: 'custom', hidden: true }, 'Dropped HDRI');
    this.envSelect = h('select', {
      class: 'select',
      'aria-label': 'Environment',
      onChange: (e: Event) => events.onSelectEnvironment((e.target as HTMLSelectElement).value),
    },
      h('option', { value: 'sky' }, 'Procedural sky + sun'),
      ...HDRIS.map((e) => h('option', { value: e.id }, `${e.name} (HDRI)`)),
      this.customOption,
    );

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
    const env = () => this.scene.env;

    this.hdriFields = h('div', { class: 'section-body' },
      this.slider({ label: 'Rotation', min: 0, max: 360, step: 1, get: () => env().rotation, set: (v) => (env().rotation = v), format: (v) => `${v}°`, onInput: events.onLightingChange }),
      this.slider({ label: 'Intensity', min: 0, max: 4, step: 0.05, get: () => env().intensity, set: (v) => (env().intensity = v), format: (v) => `${v.toFixed(2)}×`, onInput: events.onLightingChange }),
    );

    this.sunSection = this.section('Sun & sky',
      this.slider({ label: 'Sun elevation', min: -5, max: 90, step: 0.5, get: () => sun().elevation, set: (v) => (sun().elevation = v), format: (v) => `${v}°`, onInput: events.onLightingChange }),
      this.slider({ label: 'Sun azimuth', min: 0, max: 360, step: 1, get: () => sun().azimuth, set: (v) => (sun().azimuth = v), format: (v) => `${v}°`, onInput: events.onLightingChange }),
      this.slider({ label: 'Sun intensity', min: 0, max: 60, step: 0.5, get: () => sun().intensity, set: (v) => (sun().intensity = v), onInput: events.onLightingChange }),
      this.slider({ label: 'Sun size', min: 0.25, max: 8, step: 0.05, get: () => sun().angularRadius, set: (v) => (sun().angularRadius = v), format: (v) => `${v.toFixed(2)}°`, onInput: events.onLightingChange }),
      this.slider({ label: 'Sky intensity', min: 0, max: 4, step: 0.05, get: () => sky().intensity, set: (v) => (sky().intensity = v), format: (v) => v.toFixed(2), onInput: events.onLightingChange }),
    );

    this.presetSelect = h('select', {
      class: 'select',
      'aria-label': 'Performance preset',
      onChange: (e: Event) => {
        const v = (e.target as HTMLSelectElement).value;
        if (v !== 'custom') events.onPresetChange(v as PresetName);
      },
    },
      ...(Object.keys(PRESET_LABELS) as PresetName[]).map((k) => h('option', { value: k }, PRESET_LABELS[k])),
      h('option', { value: 'custom' }, 'Custom'),
    );
    this.scanNote = h('p', { class: 'hint' });
    const perfChanged = () => {
      this.syncPreset();
      events.onPerformanceChange();
    };

    this.root = h('aside', { class: 'panel' },
      h('header', { class: 'panel-header' },
        h('div', { class: 'brand' },
          h('span', { class: 'brand-dot' }),
          h('h1', {}, 'Lucent'),
        ),
        h('p', { class: 'tagline' }, 'Progressive GPU path tracer · WebGL2'),
      ),

      this.section('Scene',
        h('div', { class: 'row' },
          h('button', { class: 'btn btn-accent', title: 'Built-in scenes and glTF sample models (G)', onClick: () => events.onOpenGallery() }, 'Gallery'),
          h('button', { class: 'btn', title: 'Open a .glb, .gltf (with its files) or .hdr', onClick: () => events.onOpenFile() }, 'Open file…'),
        ),
        this.sceneName,
        this.sceneDesc,
        h('p', { class: 'hint' }, 'Or drop a .glb / .gltf / .hdr anywhere.'),
        h('div', { class: 'row' },
          this.pauseBtn,
          h('button', { class: 'btn', onClick: () => events.onReset() }, 'Restart'),
          h('button', { class: 'btn', onClick: () => events.onScreenshot() }, 'Save PNG'),
        ),
      ),

      this.section('Performance',
        h('div', { class: 'row' },
          this.presetSelect,
          h('button', { class: 'btn btn-fit', title: 'Measure this GPU and apply the recommended settings', onClick: () => events.onScan() }, 'Scan system'),
        ),
        this.scanNote,
        this.slider({ label: 'GPU budget', min: 10, max: 100, step: 5, get: () => Math.round(s.gpuBudget * 100), set: (v) => (s.gpuBudget = v / 100), format: (v) => `${v}%`, onInput: perfChanged }),
        this.choice('Frame rate', [['30', '30 fps'], ['60', '60 fps'], ['0', 'Display rate']], () => String(s.fpsCap), (v) => (s.fpsCap = Number(v)), perfChanged),
        this.choice('Stop at', [['512', '512 spp'], ['1024', '1,024 spp'], ['2048', '2,048 spp'], ['4096', '4,096 spp'], ['8192', '8,192 spp'], ['0', 'Never']],
          () => String(s.maxSamples), (v) => (s.maxSamples = Number(v)), perfChanged),
        this.slider({ label: 'Resolution', min: 0.25, max: 2, step: 0.25, get: () => s.resolutionScale, set: (v) => (s.resolutionScale = v), format: (v) => `${Math.round(v * 100)}%`, onInput: () => { events.onResolutionChange(); perfChanged(); } }),
        this.slider({ label: 'Max bounces', min: 1, max: 24, step: 1, get: () => s.maxBounces, set: (v) => (s.maxBounces = v), onInput: () => { events.onSettingsChange(); perfChanged(); } }),
        this.toggle({ label: 'Pause when the window loses focus', get: () => s.pauseWhenUnfocused, set: (v) => (s.pauseWhenUnfocused = v), onChange: perfChanged }),
      ),

      this.section('Environment',
        this.envSelect,
        this.hdriFields,
        this.toggle({ label: 'Show background', get: () => env().background, set: (v) => (env().background = v), onChange: events.onLightingChange }),
        this.toggle({ label: 'Ground plane', get: () => this.scene.ground.enabled, set: (v) => (this.scene.ground.enabled = v), onChange: events.onGroundChange }),
      ),

      this.sunSection,

      this.section('Camera',
        this.slider({ label: 'Field of view', min: 10, max: 110, step: 1, get: () => cam().fov, set: (v) => (cam().fov = v), format: (v) => `${v}°`, onInput: events.onCameraChange }),
        this.slider({ label: 'Aperture', min: 0, max: 0.25, step: 0.001, get: () => cam().aperture, set: (v) => (cam().aperture = v), format: (v) => v.toFixed(3), onInput: events.onCameraChange }),
        this.slider({ label: 'Focus distance', min: 0.2, max: 20, step: 0.01, get: () => cam().focusDistance, set: (v) => (cam().focusDistance = v), format: (v) => v.toFixed(2), onInput: events.onCameraChange }),
        h('p', { class: 'hint' }, 'Click anywhere in the image to focus there.'),
      ),

      this.section('Integrator',
        this.toggle({ label: 'Denoiser', get: () => s.denoise, set: (v) => (s.denoise = v), onChange: () => undefined }),
        this.toggle({ label: 'Reuse samples while moving', get: () => s.temporal, set: (v) => (s.temporal = v), onChange: () => undefined }),
        this.toggle({ label: 'Lower resolution when slow', get: () => s.adaptiveResolution, set: (v) => (s.adaptiveResolution = v), onChange: () => undefined }),
        this.slider({ label: 'Firefly clamp', min: 0, max: 50, step: 0.5, get: () => s.fireflyClamp, set: (v) => (s.fireflyClamp = v), format: (v) => (v === 0 ? 'off' : v.toFixed(1)), onInput: events.onSettingsChange }),
      ),

      this.section('Display',
        this.slider({ label: 'Exposure', min: 0.05, max: 6, step: 0.05, get: () => s.exposure, set: (v) => (s.exposure = v), format: (v) => `${v.toFixed(2)}×`, onInput: () => undefined }),
        h('label', { class: 'field' }, h('span', {}, 'Tone mapping'), tonemapSelect),
      ),

      this.section('Stats', this.statsEl),

      h('footer', { class: 'panel-footer' },
        h('kbd', {}, 'Space'), ' pause · ', h('kbd', {}, 'R'), ' restart · ', h('kbd', {}, 'S'), ' save · ',
        h('kbd', {}, 'G'), ' gallery · ', h('kbd', {}, 'D'), ' denoiser · ', h('kbd', {}, 'H'), ' hide',
      ),
    );
    this.setScene(scene);
  }

  /** Points the controls at a new scene object and refreshes their values. */
  setScene(scene: Scene): void {
    this.scene = scene;
    this.sceneName.textContent = scene.name;
    this.sceneDesc.textContent = scene.description;
    this.refresh();
  }

  /** Selects the environment entry; `customName` labels a dropped file. */
  setEnvironment(id: string, customName?: string): void {
    if (customName) {
      this.customOption.textContent = `${customName} (dropped)`;
      this.customOption.hidden = false;
    }
    this.envSelect.value = id;
    this.refresh();
  }

  refresh(): void {
    for (const { spec, input, value } of this.sliders) {
      const v = spec.get();
      input.value = String(v);
      value.textContent = spec.format ? spec.format(v) : String(v);
    }
    for (const { spec, input } of this.toggles) input.checked = spec.get();
    for (const { get, select } of this.choices) select.value = get();
    this.syncPreset();
    const hdri = this.scene.env.map !== null;
    this.sunSection.hidden = hdri;
    this.hdriFields.hidden = !hdri;
    if (!hdri) this.envSelect.value = 'sky';
  }

  togglePause(): void {
    this.renderer.setPaused(!this.renderer.isPaused);
    this.syncPauseButton();
  }

  syncPauseButton(): void {
    this.pauseBtn.textContent = this.renderer.isPaused ? 'Resume' : 'Pause';
  }

  updateStats(st: RenderStats): void {
    const res = st.interactive
      ? `${st.width} × ${st.height} of ${st.viewWidth} × ${st.viewHeight}`
      : `${st.width} × ${st.height}`;
    const rows: [string, string][] = [
      ['Samples / pixel', formatCount(st.samples)],
      ['Elapsed', formatDuration(st.elapsedMs)],
      ['Throughput', `${st.msamplesPerSec.toFixed(1)} Mpaths/s`],
      ['GPU load', st.gpuLoad === null ? 'measuring' : `${Math.round(st.gpuLoad * 100)}% ${st.gpuLoadMeasured ? '(timer query)' : '(estimated)'}`],
      ['Cost / sample', st.msPerSample > 0 ? `${st.msPerSample.toFixed(1)} ms` : 'measuring'],
      ['Resolution', res],
      ['Triangles', formatCount(st.triangles)],
      ['BVH nodes', formatCount(st.bvhNodes)],
      ['Textures', st.textures > 0 ? `${st.textures} @ ${st.textureSize}²` : 'none'],
      ['GPU', gpuName(st.renderer)],
    ];
    this.statsEl.replaceChildren(
      ...rows.map(([k, v]) => h('div', { class: 'stat' }, h('span', { class: 'stat-k' }, k), h('span', { class: 'stat-v', title: v }, v))),
    );
  }

  private section(title: string, ...children: (Node | string)[]): HTMLElement {
    const body = h('div', { class: 'section-body' }, ...children);
    return h('details', { class: 'section', open: true },
      h('summary', {}, title),
      body,
    );
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

  /** Shows the measured scan result (or a hint before the first scan). */
  setScanNote(text: string): void {
    this.scanNote.textContent = text;
  }

  private syncPreset(): void {
    this.presetSelect.value = matchPreset(pickPerformance(this.renderer.settings));
  }

  private choice(label: string, options: [string, string][], get: () => string, set: (v: string) => void, onChange: () => void): HTMLElement {
    const select = h('select', {
      class: 'select',
      onChange: (e: Event) => {
        set((e.target as HTMLSelectElement).value);
        onChange();
      },
    }, ...options.map(([value, text]) => h('option', { value }, text)));
    select.value = get();
    this.choices.push({ get, select });
    return h('label', { class: 'field' }, h('span', {}, label), select);
  }

  private toggle(spec: ToggleSpec): HTMLElement {
    const input = h('input', {
      type: 'checkbox',
      checked: spec.get(),
      onChange: (e: Event) => {
        spec.set((e.target as HTMLInputElement).checked);
        spec.onChange();
      },
    });
    this.toggles.push({ spec, input });
    return h('label', { class: 'toggle' }, input, h('span', { class: 'switch', 'aria-hidden': 'true' }), h('span', {}, spec.label));
  }
}
