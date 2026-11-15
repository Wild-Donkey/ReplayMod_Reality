import type {TimedTextCue} from "./types";

/** Every occurrence has its own id; copied tokens may refer to the same source range. */
export interface AudioBlock {
  id: string;
  sourcePath?: string;
  sourceDuration?: number;
  kind?: "speech" | "silence" | "extension";
  direction?: "previous" | "next";
  level?: "phrase" | "word" | "token";
  start: number;
  end: number;
  text: string;
}
export interface AudioDocument {
  sourcePath: string;
  sourceName: string;
  duration: number;
  blocks: AudioBlock[];
}
export const AUDIO_TOKEN_MIME = "application/x-replaymod-audio-tokens+json";
export const audioBlockDuration = (b: AudioBlock) => b.end - b.start;
export const audioSequenceDuration = (blocks: AudioBlock[]) => blocks.reduce((t, b) => t + audioBlockDuration(b), 0);
export function validateAudioBlocks(blocks: AudioBlock[], duration: number, allowEmpty = false): void {
  if (!Array.isArray(blocks) || (!allowEmpty && !blocks.length) || blocks.length > 20000) throw new Error("请保留至少一个声音 token（最多 20000 个）。");
  const ids = new Set<string>();
  for (const b of blocks) {
    if (!b || typeof b.id !== "string" || !b.id || ids.has(b.id) || (b.sourcePath !== undefined && (typeof b.sourcePath !== "string" || !b.sourcePath || !Number.isFinite(b.sourceDuration) || b.sourceDuration! <= 0)) || typeof b.text !== "string" || b.text.length > 10000 || (b.kind !== undefined && b.kind !== "speech" && b.kind !== "silence" && b.kind !== "extension") || !Number.isFinite(b.start) || !Number.isFinite(b.end) || b.start < 0 || b.end <= b.start || ((b.kind === "silence" || b.kind === "extension") ? b.start !== 0 || b.end > 3600 || (b.kind === "extension" && b.direction !== "previous" && b.direction !== "next") : b.end > (b.sourcePath ? b.sourceDuration ?? 0 : duration) + .0001)) throw new Error("声音 token 或时间范围无效。");
    ids.add(b.id);
  }
  if (!allowEmpty) resolveAudioBlocks(blocks, duration);
  if (audioSequenceDuration(blocks) > 86400) throw new Error("剪辑结果不能超过 24 小时。");
}
export function silenceSeconds(text: string): number | null {
  const match = /^\[?\s*(\d+(?:\.\d+)?|\.\d+)\s*(?:s|秒)\s*\]?$/i.exec(text.trim());
  const seconds = match ? Number(match[1]) : 0;
  return seconds >= .001 && seconds <= 3600 ? seconds : null;
}
export function silenceBlock(seconds: number, id: string): AudioBlock {
  if (!Number.isFinite(seconds) || seconds < .001 || seconds > 3600) throw new Error("静音时长应在 0.001–3600 秒之间。");
  return {id, kind: "silence", start: 0, end: seconds, text: `${seconds}s`};
}
export function encodeAudioTokens(sourcePath: string, blocks: AudioBlock[]) {
  return JSON.stringify({version: 1, sourcePath, tokens: blocks});
}
export function decodeAudioTokens(value: string, sourcePath: string, duration: number, newId: () => string): AudioBlock[] {
  if (value.length > 4 * 1024 * 1024) throw new Error("粘贴的 token 序列过长。");
  const data = JSON.parse(value);
  if (data.version !== 1 || !Array.isArray(data.tokens)) throw new Error("剪贴板中没有可用的声音 token 序列。");
  if (data.sourcePath !== sourcePath && data.tokens.some((t: AudioBlock) => t.kind !== "silence" && t.kind !== "extension")) throw new Error("这些语音 token 来自另一个素材，请在原素材的编辑页粘贴。");
  const blocks: AudioBlock[] = data.tokens.map((b: AudioBlock) => ({id: newId(), sourcePath: b.sourcePath, sourceDuration: b.sourceDuration, kind: b.kind, direction: b.direction, level: b.level, start: b.start, end: b.end, text: b.text}));
  validateAudioBlocks(blocks, duration, true);
  return blocks;
}
export function audioOutputCues(blocks: AudioBlock[]) {
  let time = 0;
  return blocks.flatMap(b => {
    const startTimeSeconds = time;
    time += audioBlockDuration(b);
    return b.kind === "silence" || b.kind === "extension" || !b.text.trim() ? [] : [{startTimeSeconds, endTimeSeconds: time, text: b.text}];
  });
}
/** Partition a region using locally recognized timestamps. Splitting never removes audio. */
export function refineAudioBlock(parent: AudioBlock, cues: readonly TimedTextCue[], newId: () => string): AudioBlock[] {
  const length = audioBlockDuration(parent);
  const words = cues.filter(c => c.text.trim() && c.startTimeSeconds < length && c.endTimeSeconds > 0 && c.endTimeSeconds > c.startTimeSeconds).sort((a,b) => a.startTimeSeconds - b.startTimeSeconds);
  if (words.length < 2) return [];
  const result: AudioBlock[] = [];
  let start = parent.start;
  for (let i = 0; i < words.length; i++) {
    const end = i === words.length-1 ? parent.end : Math.min(parent.end, parent.start + (words[i].endTimeSeconds + words[i+1].startTimeSeconds)/2);
    if (end <= start) continue;
    result.push({id: newId(), kind: "speech", sourcePath: parent.sourcePath, sourceDuration: parent.sourceDuration, level: parent.level === "word" || parent.level === "token" ? "token" : "word", start, end, text: words[i].text.trim()});
    start = end;
  }
  if (result.length < 2) return [];
  result[result.length-1].end = parent.end;
  return result;
}

