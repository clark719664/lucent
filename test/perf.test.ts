import { describe, expect, it } from 'vitest';
import { affordableSamples, GpuBudget, matchPreset, PERFORMANCE_PRESETS, pickPerformance, recommend } from '../src/perf';

/** Runs the scheduler for `seconds` of 60 Hz frames and returns the share of time spent on GPU work. */
function simulate(budget: number, msPerSample: number, seconds = 10): number {
  const b = new GpuBudget(budget);
  const frame = 1000 / 60;
  let busy = 0;
  for (let now = 0; now < seconds * 1000; now += frame) {
    const allowance = b.allowance(now, Math.max(frame * budget * 2, msPerSample * 1.05));
    const n = affordableSamples(allowance, msPerSample);
    b.spend(n * msPerSample);
    busy += n * msPerSample;
  }
  return busy / (seconds * 1000);
}

describe('GPU budget', () => {
  it('holds the average load near the budget for cheap and expensive samples', () => {
    for (const budget of [0.1, 0.25, 0.5, 0.8]) {
      for (const cost of [0.5, 4, 16, 40, 120]) {
        expect(simulate(budget, cost)).toBeCloseTo(budget, 1);
      }
    }
  });

  it('can use the whole GPU when the budget is 100%', () => {
    expect(simulate(1, 3)).toBeGreaterThan(0.95);
  });

  it('does not bank credit across a long stall', () => {
    const b = new GpuBudget(0.5);
    b.allowance(0, 20);
    expect(b.allowance(10_000, 20)).toBeLessThanOrEqual(20);
  });

  it('affords whole samples only', () => {
    expect(affordableSamples(9.9, 5)).toBe(1);
    expect(affordableSamples(4.9, 5)).toBe(0);
    expect(affordableSamples(1000, 1)).toBe(32);
    expect(affordableSamples(10, 0)).toBe(0);
  });
});

describe('presets', () => {
  it('round-trip through matchPreset and mark edits as custom', () => {
    for (const [name, p] of Object.entries(PERFORMANCE_PRESETS)) expect(matchPreset({ ...p })).toBe(name);
    expect(matchPreset({ ...PERFORMANCE_PRESETS.balanced, gpuBudget: 0.55 })).toBe('custom');
  });

  it('pickPerformance drops unrelated settings', () => {
    const picked = pickPerformance({ ...PERFORMANCE_PRESETS.eco, exposure: 2 } as typeof PERFORMANCE_PRESETS.eco);
    expect(picked).toEqual(PERFORMANCE_PRESETS.eco);
  });

  it('get cheaper from max to eco', () => {
    const order = ['max', 'high', 'balanced', 'eco'] as const;
    for (let i = 1; i < order.length; i++) {
      const a = PERFORMANCE_PRESETS[order[i - 1]!];
      const b = PERFORMANCE_PRESETS[order[i]!];
      expect(b.gpuBudget).toBeLessThan(a.gpuBudget);
      expect(b.resolutionScale).toBeLessThanOrEqual(a.resolutionScale);
      expect(b.maxBounces).toBeLessThan(a.maxBounces);
    }
  });
});

describe('recommend', () => {
  it('picks the tier from the cost of a 1080p sample', () => {
    expect(recommend({ msPerSample: 10, width: 1920, height: 1080 }).preset).toBe('high');
    expect(recommend({ msPerSample: 60, width: 1920, height: 1080 }).preset).toBe('balanced');
    expect(recommend({ msPerSample: 200, width: 1920, height: 1080 }).preset).toBe('eco');
    // The same GPU on a 4K canvas pays four times per sample but is still the same tier.
    expect(recommend({ msPerSample: 40, width: 3840, height: 2160 }).msAt1080p).toBeCloseTo(10);
  });

  it('lowers resolution until one sample fits the tier target, in quarter steps', () => {
    const r = recommend({ msPerSample: 80, width: 2560, height: 1440 });
    expect(r.preset).toBe('balanced');
    // sqrt(25 / 80) = 0.56 → 0.5
    expect(r.settings.resolutionScale).toBe(0.5);
    expect(r.settings.gpuBudget).toBe(PERFORMANCE_PRESETS.balanced.gpuBudget);
    const slow = recommend({ msPerSample: 5000, width: 1920, height: 1080 });
    expect(slow.settings.resolutionScale).toBe(0.25);
  });

  it('never raises resolution above the preset', () => {
    expect(recommend({ msPerSample: 1, width: 1920, height: 1080 }).settings.resolutionScale).toBe(1);
    expect(recommend({ msPerSample: 100, width: 1280, height: 720 }).settings.resolutionScale).toBeLessThanOrEqual(0.5);
  });
});
