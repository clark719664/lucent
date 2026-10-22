import { describe, expect, it } from 'vitest';
import { chunkNameForId, preprocess } from '../src/gl/preprocess';

describe('preprocess', () => {
  const sources = {
    'main.frag': '#version 300 es\n#include "a.glsl"\nvoid main() {}\n',
    'a.glsl': 'float a() { return 1.0; }\n#include "b.glsl"\n',
    'b.glsl': 'float b() { return 2.0; }\n',
  };

  it('inlines nested includes and keeps #version first', () => {
    const out = preprocess('main.frag', sources);
    expect(out.startsWith('#version 300 es')).toBe(true);
    expect(out).toContain('float a()');
    expect(out).toContain('float b()');
    expect(out).not.toContain('#include');
  });

  it('emits #line markers that map back to chunk names', () => {
    const out = preprocess('main.frag', sources);
    expect(out).toContain('#line 1 2'); // start of a.glsl
    expect(out).toContain('#line 1 3'); // start of b.glsl
    expect(out).toContain('#line 3 1'); // resume main.frag after the include
    expect(chunkNameForId(2, sources)).toBe('a.glsl');
    expect(chunkNameForId(9, sources)).toBe('chunk#9');
  });

  it('rejects unknown and circular includes', () => {
    expect(() => preprocess('nope', sources)).toThrow(/Unknown/);
    const cyclic = { x: '#include "y"\n', y: '#include "x"\n' };
    expect(() => preprocess('x', cyclic)).toThrow(/Circular/);
  });
});