export function audioControlLabel(b: AudioBlock): string {
  const t = Number(audioBlockDuration(b).toFixed(6));
  return b.kind === "extension" ? b.direction === "previous" ? `+${t}s` : `${t}s+` : `${t}s`;
}
export function audioControlBlock(value: string, id: string): AudioBlock | null {
  const clean = value.trim().replace(/^\[|\]$/g, "");
  const direction = clean.startsWith("+") ? "previous" : clean.endsWith("+") ? "next" : null;
  const seconds = silenceSeconds(direction === "previous" ? clean.slice(1) : direction === "next" ? clean.slice(0,-1) : clean);
  if (seconds === null) return null;
  return direction ? {id, kind: "extension", direction, start: 0, end: seconds, text: direction === "previous" ? `+${seconds}s` : `${seconds}s+`} : silenceBlock(seconds, id);
}
/** Resolve relative extensions at their current position, rather than baking in old neighbours. */
export function resolveAudioBlocks(blocks: AudioBlock[], duration: number): AudioBlock[] {
  const resolved = new Map<number, AudioBlock>(), visiting = new Set<number>();
  const resolve = (i: number): AudioBlock => {
    const cached = resolved.get(i); if(cached) return cached;
    const b = blocks[i];
    if (!b) throw new Error("延伸 token 需要相邻的原音 token。");
    if (visiting.has(i)) throw new Error("相向的延伸 token 之间没有原音，请调整顺序。");
    if (b.kind !== "extension") {resolved.set(i,b); return b;}
    visiting.add(i);
    const adjacent = resolve(i + (b.direction === "previous" ? -1 : 1));
    if (adjacent.kind === "silence") throw new Error(`${audioControlLabel(b)} 旁边是静音，无法从中取得原音。`);
    const length = audioBlockDuration(b);
    const start = b.direction === "previous" ? adjacent.end : adjacent.start - length;
    const end = b.direction === "previous" ? adjacent.end + length : adjacent.start;
    if(start < -1e-9 || end > (adjacent.sourcePath ? adjacent.sourceDuration ?? 0 : duration) + 1e-9) throw new Error(`${audioControlLabel(b)} 超出原音范围，请缩短延伸时长或移动 token。`);
    const audio: AudioBlock = {id: b.id, kind: "speech", sourcePath: adjacent.sourcePath, sourceDuration: adjacent.sourceDuration, level: "token", start: Math.max(0,start), end: Math.min(adjacent.sourceDuration ?? duration,end), text: ""};
    visiting.delete(i); resolved.set(i,audio); return audio;
  };
  return blocks.map((_,i) => resolve(i));
}
/** Start coarse, preserving untranscribed sound and gaps as selectable original-audio tokens. */
export function coarseAudioBlocks(cues: readonly TimedTextCue[], duration: number, newId: () => string): AudioBlock[] {
  const blocks: AudioBlock[] = []; let cursor = 0;
  for(const c of [...cues].sort((a,b) => a.startTimeSeconds-b.startTimeSeconds)) {
    const start = Math.max(cursor, c.startTimeSeconds), end = Math.min(duration,c.endTimeSeconds);
    if(end <= start) continue;
    if(start > cursor) blocks.push({id:newId(),kind:"speech",level:"token",start:cursor,end:start,text:""});
    blocks.push({id:newId(),kind:"speech",level:"phrase",start,end,text:c.text.trim()}); cursor=end;
  }
  if(cursor < duration) blocks.push({id:newId(),kind:"speech",level:"token",start:cursor,end:duration,text:""});
  return blocks;
}
