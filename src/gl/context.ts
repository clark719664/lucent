import { chunkNameForId, type ShaderSources } from './preprocess';

export class GLError extends Error {}

export interface GLCapabilities {
  gl: WebGL2RenderingContext;
  maxTextureSize: number;
  renderer: string;
}

/**
 * Creates a WebGL2 context with the extensions the path tracer relies on.
 * Throws a descriptive `GLError` so the UI can explain what is missing.
 */
export function createContext(canvas: HTMLCanvasElement): GLCapabilities {
  const gl = canvas.getContext('webgl2', {
    antialias: false,
    alpha: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: true,
    powerPreference: 'high-performance',
  });
  if (!gl) throw new GLError('WebGL2 is not available in this browser.');
  if (!gl.getExtension('EXT_color_buffer_float')) {
    throw new GLError('EXT_color_buffer_float is required to accumulate HDR samples.');
  }
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const renderer = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : 'unknown GPU';
  return { gl, maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number, renderer };
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string, sources: ShaderSources): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new GLError('Failed to allocate shader');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? '';
    gl.deleteShader(shader);
    // Rewrite "ERROR: <file>:<line>" using the chunk names from the preprocessor.
    const pretty = log.replace(/ERROR: (\d+):(\d+)/g, (_, f, l) => `ERROR: ${chunkNameForId(Number(f), sources)}:${l}`);
    throw new GLError(`Shader compile failed:\n${pretty}`);
  }
  return shader;
}

export class Program {
  readonly handle: WebGLProgram;
  private readonly uniforms = new Map<string, WebGLUniformLocation | null>();

  constructor(
    private readonly gl: WebGL2RenderingContext,
    vertex: string,
    fragment: string,
    sources: ShaderSources = {},
  ) {
    const vs = compileShader(gl, gl.VERTEX_SHADER, vertex, sources);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragment, sources);
    const program = gl.createProgram();
    if (!program) throw new GLError('Failed to allocate program');
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program) ?? '';
      gl.deleteProgram(program);
      throw new GLError(`Program link failed:\n${log}`);
    }
    this.handle = program;
  }

  use(): void {
    this.gl.useProgram(this.handle);
  }

  /** Uniform locations are looked up lazily and cached; unknown names resolve to null silently. */
  loc(name: string): WebGLUniformLocation | null {
    let l = this.uniforms.get(name);
    if (l === undefined) {
      l = this.gl.getUniformLocation(this.handle, name);
      this.uniforms.set(name, l);
    }
    return l;
  }

  f1(name: string, v: number) { this.gl.uniform1f(this.loc(name), v); }
  i1(name: string, v: number) { this.gl.uniform1i(this.loc(name), v); }
  u1(name: string, v: number) { this.gl.uniform1ui(this.loc(name), v); }
  f2(name: string, x: number, y: number) { this.gl.uniform2f(this.loc(name), x, y); }
  f3(name: string, v: ArrayLike<number>) { this.gl.uniform3f(this.loc(name), v[0]!, v[1]!, v[2]!); }
  f4v(name: string, v: Float32Array) { this.gl.uniform4fv(this.loc(name), v); }
  i1v(name: string, v: Int32Array) { this.gl.uniform1iv(this.loc(name), v); }

  dispose(): void {
    this.gl.deleteProgram(this.handle);
  }
}

/** Width of the data textures; the shader hardcodes the matching shift/mask. */
export const DATA_TEXTURE_WIDTH = 2048;

/** Uploads an RGBA32F array as a 2048-wide texture addressed like a flat array. */
export function createDataTexture(gl: WebGL2RenderingContext, data: Float32Array): WebGLTexture {
  const texels = Math.max(1, data.length / 4);
  const height = Math.ceil(texels / DATA_TEXTURE_WIDTH);
  const padded = new Float32Array(DATA_TEXTURE_WIDTH * height * 4);
  padded.set(data);
  const tex = gl.createTexture();
  if (!tex) throw new GLError('Failed to allocate texture');
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, DATA_TEXTURE_WIDTH, height, 0, gl.RGBA, gl.FLOAT, padded);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return tex;
}

/** A float render target. */
export class RenderTarget {
  readonly texture: WebGLTexture;
  readonly framebuffer: WebGLFramebuffer;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    readonly width: number,
    readonly height: number,
  ) {
    const tex = gl.createTexture();
    const fb = gl.createFramebuffer();
    if (!tex || !fb) throw new GLError('Failed to allocate render target');
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, height, 0, gl.RGBA, gl.FLOAT, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      throw new GLError(`Float framebuffer incomplete (status 0x${status.toString(16)})`);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    // Never leave the attachment bound on a sampler unit: that is a feedback loop waiting to happen.
    gl.bindTexture(gl.TEXTURE_2D, null);
    this.texture = tex;
    this.framebuffer = fb;
  }

  bind(): void {
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, this.framebuffer);
    this.gl.viewport(0, 0, this.width, this.height);
  }

  clear(): void {
    this.bind();
    this.gl.clearColor(0, 0, 0, 1);
    this.gl.clear(this.gl.COLOR_BUFFER_BIT);
  }

  dispose(): void {
    this.gl.deleteTexture(this.texture);
    this.gl.deleteFramebuffer(this.framebuffer);
  }
}
