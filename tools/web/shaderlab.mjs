// Tries scaling shaders outside the emulator: compiles each one as the web build
// does (GLSL ES 3.00 on WebGL2, with the emulator's own vertex shader), says what
// the compiler said, and draws a picture through it.
//
//   node tools/web/shaderlab.mjs --image frame.png [--scale 3 | --size 600x709] [--filter nearest|linear]
//                                [--software | --browser firefox] [--out DIR] shader.frag...
//
//   --image    the picture to enlarge, for instance a guest screenshot from explore.mjs (/shot)
//   --scale    output size as a multiple of the picture (default 3; fractions are fine)
//   --size     or the output size itself
//   --filter   the texture's filter, as the emulator's nearestNeighborFiltering sets it (default linear)
//   --software no GPU flags: SwiftShader, which is what CI renders with
//   --browser  chrome (default) or firefox (Playwright's build)
//   --out      where <shader name>.png goes (default: the current folder)
//
// The emulator's graphics thread does not show its log on the page, so a shader
// that fails to compile there fails silently: the previous one stays. This tool
// is where the compiler's message can be read, and where a shader can be changed
// and looked at without rebuilding the emulator's data file.
import { chromium, firefox } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const flags = {};
const files = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--software') flags.software = true;
  else if (argv[i].startsWith('--')) flags[argv[i].slice(2)] = argv[++i];
  else files.push(argv[i]);
}
if (!flags.image || !files.length) {
  console.error('usage: shaderlab.mjs --image frame.png [--scale N | --size WxH] [--filter nearest|linear] [--software | --browser firefox] [--out DIR] shader.frag...');
  process.exit(2);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const vertexFile = [process.env.ARCADE_ROOT, process.env.ARCADE_MAIN, path.join(here, '..', '..')].filter(Boolean)
  .map((root) => path.join(root, 'eka2l1', 'src', 'emu', 'drivers', 'resources', 'gles', 'sprite_norm.vert')).find((file) => fs.existsSync(file));
if (!vertexFile) { console.error('no eka2l1 checkout with resources/gles/sprite_norm.vert'); process.exit(1); }
const vertex = fs.readFileSync(vertexFile, 'utf8');

const image = PNG.sync.read(fs.readFileSync(flags.image));
const [width, height] = flags.size ? flags.size.split('x').map(Number)
  : [Math.round(image.width * Number(flags.scale || 3)), Math.round(image.height * Number(flags.scale || 3))];
const outDir = path.resolve(flags.out || '.');
fs.mkdirSync(outDir, { recursive: true });

const TOOLCHAIN = process.env.EKA2L1_TOOLCHAIN || '';
const root = path.join(TOOLCHAIN, 'chrome', 'chrome');
const exe = TOOLCHAIN && fs.existsSync(root) ? path.join(root, fs.readdirSync(root).sort().pop(), 'chrome-linux64', 'chrome') : undefined;
const browser = flags.browser === 'firefox' ? await firefox.launch({ headless: true })
  : await chromium.launch({ executablePath: exe, headless: true,
    args: flags.software ? [] : ['--use-gl=angle', '--use-angle=gl-egl', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage();
await page.goto('about:blank');

let failed = 0;
for (const file of files) {
  // The driver puts the version line in front of an upscale shader.
  const fragment = `#version 300 es\n${fs.readFileSync(file, 'utf8')}`;
  const result = await page.evaluate(({ vertex, fragment, pixels, source, target, nearest }) => {
    const canvas = document.createElement('canvas');
    canvas.width = target[0]; canvas.height = target[1];
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: true });
    const compile = (type, text) => {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, text); gl.compileShader(shader);
      return { shader, ok: gl.getShaderParameter(shader, gl.COMPILE_STATUS), log: gl.getShaderInfoLog(shader) || '' };
    };
    const vs = compile(gl.VERTEX_SHADER, vertex);
    const fs = compile(gl.FRAGMENT_SHADER, fragment);
    if (!vs.ok || !fs.ok) return { error: `does not compile: ${(fs.log || vs.log).trim()}` };
    const program = gl.createProgram();
    gl.attachShader(program, vs.shader); gl.attachShader(program, fs.shader); gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return { error: `does not link: ${gl.getProgramInfoLog(program)}` };
    gl.useProgram(program);

    // The picture as the screen texture, its first row at texture coordinate 0.
    gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, source[0], source[1], 0, gl.RGBA, gl.UNSIGNED_BYTE, Uint8Array.from(atob(pixels), (c) => c.charCodeAt(0)));
    const filter = nearest ? gl.NEAREST : gl.LINEAR;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // A quad over the whole canvas, as the driver's draw_bitmap makes it: the
    // unit square, the model matrix its size, the projection the swapchain's.
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 1, 0, 1, 1, 0, 1, 0, 0, 0, 0, 0, 1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);
    const [w, h] = target;
    const uniform = (name) => gl.getUniformLocation(program, name);
    gl.uniformMatrix4fv(uniform('u_model'), false, [w, 0, 0, 0, 0, h, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    // The vertex shader turns y over, so this puts texture coordinate 0 at the top.
    gl.uniformMatrix4fv(uniform('u_proj'), false, [2 / w, 0, 0, 0, 0, 2 / h, 0, 0, 0, 0, -1, 0, -1, -1, 0, 1]);
    gl.uniform4f(uniform('u_color'), 255, 255, 255, 255);
    gl.uniform2f(uniform('u_texelDelta'), 1 / source[0], 1 / source[1]);
    gl.uniform2f(uniform('u_pixelDelta'), 1 / w, 1 / h);
    gl.uniform1i(uniform('u_tex'), 0);
    gl.viewport(0, 0, w, h);
    gl.clearColor(1, 0, 1, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 3, 1]), gl.STATIC_DRAW);
    // Reading one pixel back waits for the drawing, so the time is the
    // shader's. The first draw is left out: it includes preparing the shader.
    const pixel = new Uint8Array(4);
    const draw = () => { gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel); };
    draw();
    const start = performance.now();
    for (let i = 0; i < 10; i++) draw();
    return { ms: (performance.now() - start) / 10, log: fs.log.trim(), png: canvas.toDataURL('image/png').split(',')[1] };
  }, { vertex, fragment, pixels: image.data.toString('base64'), source: [image.width, image.height], target: [width, height], nearest: flags.filter === 'nearest' });

  const name = path.basename(file, path.extname(file));
  if (result.error || !result.png) {
    failed++;
    console.log(`${name}: ${result.error}`);
    continue;
  }
  const target = path.join(outDir, `${name}.png`);
  fs.writeFileSync(target, Buffer.from(result.png, 'base64'));
  console.log(`${name}: ${width}x${height}, ${result.ms.toFixed(1)} ms a frame -> ${target}${result.log ? ` (compiler: ${result.log})` : ''}`);
}
await browser.close();
process.exit(failed ? 1 : 0);
