import type { RenderStats } from '../renderer';
import { formatCount, formatDuration, h } from './dom';

/** Corner readout of convergence and measured throughput; visible even with the panel hidden. */
export class Hud {
  readonly root = h('div', { class: 'hud', 'aria-live': 'off' });

  update(st: RenderStats): void {
    const items: (string | HTMLElement)[] = [
      `${formatCount(st.samples)} spp`,
      `${st.sppPerSec >= 100 ? st.sppPerSec.toFixed(0) : st.sppPerSec.toFixed(1)} spp/s`,
      `${st.msamplesPerSec.toFixed(1)} Mpaths/s`,
      formatDuration(st.elapsedMs),
    ];
    if (st.interactive) items.push(h('span', { class: 'hud-tag' }, `preview ${Math.round((st.width / st.viewWidth) * 100)}%`));
    if (st.denoised) items.push(h('span', { class: 'hud-tag' }, 'denoised'));
    this.root.replaceChildren(...items.map((i) => (typeof i === 'string' ? h('span', {}, i) : i)));
  }
}
