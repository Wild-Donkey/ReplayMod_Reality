import type {TimedTextCue} from "./types";
interface Token {text: string; offsets?: {from: number; to: number}; id: number}
/** Use Whisper token timestamps, retaining UTF-8 merged tokens and joining English subwords. */
export function parseWhisperWordCues(json: {transcription?: {tokens?: Token[]}[]}, mergeSubwords = true): TimedTextCue[] {
  const cues: {startTimeSeconds: number; endTimeSeconds: number; text: string}[] = [];
  let pending = "";
  for (const segment of json.transcription ?? []) {
    for (const token of segment.tokens ?? []) {
      if (!token.offsets || /^\[_.*\]$/.test(token.text) || !token.text.trim()) continue;
      const start = token.offsets.from / 1000, end = token.offsets.to / 1000;
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0) continue;
      const text = token.text.trim();
      const previous = cues.at(-1);
      if (end <= start) {if(previous) previous.text += text; else pending += text; continue;}
      if (mergeSubwords && previous && !/^\s/.test(token.text) && /^[a-zA-Z0-9'’.,!?;:]+$/.test(text) && /[a-zA-Z0-9'’]$/.test(previous.text)) {
        previous.text += text; previous.endTimeSeconds = Math.max(previous.endTimeSeconds, end);
      } else if (previous && /^[，。！？、；：,.!?;:]+$/.test(text)) {
        previous.text += text; previous.endTimeSeconds = Math.max(previous.endTimeSeconds, end);
      } else {cues.push({startTimeSeconds: start, endTimeSeconds: end, text: pending+text}); pending = "";}
    }
  }
  return cues;
}
