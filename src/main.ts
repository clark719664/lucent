import { Renderer } from './renderer';
import { PRESETS } from './scene/presets';
import { h } from './ui/dom';
import { OrbitControls } from './ui/orbit';
import { Panel } from './ui/panel';
import './ui/styles.css';

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
  const sceneIndex = Math.max(0, Math.min(PRESETS.length - 1, Number(params.get('scene') ?? 0)));
  let scene = PRESETS[sceneIndex]!();
  renderer.settings.exposure = scene.exposure;
  renderer.applySettings();
  renderer.loadScene(scene);
  renderer.resize();

  const toast = h('div', { class: 'toast' });
  const progress = h('div', { class: 'progress' });
  let toastTimer = 0;
  const notify = (msg: string, ms = 2200) => {
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.remove('show'), ms);
  };

  const controls = new OrbitControls(canvas, scene.camera, {
    onChange: () => renderer.uploadCamera(scene.camera),
    onClick: (x, y) => {
      const d = renderer.pickFocus(x, y);
      if (d === null) return;
      scene.camera.focusDistance = d;
      renderer.uploadCamera(scene.camera);
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

  const panel = new Panel(renderer, sceneIndex, {
    onSelectScene: (i) => {
      scene = PRESETS[i]!();
      renderer.settings.exposure = scene.exposure;
      renderer.loadScene(scene);
      controls.setCamera(scene.camera);
      panel.setScene(scene);
      params.set('scene', String(i));
      history.replaceState(null, '', `?${params}`);
    },
    onLightingChange: () => renderer.uploadLighting(scene.sun, scene.sky),
    onCameraChange: () => renderer.uploadCamera(scene.camera),
    onSettingsChange: () => {
      renderer.applySettings();
      renderer.reset();
    },
    onResolutionChange: () => renderer.resize(),
    onReset: () => renderer.reset(),
    onScreenshot: () => void saveScreenshot(),
  });

  const toggle = h('button', { class: 'toggle-panel', title: 'Show panel (H)', onClick: () => setPanelHidden(false) }, '☰');
  root.append(panel.root, toggle, progress, toast);

  const setPanelHidden = (hidden: boolean) => {
    panel.root.classList.toggle('hidden', hidden);
    toggle.classList.toggle('visible', hidden);
  };
  if (params.get('ui') === '0') {
    // Bare mode for embedding and screenshots: no chrome at all.
    setPanelHidden(true);
    toggle.classList.add('hidden');
    progress.classList.add('hidden');
  }

  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
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
