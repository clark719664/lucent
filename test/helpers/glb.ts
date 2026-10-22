/** Builds GLB containers and binary buffers for parser tests. */
export function makeGLB(json: unknown, bin?: Uint8Array): ArrayBuffer {
  const enc = new TextEncoder();
  let jsonBytes = enc.encode(JSON.stringify(json));
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
  if (jsonPad) {
    const padded = new Uint8Array(jsonBytes.length + jsonPad).fill(0x20);
    padded.set(jsonBytes);
    jsonBytes = padded;
  }
  const binPad = bin ? (4 - (bin.length % 4)) % 4 : 0;
  const binLength = bin ? bin.length + binPad : 0;
  const total = 12 + 8 + jsonBytes.length + (bin ? 8 + binLength : 0);
  const out = new ArrayBuffer(total);
  const dv = new DataView(out);
  const u8 = new Uint8Array(out);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonBytes.length, true);
  dv.setUint32(16, 0x4e4f534a, true);
  u8.set(jsonBytes, 20);
  if (bin) {
    const o = 20 + jsonBytes.length;
    dv.setUint32(o, binLength, true);
    dv.setUint32(o + 4, 0x004e4942, true);
    u8.set(bin, o + 8);
  }
  return out;
}

/** Concatenates typed arrays into one 4-byte-aligned buffer, returning each part's byte offset. */
export function pack(...parts: ArrayBufferView[]): { bytes: Uint8Array; offsets: number[] } {
  const offsets: number[] = [];
  let size = 0;
  for (const p of parts) {
    offsets.push(size);
    size += p.byteLength + ((4 - (p.byteLength % 4)) % 4);
  }
  const bytes = new Uint8Array(size);
  parts.forEach((p, i) => bytes.set(new Uint8Array(p.buffer, p.byteOffset, p.byteLength), offsets[i]));
  return { bytes, offsets };
}

export const toBase64 = (bytes: Uint8Array): string => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};
