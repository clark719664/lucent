/**
 * Performance controls. A progressive path tracer will happily keep a GPU at
 * 100% forever, so Lucent schedules its work against a budget: the share of
 * wall-clock time the GPU may spend rendering. Presets bundle the budget with
 * the other knobs that set cost, and a short measured scan picks one.
 */

export type PresetName = 'eco' | 'balanced' | 'high' | 'max';

export interface PerformanceSettings {
  /** Share of wall-clock time the GPU may spend rendering, 0.05–1. */
  gpuBudget: number;
  /** Redraws per second at most; 0 follows the display. */
  fpsCap: number;
  /** Internal resolution as a fraction of the canvas' device-pixel size. */
  resolutionScale: number;
  maxBounces: number;
  /** Stop accumulating at this many samples per pixel; 0 never stops. */
  maxSamples: number;
  /** Stop rendering while the window is in the background. */
  pauseWhenUnfocused: boolean;
}

export const PERFORMANCE_PRESETS: Readonly<Record<PresetName, PerformanceSettings>> = {
  eco: { gpuBudget: 0.25, fpsCap: 30, resolutionScale: 0.5, maxBounces: 4, maxSamples: 1024, pauseWhenUnfocused: true },
  balanced: { gpuBudget: 0.5, fpsCap: 60, resolutionScale: 0.75, maxBounces: 6, maxSamples: 2048, pauseWhenUnfocused: true },
  high: { gpuBudget: 0.8, fpsCap: 60, resolutionScale: 1, maxBounces: 8, maxSamples: 4096, pauseWhenUnfocused: true },
  max: { gpuBudget: 1, fpsCap: 0, resolutionScale: 1, maxBounces: 12, maxSamples: 0, pauseWhenUnfocused: false },
};

export const PRESET_LABELS: Readonly<Record<PresetName, string>> = {
  eco: 'Eco',
  balanced: 'Balanced',
  high: 'High',
  max: 'Max',
};

const PRESET_ORDER: readonly PresetName[] = ['eco', 'balanced', 'high', 'max'];

/** Copies just the performance fields out of a larger settings object. */
export function pickPerformance(s: PerformanceSettings): PerformanceSettings {
  const { gpuBudget, fpsCap, resolutionScale, maxBounces, maxSamples, pauseWhenUnfocused } = s;
  return { gpuBudget, fpsCap, resolutionScale, maxBounces, maxSamples, pauseWhenUnfocused };
}

/** The preset these settings equal, or `custom` once any knob has been moved. */
export function matchPreset(s: PerformanceSettings): PresetName | 'custom' {
  const keys = Object.keys(PERFORMANCE_PRESETS.eco) as (keyof PerformanceSettings)[];
  return PRESET_ORDER.find((name) => keys.every((k) => PERFORMANCE_PRESETS[name][k] === s[k])) ?? 'custom';
}

export interface ScanResult {
  /** Measured GPU time of one sample per pixel at full resolution. */
  msPerSample: number;
  width: number;
  height: number;
}

export interface Recommendation {
  preset: PresetName;
  settings: PerformanceSettings;
  /** The scan's cost scaled to 1920 × 1080, which is what the tier is judged on. */
  msAt1080p: number;
}

/**
 * Picks a preset from a measured scan: the tier comes from the cost of a
 * 1080p sample, then the resolution is lowered (in 25% steps, never below the
 * tier's own) until one sample fits that tier's frame-time target, so camera
 * moves stay responsive on this screen.
 */
export function recommend(scan: ScanResult): Recommendation {
  const pixels = Math.max(1, scan.width * scan.height);
  const msAt1080p = (scan.msPerSample * (1920 * 1080)) / pixels;
  const preset: PresetName = msAt1080p <= 30 ? 'high' : msAt1080p <= 90 ? 'balanced' : 'eco';
  const targetMs = preset === 'high' ? 20 : preset === 'balanced' ? 25 : 33;
  const base = PERFORMANCE_PRESETS[preset];
  // Cost scales with pixel count, i.e. with the square of the resolution scale.
  const fit = Math.sqrt(targetMs / Math.max(scan.msPerSample, 1e-3));
  const scale = Math.min(base.resolutionScale, Math.max(0.25, Math.floor(fit * 4) / 4));
  return { preset, settings: { ...base, resolutionScale: scale }, msAt1080p };
}

/**
 * Token bucket for GPU time. Wall-clock time earns `budget` milliseconds of
 * GPU work per millisecond; work spends it. A frame may only start work it can
 * afford, so with a 25% budget the average load settles near 25% even when a
 * single sample costs more than a frame (those frames simply wait).
 */
export class GpuBudget {
  private credit = 0;
  private last = -1;

  constructor(public budget: number) {}

  /**
   * Earns credit for the time since the previous call and returns what may be
   * spent now. `burstMs` caps savings, so a long idle does not end in a stall.
   */
  allowance(now: number, burstMs: number): number {
    // A long gap means the page was throttled or hidden; do not bank it.
    const dt = this.last < 0 ? 0 : Math.min(now - this.last, 250);
    this.last = now;
    this.credit = Math.min(this.credit + dt * this.budget, Math.max(burstMs, 1));
    return this.credit;
  }

  spend(ms: number): void {
    this.credit -= ms;
  }

  reset(): void {
    this.credit = 0;
    this.last = -1;
  }
}

/** Samples the current allowance pays for, given what one sample costs. */
export function affordableSamples(allowanceMs: number, msPerSample: number, cap = 32): number {
  if (!(msPerSample > 0) || allowanceMs < msPerSample) return 0;
  return Math.min(cap, Math.floor(allowanceMs / msPerSample));
}
