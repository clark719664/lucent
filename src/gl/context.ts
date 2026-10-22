import { chunkNameForId, type ShaderSources } from './preprocess';

export class GLError extends Error {}

export interface GLCapabilities {
  gl: WebGL2RenderingContext;
  maxTextureSize: number;
  maxArrayLayers: number;
  /** Bilinear filtering of RGB(A)32F textures (OES_texture_float_linear). */
  floatLinear: boolean;
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
  return {
    gl,
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
    maxArrayLayers: gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS) as number,
    floatLinear: gl.getExtension('OES_texture_float_linear') !== null,
    renderer,
  };
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
  i2(name: string, x: number, y: number) { this.gl.uniform2i(this.loc(name), x, y); }
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

export interface TextureOptions {
  internalFormat: number;
  format: number;
  type: number;
  filter?: number;
  wrapS?: number;
  wrapT?: number;
}

/** Allocates a 2D texture, optionally filling it. */
export function createTexture(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
  opts: TextureOptions,
  data: ArrayBufferView | null = null,
): WebGLTexture {
  const tex = gl.createTexture();
  if (!tex) throw new GLError('Failed to allocate texture');
  gl.bindTexture(gl.TEXTURE_2D, tex);
  const filter = opts.filter ?? gl.NEAREST;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, opts.wrapS ?? gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, opts.wrapT ?? gl.CLAMP_TO_EDGE);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, opts.internalFormat, width, height, 0, opts.format, opts.type, data);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return tex;
}

/** A float render target with one or more colour attachments (MRT). */
export class RenderTarget {
  readonly textures: WebGLTexture[];
  readonly framebuffer: WebGLFramebuffer;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    readonly width: number,
    readonly height: number,
    formats: number[] = [gl.RGBA32F],
  ) {
    const fb = gl.createFramebuffer();
    if (!fb) throw new GLError('Failed to allocate render target');
    this.textures = formats.map((f) =>
      createTexture(gl, width, height, {
        internalFormat: f,
        format: f === gl.R32F ? gl.RED : gl.RGBA,
        type: f === gl.RGBA16F ? gl.HALF_FLOAT : gl.FLOAT,
      }),
    );
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    this.textures.forEach((tex, i) => gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, tex, 0));
    gl.drawBuffers(this.textures.map((_, i) => gl.COLOR_ATTACHMENT0 + i));
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      throw new GLError(`Float framebuffer incomplete (status 0x${status.toString(16)})`);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.framebuffer = fb;
  }

  get texture(): WebGLTexture {
    return this.textures[0]!;
  }

  /** Binds for drawing into the bottom-left `width × height` region (the whole target by default). */
  bind(width = this.width, height = this.height): void {
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, this.framebuffer);
    this.gl.viewport(0, 0, width, height);
  }

  clear(): void {
    this.bind();
    this.gl.clearColor(0, 0, 0, 0);
    this.gl.clear(this.gl.COLOR_BUFFER_BIT);
  }

  dispose(): void {
    for (const t of this.textures) this.gl.deleteTexture(t);
    this.gl.deleteFramebuffer(this.framebuffer);
  }
}

/**
 * Builds a `size × size × layers` texture array by drawing each image into its
 * layer through `resample` (a fullscreen program sampling unit 0). Images are
 * uploaded mipmapped so downscaling filters properly. sRGB arrays decode on
 * fetch and re-encode on write, so filtering happens in linear space.
 */
export function createTextureArray(
  gl: WebGL2RenderingContext,
  images: readonly TexImageSource[],
  size: number,
  srgb: boolean,
  resample: Program,
  vao: WebGLVertexArrayObject,
): WebGLTexture {
  const internal = srgb ? gl.SRGB8_ALPHA8 : gl.RGBA8;
  const layers = Math.max(1, images.length);
  const array = gl.createTexture();
  const fb = gl.createFramebuffer();
  if (!array || !fb) throw new GLError('Failed to allocate texture array');
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, array);
  gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, internal, size, size, layers);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.REPEAT);
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);

  resample.use();
  resample.i1('uSource', 0);
  resample.f1('uSize', size);
  gl.bindVertexArray(vao);
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
  gl.viewport(0, 0, size, size);
  gl.activeTexture(gl.TEXTURE0);
  images.forEach((img, layer) => {
    const src = gl.createTexture();
    if (!src) throw new GLError('Failed to allocate texture');
    gl.bindTexture(gl.TEXTURE_2D, src);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, array, 0, layer);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.deleteTexture(src);
  });
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fb);
  return array;
}
