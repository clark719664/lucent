import type { InputFile } from '../loaders/model';
import { h } from './dom';

/** Reads a dropped folder recursively, keeping relative paths so .gltf URIs resolve. */
async function readEntry(entry: FileSystemEntry, prefix: string, out: InputFile[]): Promise<void> {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
    out.push({ file, path: prefix + file.name });
    return;
  }
  if (!entry.isDirectory) return;
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  // readEntries returns results in batches until it yields an empty array.
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (batch.length === 0) break;
    for (const child of batch) await readEntry(child, `${prefix}${entry.name}/`, out);
  }
}

export async function filesFromDrop(dt: DataTransfer): Promise<InputFile[]> {
  const entries = Array.from(dt.items)
    .map((item) => (item.kind === 'file' ? item.webkitGetAsEntry() : null))
    .filter((e): e is FileSystemEntry => e !== null);
  if (entries.length === 0) return Array.from(dt.files).map((file) => ({ file, path: file.name }));
  const out: InputFile[] = [];
  for (const e of entries) await readEntry(e, '', out);
  return out;
}

/** Full-window drop target that appears while files are dragged over the page. */
export function installDropZone(root: HTMLElement, onFiles: (files: InputFile[]) => void): void {
  const overlay = h('div', { class: 'dropzone', hidden: true },
    h('div', { class: 'dropzone-card' },
      h('strong', {}, 'Drop to load'),
      h('span', {}, 'A .glb, a .gltf with its .bin and textures (or their folder), or an .hdr environment.'),
    ),
  );
  root.append(overlay);
  let depth = 0;
  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    depth++;
    overlay.hidden = false;
  });
  window.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) overlay.hidden = true;
  });
  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    overlay.hidden = true;
    if (e.dataTransfer) void filesFromDrop(e.dataTransfer).then(onFiles);
  });
}

/** Opens the native file picker; resolves with nothing if the user cancels. */
export function pickFiles(): Promise<InputFile[]> {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', multiple: true, accept: '.glb,.gltf,.bin,.png,.jpg,.jpeg,.webp,.hdr' });
    input.addEventListener('change', () => resolve(Array.from(input.files ?? []).map((file) => ({ file, path: file.name }))));
    input.addEventListener('cancel', () => resolve([]));
    input.click();
  });
}
