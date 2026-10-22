import { MODELS, type GalleryModel } from '../gallery';
import { h } from './dom';

export interface PresetCard {
  index: number;
  name: string;
  description: string;
  thumbnail: string;
}

export interface GalleryEvents {
  onPreset: (index: number) => void;
  onModel: (model: GalleryModel) => void;
}

/** Modal grid of built-in scenes and remote glTF sample models. */
export class GalleryView {
  readonly root: HTMLElement;

  constructor(presets: PresetCard[], events: GalleryEvents) {
    const card = (thumb: string, title: string, lines: string[], onPick: () => void) =>
      h('button', {
        class: 'card',
        onClick: () => {
          this.close();
          onPick();
        },
      },
        h('img', { src: thumb, alt: '', loading: 'lazy', decoding: 'async' }),
        h('span', { class: 'card-title' }, title),
        ...lines.map((l, i) => h('span', { class: i === 0 ? 'card-line' : 'card-meta' }, l)),
      );

    this.root = h('div', {
      class: 'gallery',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': 'Gallery',
      hidden: true,
      onClick: (e: Event) => {
        if (e.target === this.root) this.close();
      },
    },
      h('div', { class: 'gallery-sheet' },
        h('header', { class: 'gallery-header' },
          h('h2', {}, 'Gallery'),
          h('button', { class: 'btn gallery-close', 'aria-label': 'Close gallery', onClick: () => this.close() }, 'Close'),
        ),
        h('h3', {}, 'Built-in scenes'),
        h('div', { class: 'card-grid' },
          ...presets.map((p) => card(p.thumbnail, p.name, [p.description], () => events.onPreset(p.index))),
        ),
        h('h3', {}, 'glTF sample models'),
        h('p', { class: 'gallery-note' },
          'Streamed from the Khronos glTF-Sample-Assets repository and lit by Poly Haven HDRIs (CC0).'),
        h('div', { class: 'card-grid' },
          ...MODELS.map((m) => card(m.thumbnail, m.name, [m.features, `${m.credit} · ${m.megabytes} MB`], () => events.onModel(m))),
        ),
      ),
    );
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  open(): void {
    this.root.hidden = false;
  }

  close(): void {
    this.root.hidden = true;
  }
}
