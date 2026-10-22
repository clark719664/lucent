/**
 * Tiny `#include "file"` resolver for GLSL sources.
 *
 * WebGL has no include mechanism, so shader chunks are imported as raw strings
 * and stitched together here. Each included chunk is wrapped in `#line`
 * directives so driver error messages still point at the right file and line.
 */
export type ShaderSources = Record<string, string>;

const INCLUDE_RE = /^[ \t]*#include\s+"([^"]+)"[ \t]*$/gm;

export function preprocess(entry: string, sources: ShaderSources, seen = new Set<string>()): string {
  const src = sources[entry];
  if (src === undefined) throw new Error(`Unknown shader chunk "${entry}"`);
  if (seen.has(entry)) throw new Error(`Circular #include of "${entry}"`);
  seen.add(entry);

  const names = Object.keys(sources);
  const fileId = (name: string) => names.indexOf(name) + 1;

  let lineNo = 0;
  const lines = src.split('\n');
  const out: string[] = [];
  for (const line of lines) {
    lineNo++;
    INCLUDE_RE.lastIndex = 0;
    const m = INCLUDE_RE.exec(line);
    if (m) {
      out.push(preprocess(m[1]!, sources, seen));
      // Resume numbering of the including file after the include site.
      out.push(`#line ${lineNo + 1} ${fileId(entry)}`);
    } else {
      out.push(line);
    }
  }
  // The `#version` directive must stay the very first line, so only chunks
  // without one get a leading #line marker.
  const body = out.join('\n');
  return body.startsWith('#version') ? body : `#line 1 ${fileId(entry)}\n${body}`;
}

/** Maps the numeric file id emitted by `preprocess` back to a chunk name for error reporting. */
export function chunkNameForId(id: number, sources: ShaderSources): string {
  return Object.keys(sources)[id - 1] ?? `chunk#${id}`;
}
