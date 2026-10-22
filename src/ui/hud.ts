import type { RenderStats } from '../renderer';
import { formatCount, formatDuration, h } from './dom';

/** Corner readout of convergence, measured throughput and GPU load; visible even with the panel hidden. */
export class Hud {
  readonly root = h('div', { class: 'hud', 'aria-live': 'off' });

  update(st: RenderStats, paused: boolean): void {
    const items: (string | HTMLElement)[] = [`${formatCount(st.samples)} spp`];
    const idle = paused || st.done;
    if (!idle) {
      items.push(
        `${st.sppPerSec >= 100 ? st.sppPerSec.toFixed(0) : st.sppPerSec.toFixed(1)} spp/s`,
        `${st.msamplesPerSec.toFixed(1)} Mpaths/s`,
      );
    }
    if (st.gpuLoad !== null) items.push(`GPU ${st.gpuLoadMeasured ? '' : '~'}${Math.round(st.gpuLoad * 100)}%`);
    items.push(formatDuration(st.elapsedMs));
    if (st.interactive) items.push(h('span', { class: 'hud-tag' }, `preview ${Math.round((st.width / st.viewWidth) * 100)}%`));
    if (st.denoised && !idle) items.push(h('span', { class: 'hud-tag' }, 'denoised'));
    if (st.done) items.push(h('span', { class: 'hud-tag' }, 'done'));
    else if (paused) items.push(h('span', { class: 'hud-tag' }, 'paused'));
    this.root.replaceChildren(...items.map((i) => (typeof i === 'string' ? h('span', {}, i) : i)));
  }
}
