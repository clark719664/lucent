import { HDRIS, hdriURL, MODELS, modelURL, type GalleryModel } from './gallery';
import { buildBVHAsync } from './math/bvh-async';
import type { BVH } from './math/bvh';
import { loadHDRFile, loadHDRURL, loadModelFiles, loadModelURL, sceneFromModel, type InputFile, type LoadedModel } from './loaders/model';
import { Renderer } from './renderer';
import type { Environment, HDRImage } from './scene/environment';
import { PRESETS } from './scene/presets';
import { mergeMeshes } from './scene/mesh';
import type { Scene } from './scene/scene';
import { h } from './ui/dom';
import { installDropZone, pickFiles } from './ui/drop';
import { GalleryView } from './ui/gallery-view';
import { Hud } from './ui/hud';
import { OrbitControls } from './ui/orbit';
import { Panel } from './ui/panel';
import './ui/styles.css';

const PRESET_THUMBS = ['showroom', 'cornell', 'material', 'nocturne'];
const DEFAULT_HDRI = 'studio_small_08';

function showFatal(root: HTMLElement, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  root.replaceChildren(
    h('div', { class: 'fatal' },
      h('div', { class: 'fatal-card' },
        h('h2', {}, "Lucent couldn't start"),
        h('p', {}, 'This renderer needs WebGL2 with floating-point render targets. Most desktop browsers from the last few years support it; try Chrome, Edge or Firefox with hardware acceleration enabled.'),
        h('pre', {}, message),
      ),
    ),
  );
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const stem = (path: string) => (path.split('/').pop() ?? path).replace(/\.[^.]+$/, '');

function main(): void {
  const root = document.getElementById('app');
  if (!root) throw new Error('#app missing');

  const canvas = h('canvas', { class: 'view', 'aria-label': 'Path traced image' });
  root.append(canvas);

  let renderer: Renderer;
  try {
    renderer = new Renderer(canvas);
  } catch (err) {
    showFatal(root, err);
    return;
  }

  const params = new URLSearchParams(location.search);
  const sceneIndex = Math.max(0, Math.min(PRESETS.length - 1, Number(params.get('scene') ?? 0) || 0));
  let scene = PRESETS[sceneIndex]!();
  renderer.settings.exposure = scene.exposure;
  renderer.applySettings();
  renderer.loadScene(scene);
  renderer.resize();

  const toast = h('div', { class: 'toast', role: 'status' });
  const progress = h('div', { class: 'progress' });
  const hud = new Hud();
  let toastTimer = 0;
  /** `ms = 0` keeps the message up until the next one. */
  const notify = (msg: string, ms = 2600) => {
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    if (ms > 0) toastTimer = window.setTimeout(() => toast.classList.remove('show'), ms);
  };

  const hdris = new Map<string, Promise<HDRImage>>();
  const getHDRI = (id: string): Promise<HDRImage> => {
    let p = hdris.get(id);
    if (!p) {
      p = loadHDRURL(hdriURL(id));
      hdris.set(id, p);
      p.catch(() => hdris.delete(id));
    }
    return p;
  };
  let dropped: { name: string; image: HDRImage } | null = null;

  const setURL = (key: 'scene' | 'model', value: string) => {
    params.delete('scene');
    params.delete('model');
    params.set(key, value);
    history.replaceState(null, '', `?${params}`);
  };

  /** Swaps in a scene; `bvh` comes from buildBVHAsync for models. */
  const setScene = (next: Scene, bvh?: BVH) => {
    renderer.settings.exposure = next.exposure;
    renderer.loadScene(next, bvh);
    scene = next;
    controls.setCamera(next.camera);
    panel.setScene(next);
  };

  let loadToken = 0;
  /** Builds the BVH off the main thread, then swaps the scene in. Resolves false if a newer load won. */
  const showModel = async (token: number, model: LoadedModel, env: Environment, framing: Partial<GalleryModel> = {}, envId?: string) => {
    const next = sceneFromModel(model, env, framing);
    const tris = model.asset.triangleCount.toLocaleString('en-US');
    notify(`Building BVH for ${tris} triangles…`, 0);
    const t0 = performance.now();
    const bvh = await buildBVHAsync(mergeMeshes(next.meshes.map((m) => m.mesh)).positions);
    if (token !== loadToken) return false;
    const t1 = performance.now();
    setScene(next, bvh);
    const t2 = performance.now();
    if (envId) panel.setEnvironment(envId, dropped?.name);
    const warn = model.warnings.length ? `\n${model.warnings.join('\n')}` : '';
    notify(`${model.name}: ${tris} triangles · BVH ${(t1 - t0).toFixed(0)} ms · upload ${(t2 - t1).toFixed(0)} ms${warn}`, warn ? 7000 : 3200);
    return true;
  };

  const hdriEnvironment = (image: HDRImage, name: string, rotation = 0): Environment => ({
    map: image, name, rotation, intensity: 1, background: true, backdrop: [0.02, 0.02, 0.025],
  });

  const openModel = async (m: GalleryModel) => {
    const token = ++loadToken;
    notify(`Loading ${m.name} (${m.megabytes} MB)…`, 0);
    try {
      const [model, image] = await Promise.all([loadModelURL(modelURL(m.id), m.name), getHDRI(m.hdri)]);
      if (token !== loadToken) return;
      const env = HDRIS.find((e) => e.id === m.hdri)!;
      if (await showModel(token, model, hdriEnvironment(image, env.name, m.rotation), m, m.hdri)) setURL('model', m.id);
    } catch (err) {
      if (token === loadToken) notify(`Couldn't load ${m.name}: ${errorText(err)}`, 7000);
    }
  };

  const openPreset = (i: number) => {
    ++loadToken;
    setScene(PRESETS[i]!());
    setURL('scene', String(i));
  };

  const openFiles = async (files: InputFile[]) => {
    if (files.length === 0) return;
    const token = ++loadToken;
    const hasModel = files.some((f) => /\.(glb|gltf)$/i.test(f.path));
    const hdr = files.find((f) => /\.hdr$/i.test(f.path));
    try {
      if (hdr) {
        notify(`Reading ${hdr.file.name}…`, 0);
        dropped = { name: stem(hdr.path), image: await loadHDRFile(hdr.file) };
      }
      if (hasModel) {
        notify('Loading model…', 0);
        const model = await loadModelFiles(files);
        if (token !== loadToken) return;
        let env: Environment = { ...scene.env };
        let envId = scene.env.map ? undefined : 'sky';
        if (dropped && hdr) {
          env = hdriEnvironment(dropped.image, dropped.name);
          envId = 'custom';
        } else if (!scene.env.map) {
          try {
            env = hdriEnvironment(await getHDRI(DEFAULT_HDRI), HDRIS[0]!.name);
            envId = DEFAULT_HDRI;
          } catch {
            // Offline: the procedural sky still lights the model.
          }
        }
        if (!(await showModel(token, model, env, {}, envId))) return;
        params.delete('scene');
        params.delete('model');
        history.replaceState(null, '', params.size ? `?${params}` : location.pathname);
      } else if (dropped && hdr) {
        Object.assign(scene.env, hdriEnvironment(dropped.image, dropped.name, scene.env.rotation));
        renderer.uploadLighting(scene);
        panel.setEnvironment('custom', dropped.name);
        notify(`Environment: ${dropped.name} (${dropped.image.width} × ${dropped.image.height})`);
      } else {
        notify('Nothing to load: drop a .glb, a .gltf with its files, or an .hdr', 5000);
      }
    } catch (err) {
      if (token === loadToken) notify(`Couldn't load: ${errorText(err)}`, 7000);
    }
  };

  const selectEnvironment = async (id: string) => {
    if (id === 'sky') {
      Object.assign(scene.env, { map: null, name: 'Procedural sky' });
      renderer.uploadLighting(scene);
      panel.refresh();
      return;
    }
    const target = scene;
    try {
      let image: HDRImage;
      let name: string;
      if (id === 'custom' && dropped) {
        ({ image, name } = dropped);
      } else {
        const entry = HDRIS.find((e) => e.id === id);
        if (!entry) return;
        notify(`Loading ${entry.name}…`, 0);
        image = await getHDRI(id);
        name = entry.name;
        notify(`Environment: ${name}`);
      }
      if (target !== scene) return;
      Object.assign(scene.env, { map: image, name });
      renderer.uploadLighting(scene);
      panel.setEnvironment(id);
    } catch (err) {
      notify(`Couldn't load the HDRI: ${errorText(err)}`, 6000);
      panel.refresh();
    }
  };

  const controls = new OrbitControls(canvas, scene.camera, {
    onChange: () => renderer.uploadCamera(scene.camera),
    onClick: (x, y) => {
      const d = renderer.pickFocus(x, y);
      if (d === null) return;
      scene.camera.focusDistance = d;
      renderer.uploadCamera(scene.camera, false);
      panel.refresh();
      notify(`Focus → ${d.toFixed(2)} units`);
    },
  });

  const saveScreenshot = async () => {
    const blob = await renderer.screenshot();
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: `lucent-${scene.name.toLowerCase().replace(/\s+/g, '-')}-${renderer.stats().samples}spp.png` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    notify('Saved PNG');
  };

  const gallery = new GalleryView(
    PRESETS.map((make, index) => {
      const s = make();
      return { index, name: s.name, description: s.description, thumbnail: `thumbs/${PRESET_THUMBS[index]}.jpg` };
    }),
    { onPreset: openPreset, onModel: (m) => void openModel(m) },
  );

  const panel = new Panel(renderer, scene, {
    onOpenGallery: () => gallery.open(),
    onOpenFile: () => void pickFiles().then(openFiles),
    onSelectEnvironment: (id) => void selectEnvironment(id),
    onLightingChange: () => renderer.uploadLighting(scene),
    onGroundChange: () => renderer.uploadGround(scene.ground),
    onCameraChange: () => renderer.uploadCamera(scene.camera),
    onSettingsChange: () => {
      renderer.applySettings();
      renderer.reset();
    },
    onResolutionChange: () => renderer.resize(),
    onReset: () => renderer.reset(),
    onScreenshot: () => void saveScreenshot(),
  });

  const toggle = h('button', { class: 'toggle-panel', title: 'Show panel (H)', 'aria-label': 'Show panel', onClick: () => setPanelHidden(false) }, '☰');
  root.append(panel.root, toggle, hud.root, progress, toast, gallery.root);
  installDropZone(root, (files) => void openFiles(files));

  const setPanelHidden = (hidden: boolean) => {
    panel.root.classList.toggle('hidden', hidden);
    toggle.classList.toggle('visible', hidden);
  };
  if (params.get('ui') === '0') {
    // Bare mode for embedding and screenshots: no chrome at all.
    setPanelHidden(true);
    for (const el of [toggle, progress, hud.root]) el.classList.add('hidden-el');
  }

  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    if (e.key === 'Escape' && gallery.isOpen) {
      gallery.close();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    switch (e.key.toLowerCase()) {
      case ' ':
        e.preventDefault();
        panel.togglePause();
        break;
      case 'r':
        renderer.reset();
        break;
      case 's':
        void saveScreenshot();
        break;
      case 'h':
        setPanelHidden(!panel.root.classList.contains('hidden'));
        break;
      case 'g':
        if (gallery.isOpen) gallery.close();
        else gallery.open();
        break;
      case 'd':
        renderer.settings.denoise = !renderer.settings.denoise;
        panel.refresh();
        notify(`Denoiser ${renderer.settings.denoise ? 'on' : 'off'}`);
        break;
    }
  });

  const ro = new ResizeObserver(() => renderer.resize());
  ro.observe(canvas);

  // Don't burn GPU while the tab is hidden, but don't override an explicit pause either.
  let pausedByVisibility = false;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      pausedByVisibility = !renderer.isPaused;
      renderer.setPaused(true);
    } else if (pausedByVisibility) {
      pausedByVisibility = false;
      renderer.setPaused(false);
    }
    panel.syncPauseButton();
  });

  const requested = params.get('model');
  const initialModel = MODELS.find((m) => m.id === requested);
  if (initialModel) void openModel(initialModel);

  if (import.meta.env.DEV) {
    // Console handle for debugging and for capturing README screenshots.
    Object.assign(window, { lucent: { renderer, scene: () => scene, openModel, openPreset, selectEnvironment, MODELS } });
  }

  let lastStats = 0;
  const loop = (now: number) => {
    try {
      renderer.render();
    } catch (err) {
      showFatal(root, err);
      return;
    }
    if (now - lastStats > 250) {
      const st = renderer.stats();
      panel.updateStats(st);
      hud.update(st);
      // Visual convergence indicator: ~1k samples reads as "done" for most scenes.
      const target = renderer.settings.maxSamples || 1024;
      const p = Math.min(1, st.samples / target);
      progress.style.transform = `scaleX(${p})`;
      progress.classList.toggle('done', p >= 1);
      lastStats = now;
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

main();
