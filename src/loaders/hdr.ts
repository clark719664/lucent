import type { HDRImage } from '../scene/environment';

/**
 * Radiance RGBE (.hdr) decoder: flat and "new" run-length encoded scanlines,
 * any of the four axis orientations. Output rows run top to bottom, RGB floats.
 */
export function parseHDR(buffer: ArrayBuffer): HDRImage {
  const bytes = new Uint8Array(buffer);
  let pos = 0;

  const readLine = (): string => {
    const start = pos;
    while (pos < bytes.length && bytes[pos] !== 0x0a) pos++;
    if (pos >= bytes.length) throw new Error('HDR: unexpected end of header');
    const line = String.fromCharCode(...bytes.subarray(start, pos));
    pos++;
    return line;
  };

  const magic = readLine();
  if (!magic.startsWith('#?')) throw new Error('HDR: missing #? signature, not a Radiance file');
  for (;;) {
    const line = readLine().trim();
    if (line === '') break;
    const fmt = /^FORMAT=(.+)$/.exec(line);
    if (fmt && fmt[1] !== '32-bit_rle_rgbe') throw new Error(`HDR: unsupported format ${fmt[1]}`);
  }

  const res = /^([-+])([XY]) (\d+) ([-+])([XY]) (\d+)$/.exec(readLine().trim());
  if (!res || res[2] === res[5]) throw new Error('HDR: malformed resolution line');
  const rowMajorY = res[2] === 'Y';
  const n1 = Number(res[3]);
  const n2 = Number(res[6]);
  const width = rowMajorY ? n2 : n1;
  const height = rowMajorY ? n1 : n2;
  const scanlines = n1;
  const scanLength = n2;
  if (width <= 0 || height <= 0) throw new Error('HDR: empty image');

  const rgbe = new Uint8Array(scanLength * 4);
  const data = new Float32Array(width * height * 3);
  const flipY = (rowMajorY ? res[1] : res[4]) === '+';
  const flipX = (rowMajorY ? res[4] : res[1]) === '-';

  const readScanline = (): void => {
    const rle =
      scanLength >= 8 && scanLength < 0x8000 && pos + 4 <= bytes.length &&
      bytes[pos] === 2 && bytes[pos + 1] === 2 && (bytes[pos + 2]! & 0x80) === 0;
    if (!rle) {
      if (pos + scanLength * 4 > bytes.length) throw new Error('HDR: truncated pixel data');
      rgbe.set(bytes.subarray(pos, pos + scanLength * 4));
      pos += scanLength * 4;
      return;
    }
    if (((bytes[pos + 2]! << 8) | bytes[pos + 3]!) !== scanLength) throw new Error('HDR: scanline width mismatch');
    pos += 4;
    for (let c = 0; c < 4; c++) {
      let x = 0;
      while (x < scanLength) {
        if (pos >= bytes.length) throw new Error('HDR: truncated run-length data');
        let count = bytes[pos++]!;
        if (count > 128) {
          count -= 128;
          if (x + count > scanLength) throw new Error('HDR: run overflows scanline');
          const v = bytes[pos++]!;
          for (let k = 0; k < count; k++) rgbe[(x++) * 4 + c] = v;
        } else {
          if (count === 0 || x + count > scanLength) throw new Error('HDR: bad literal run');
          for (let k = 0; k < count; k++) rgbe[(x++) * 4 + c] = bytes[pos++]!;
        }
      }
    }
  };

  for (let s = 0; s < scanlines; s++) {
    readScanline();
    for (let i = 0; i < scanLength; i++) {
      let x = rowMajorY ? i : s;
      let y = rowMajorY ? s : i;
      if (flipX) x = width - 1 - x;
      if (flipY) y = height - 1 - y;
      const e = rgbe[i * 4 + 3]!;
      const o = (y * width + x) * 3;
      if (e === 0) continue;
      // Radiance's colr_color(): mantissa centred in its bucket.
      const f = 2 ** (e - 136);
      data[o] = (rgbe[i * 4]! + 0.5) * f;
      data[o + 1] = (rgbe[i * 4 + 1]! + 0.5) * f;
      data[o + 2] = (rgbe[i * 4 + 2]! + 0.5) * f;
    }
  }
  return { width, height, data };
}
