import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { parseSrt } from "./subtitles";
import type { SpeechTranscriptionOptions, SubtitleTrack } from "./types";

const execFileAsync = promisify(execFile);

export const transcribeMedia = async (
  inputPath: string,
  options: SpeechTranscriptionOptions,
): Promise<SubtitleTrack> => {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "replaymod-speech-"));
  const audioPath = path.join(temporaryDirectory, "speech.wav");
  const outputPrefix = path.join(temporaryDirectory, "subtitles");
  try {
    await execFileAsync(options.ffmpegPath ?? "ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y", "-i", inputPath,
      "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", audioPath,
    ], { maxBuffer: 16 * 1024 * 1024 });
    await execFileAsync(options.whisperPath, [
      "-m", options.modelPath,
      "-f", audioPath,
      "-l", options.language ?? "auto",
      "-sns",
      "-nth", "0.5",
      ...(options.vadModelPath ? [
        "--vad",
        "-vm", options.vadModelPath,
        "-vt", "0.6",
        "-vspd", "300",
      ] : []),
      "-osrt",
      "-of", outputPrefix,
    ], { maxBuffer: 64 * 1024 * 1024 });
    const cues = parseSrt(await readFile(`${outputPrefix}.srt`, "utf8"));
    return {
      kind: "subtitle",
      language: options.language ?? "auto",
      source: "speech-recognition",
      cues,
    };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
};
