import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {mkdtemp, writeFile, rm, copyFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {validateAudioBlocks, resolveAudioBlocks, type AudioBlock} from "./audio-document";
const run = promisify(execFile);
/** Decode each retained region and concatenate PCM, keeping memory bounded for long recordings. */
export async function renderAudioEdit(input: string, blocks: AudioBlock[], duration: number, output: string, ffmpeg = "ffmpeg") {
  validateAudioBlocks(blocks, duration);
  if ([input, ...blocks.flatMap(b => b.sourcePath ? [b.sourcePath] : [])].some(source => path.resolve(source) === path.resolve(output))) throw new Error("不能覆盖原始音频。");
  const regions: AudioBlock[] = [];
  for (const b of resolveAudioBlocks(blocks, duration)) {
    const previous = regions.at(-1);
    if (previous && previous.kind === "silence" && b.kind === "silence") previous.end += b.end;
    else if (previous && previous.kind !== "silence" && b.kind !== "silence" && (previous.sourcePath ?? input) === (b.sourcePath ?? input) && Math.abs(previous.end - b.start) < 1e-9) previous.end = b.end;
    else regions.push({...b});
  }
  blocks = regions;
  const dir = await mkdtemp(path.join(tmpdir(), "replay-audio-edit-"));
  try {
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      const source = b.kind === "silence"
        ? ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo"]
        : ["-ss", String(b.start), "-i", b.sourcePath ?? input, "-map", "0:a:0", "-vn"];
      await run(ffmpeg, ["-v", "error", "-nostdin", "-y", ...source, "-t", String(b.end-b.start), "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le", path.join(dir, `${i}.wav`)], {maxBuffer: 4*1024*1024});
    }
    await writeFile(path.join(dir, "list.txt"), blocks.map((_, i) => `file '${i}.wav'`).join("\n"));
    const encoded = path.join(dir, "edited.wav");
    await run(ffmpeg, ["-v", "error", "-nostdin", "-y", "-f", "concat", "-safe", "1", "-i", path.join(dir, "list.txt"), "-c:a", "pcm_s16le", encoded], {maxBuffer: 4*1024*1024});
    await copyFile(encoded, output);
  } finally { await rm(dir, {recursive: true, force: true}); }
}

/** Persist browser MediaRecorder data as a seekable WAV before creating tokens. */
export async function saveRecordedAudio(bytes: Uint8Array, output: string, ffmpeg = "ffmpeg") {
  if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > 64*1024*1024) throw new Error("录音为空或超过 64 MB，请分段录制。");
  const dir = await mkdtemp(path.join(tmpdir(), "replay-recording-"));
  try {
    const input = path.join(dir, "capture.webm"); await writeFile(input, bytes);
    await run(ffmpeg, ["-v","error","-nostdin","-y","-i",input,"-vn","-ar","48000","-ac","2","-c:a","pcm_s16le",output], {maxBuffer:4*1024*1024});
  } finally {await rm(dir,{recursive:true,force:true});}
}
