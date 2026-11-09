const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const {tmpdir} = require('node:os');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('typescript');
const exec = promisify(execFile), cache = new Map();
function load(file) {
  file = path.resolve(file);
  if (cache.has(file)) return cache.get(file).exports;
  const mod = {exports: {}}; cache.set(file, mod);
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true}}).outputText;
  vm.runInNewContext(code, {exports: mod.exports, module: mod, require: name => name.startsWith('.') ? load(path.resolve(path.dirname(file), name) + '.ts') : require(name), process, Buffer, console, Uint8Array, ArrayBuffer});
  return mod.exports;
}
(async () => {
  const {findTransparentVideoEncoder} = load('packages/media/src/raw-video.ts');
  const {OfflineExportManager} = load('apps/desktop/src/main/offlineExport.ts');
  const encoder = await findTransparentVideoEncoder();
  assert(encoder, 'A libvpx-vp9 FFmpeg binary is required for this explicit encoder gate');
  const directory = await fsp.mkdtemp(path.join(tmpdir(), 'replay-offline-'));
  const manager = new OfflineExportManager(), options = {width: 16, height: 16, fps: 24, bitrate: 1000000, start: 1000, end: 1125, segmentMilliseconds: 1000};
  const rgba = (r, g, b, a) => {const pixels = new Uint8Array(16 * 16 * 4); for (let i = 0; i < pixels.length; i += 4) pixels.set([r, g, b, a], i); return pixels;};
  try {
    const destination = path.join(directory, 'alpha.webm');
    const session = manager.begin(1, options, destination, encoder);
    assert.throws(() => manager.begin(1, options, destination, encoder), /already running/);
    await assert.rejects(manager.write(2, session.id, 0, 0, rgba(255, 0, 0, 255)), /Unknown/);
    await assert.rejects(manager.write(1, session.id, 0, 1, rgba(255, 0, 0, 255)), /sequential/);
    await assert.rejects(manager.write(1, session.id, 0, 0, new Uint8Array(1)), /size/);
    await assert.rejects(manager.finishSegment(1, session.id, 0), /incomplete/);
    const frames = [rgba(255, 0, 0, 255), rgba(0, 255, 0, 128), rgba(0, 0, 255, 0)];
    for (let index = 0; index < frames.length; index++) {
      await new Promise(resolve => setTimeout(resolve, 17 + index * 13));
      await manager.write(1, session.id, 0, index, frames[index]);
    }
    const saved = await manager.finishSegment(1, session.id, 0);
    assert.equal(saved.frames, 3); assert.equal(saved.path, destination);
    assert.equal(manager.complete(1, session.id)[0], destination);
    const probe = path.join(path.dirname(encoder), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
    const {stdout} = await exec(probe, ['-v', 'error', '-count_frames', '-show_entries', 'stream=nb_read_frames,avg_frame_rate:stream_tags=alpha_mode', '-of', 'json', destination]);
    const stream = JSON.parse(stdout).streams[0];
    assert.equal(stream.nb_read_frames, '3'); assert.equal(stream.avg_frame_rate, '24/1');
    assert.equal(stream.tags.alpha_mode, '1');
    const decoded = await exec(encoder, ['-v', 'error', '-c:v', 'libvpx-vp9', '-i', destination, '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'], {encoding: 'buffer', maxBuffer: 1024 * 1024});
    assert.equal(decoded.stdout.length, 16 * 16 * 4 * 3);
    const pixels = [0, 1, 2].map(index => [...decoded.stdout.subarray(index * 1024 + (8 * 16 + 8) * 4, index * 1024 + (8 * 16 + 8) * 4 + 4)]);
    assert(pixels[0][0] > 230 && pixels[0][1] < 20 && pixels[0][3] > 250, 'First encoded frame contains the prepared composition');
    assert(pixels[1][1] > 230 && Math.abs(pixels[1][3] - 128) <= 2, 'Partial alpha survives VP9 encoding');
    assert(pixels[2][3] <= 2, 'Transparent pixels remain transparent');
    const original = await fsp.readFile(destination);
    const collision = manager.begin(1, {...options, start: 0, end: 41}, destination, encoder);
    await manager.write(1, collision.id, 0, 0, frames[1]);
    const renamed = await manager.finishSegment(1, collision.id, 0);
    assert.notEqual(renamed.path, destination); manager.complete(1, collision.id);
    assert.deepEqual(await fsp.readFile(destination), original, 'Existing files are never overwritten');
    const cancellation = manager.begin(1, {...options, end: 2000}, path.join(directory, 'cancel.webm'), encoder);
    await manager.write(1, cancellation.id, 0, 0, frames[0]); await manager.cancel(1, cancellation.id);
    assert(!(await fsp.readdir(directory)).some(name => name.includes('.part.') || name === 'cancel.webm'));
    const missing = manager.begin(1, {...options, start: 0, end: 41}, path.join(directory, 'failed.webm'), path.join(directory, 'missing-ffmpeg'));
    await assert.rejects(manager.write(1, missing.id, 0, 0, frames[0]));
    assert(!(await fsp.readdir(directory)).some(name => name.includes('.part.') || name === 'failed.webm'));
    const segmented = manager.begin(3, {...options, fps: 2, start: 0, end: 2500}, path.join(directory, 'segments.webm'), encoder);
    assert.equal(segmented.segmentCount, 3);
    for (let segment = 0; segment < 3; segment++) {
      const count = segment === 2 ? 1 : 2;
      for (let index = 0; index < count; index++) await manager.write(3, segmented.id, segment, index, frames[segment]);
      const part = await manager.finishSegment(3, segmented.id, segment); assert.equal(part.frames, count);
    }
    assert.equal(manager.complete(3, segmented.id).length, 3); assert.equal(manager.active, false);
    console.log('Offline export passed: actual VP9 CFR frames, delayed rendering, first-frame content, full/partial alpha, ownership, order, cancellation, missing encoder and collision preservation.', {encoder, pixels});
  } finally {await manager.cancelAll(); await fsp.rm(directory, {recursive: true, force: true});}
})().catch(error => {console.error(error); process.exitCode = 1;});
