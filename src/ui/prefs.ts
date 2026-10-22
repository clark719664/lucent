import { PERFORMANCE_PRESETS, type PerformanceSettings, type PresetName } from '../perf';

const KEY = 'lucent.performance.v1';

export interface StoredScan {
  msPerSample: number;
  width: number;
  height: number;
  gpu: string;
  preset: PresetName;
  scene: string;
}

export interface Prefs {
  settings: PerformanceSettings;
  scan: StoredScan | null;
}

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Saved performance settings, or null on first visit (or when storage is unavailable or corrupt). */
export function loadPrefs(): Prefs | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<Prefs>;
    const s = p.settings;
    const base = PERFORMANCE_PRESETS.balanced;
    if (!s || !(Object.keys(base) as (keyof PerformanceSettings)[]).every((k) => typeof s[k] === typeof base[k])) return null;
    if (![s.gpuBudget, s.fpsCap, s.resolutionScale, s.maxBounces, s.maxSamples].every(isNumber)) return null;
    return { settings: s, scan: p.scan ?? null };
  } catch {
    return null;
  }
}

export function savePrefs(prefs: Prefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // Private mode or blocked storage: settings simply will not persist.
  }
}
