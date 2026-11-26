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
  const {findTransparentVideoEncoder, findCompositeVideoEncoder, findHardwareCompositeEncoder} = load('packages/media/src/raw-video.ts');
  const {OfflineExportManager} = load('apps/desktop/src/main/offlineExport.ts');
  const encoder = await findTransparentVideoEncoder();
  assert(encoder, 'A libvpx-vp9 FFmpeg binary is required for this explicit encoder gate');
  if (process.platform === 'win32') {
    assert.equal(await findTransparentVideoEncoder(`"${path.dirname(encoder)}"`), encoder);
  }
  const directory = await fsp.mkdtemp(path.join(tmpdir(), 'replay-offline-'));
  const manager = new OfflineExportManager(), options = {width: 16, height: 16, fps: 24, bitrate: 1000000, start: 1000, end: 1125, segmentMilliseconds: 1000};
  const rgba = (r, g, b, a) => {const pixels = new Uint8Array(16 * 16 * 4); for (let i = 0; i < pixels.length; i += 4) pixels.set([r, g, b, a], i); return pixels;};
  try {
    const destination = path.join(directory, 'alpha.webm');
    const session = manager.begin(1, {...options, cpuUsed: 2}, destination, encoder);
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
    const qualityPath = path.join(directory, 'constant-quality.webm');
    assert.throws(() => manager.begin(1, {...options, crf: 30}, qualityPath, encoder), /rate control/);
    const quality = manager.begin(1, {...options, bitrate: 0, crf: 30, cpuUsed: 2}, qualityPath, encoder);
    for (let index = 0; index < frames.length; index++) {
      await manager.write(1, quality.id, 0, index, frames[index]);
    }
    await manager.finishSegment(1, quality.id, 0);
    manager.complete(1, quality.id);
    const qualityDecoded = await exec(encoder, ['-v', 'error', '-c:v', 'libvpx-vp9', '-i', qualityPath, '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'], {encoding: 'buffer', maxBuffer: 1024 * 1024});
    assert.equal(qualityDecoded.stdout.length, frames.length * 1024);
    const qualityAlpha = frames.map((_, index) => qualityDecoded.stdout[index * 1024 + (8 * 16 + 8) * 4 + 3]);
    assert(qualityAlpha.every((value, index) => Math.abs(value - [255, 128, 0][index]) <= 2), 'Constant quality preserves alpha');
    const estimate = manager.beginEstimate(1, {...options, segmentMilliseconds: undefined, bitrate: 0, crf: 30, cpuUsed: 2}, encoder);
    for (let index = 0; index < frames.length; index++) {
      await manager.write(1, estimate.id, 0, index, frames[index]);
    }
    const estimateResult = await manager.finishSegment(1, estimate.id, 0);
    assert.equal(estimateResult.sampleBytes, (await fsp.stat(qualityPath)).size);
    assert.equal(manager.complete(1, estimate.id).length, 0);
    assert(!(await fsp.readdir(tmpdir())).some(name => name.includes(estimate.id)), 'Estimate leaves no output file');
    const {OfflineFramePlan} = load('apps/desktop/src/shared/overlayExport.ts');
    assert.equal(new OfflineFramePlan({...options, segmentMilliseconds: undefined, end: 901_001}).segmentCount, 1);
    const h264 = await findCompositeVideoEncoder('h264');
    if (h264) {
      const source = path.join(directory, 'source.mp4');
      await exec(h264, ['-v', 'error', '-f', 'lavfi', '-i', 'color=blue:s=16x16:r=24:d=1',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
        '-vf', "drawbox=color=red:t=fill:enable='lt(t,0.25)'", '-c:v', 'libx264', '-c:a', 'aac', source]);
      for (const codec of ['h264', 'hevc']) {
        const compositeEncoder = codec === 'h264' ? h264 : await findCompositeVideoEncoder(codec);
        if (!compositeEncoder) continue;
        const output = path.join(directory, `composite-${codec}.mp4`);
        const composite = manager.begin(1, {...options, bitrate: 0, crf: 18}, output, compositeEncoder, false,
          {sourcePath: source, offsetSeconds: .25, codec, overlayTop: 8});
        for (let index = 0; index < frames.length; index++) {
          await manager.write(1, composite.id, 0, index, frames[index].subarray(16 * 8 * 4));
        }
        await manager.finishSegment(1, composite.id, 0);
        assert.deepEqual(Array.from(manager.complete(1, composite.id)), [output]);
        const result = await exec(probe, ['-v', 'error', '-show_entries', 'stream=codec_name,duration,nb_frames', '-of', 'json', output]);
        const [video, audio] = JSON.parse(result.stdout).streams;
        assert.equal(video.codec_name, codec);
        assert.equal(video.nb_frames, '3');
        assert.equal(audio.codec_name, 'aac');
        assert(Math.abs(Number(audio.duration) - .125) < .03, 'Audio is trimmed to the exported video duration');
        const decodedComposite = await exec(compositeEncoder, ['-v', 'error', '-i', output,
          '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], {encoding: 'buffer'});
        const center = index => [...decodedComposite.stdout.subarray(index * 768 + 408, index * 768 + 411)];
        assert(center(0)[0] > 200 && center(0)[2] < 20, 'Opaque overlay covers the source');
        assert(center(1)[1] > 70 && center(1)[2] > 70, 'Semi-transparent overlay blends with the source');
        assert(center(2)[2] > 200 && center(2)[0] < 20, 'Transparent overlay reveals the source');
        assert(decodedComposite.stdout[2] > 200 && decodedComposite.stdout[0] < 20, 'Source pixels above the cropped overlay remain visible');
        console.log(`Composite export passed: ${codec}, source seek, AAC trimming, and alpha blending.`);
        if (process.env.REPLAY_CHECK_VIDEOTOOLBOX === '1') {
          const hardwareOptions = {...options, width: 128, height: 128, bitrate: 0, crf: 26};
          const hardwareQuality = 70;
          const hardwareEncoder = await findHardwareCompositeEncoder(codec, hardwareOptions, hardwareQuality);
          assert(hardwareEncoder, `Expected available hardware encoding for ${codec}`);
          const hardwareOutput = path.join(directory, `hardware-${codec}.mp4`);
          const hardware = manager.begin(1, hardwareOptions, hardwareOutput, hardwareEncoder, false,
            {sourcePath: source, offsetSeconds: .25, codec, hardware: true, hardwareQuality, overlayTop: 70});
          assert.equal(hardware.videoToolbox, true);
          const overlay = new Uint8Array(128 * (128 - 70) * 4);
          for (let index = 0; index < overlay.length; index += 4) overlay.set([0, 255, 0, 128], index);
          for (let index = 0; index < 3; index++) await manager.write(1, hardware.id, 0, index, overlay);
          await manager.finishSegment(1, hardware.id, 0);
          manager.complete(1, hardware.id);
          const report = await exec(probe, ['-v', 'error', '-show_entries', 'stream=codec_name,nb_frames', '-of', 'json', hardwareOutput]);
          const [hardwareVideo, hardwareAudio] = JSON.parse(report.stdout).streams;
          assert.equal(hardwareVideo.codec_name, codec);
          assert.equal(hardwareVideo.nb_frames, '3');
          assert.equal(hardwareAudio.codec_name, 'aac');
          console.log(`VideoToolbox composite export passed: ${codec}.`);
        }
      }
    }
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
    const segmented = manager.begin(3, {...options, cpuUsed: 5, fps: 2, start: 0, end: 2500}, path.join(directory, 'segments.webm'), encoder);
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
