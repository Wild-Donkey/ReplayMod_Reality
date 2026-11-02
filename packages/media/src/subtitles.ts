import type { TimedTextCue } from "./types";

const pad = (value: number, width = 2) => String(value).padStart(width, "0");

const formatTimestamp = (seconds: number, separator: "," | ".") => {
  const milliseconds = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const remainingSeconds = Math.floor((milliseconds % 60_000) / 1000);
  return `${pad(hours)}:${pad(minutes)}:${pad(remainingSeconds)}${separator}${pad(milliseconds % 1000, 3)}`;
};

const orderedCues = (cues: readonly TimedTextCue[]) =>
  [...cues]
    .filter((cue) => cue.text.trim() && cue.endTimeSeconds > cue.startTimeSeconds)
    .sort((left, right) => left.startTimeSeconds - right.startTimeSeconds);

const parseTimestamp = (value: string): number | null => {
  const match = /^(\d+):(\d{2}):(\d{2})[,.](\d{3})$/.exec(value.trim());
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 +
    Number(match[3]) + Number(match[4]) / 1000;
};

export const parseSrt = (text: string): TimedTextCue[] =>
  text.replace(/\r/g, "").trim().split(/\n{2,}/).flatMap((block) => {
    const lines = block.split("\n");
    if (/^\d+$/.test(lines[0]?.trim() ?? "")) lines.shift();
    const timing = lines.shift()?.match(
      /^(\d+:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d+:\d{2}:\d{2}[,.]\d{3})/,
    );
    if (!timing) return [];
    const startTimeSeconds = parseTimestamp(timing[1]);
    const endTimeSeconds = parseTimestamp(timing[2]);
    const cueText = lines.join("\n").trim();
    return startTimeSeconds !== null && endTimeSeconds !== null && cueText
      ? [{ startTimeSeconds, endTimeSeconds, text: cueText }]
      : [];
  });

export const serializeSrt = (cues: readonly TimedTextCue[]): string =>
  orderedCues(cues)
    .map(
      (cue, index) =>
        `${index + 1}\n${formatTimestamp(cue.startTimeSeconds, ",")} --> ${formatTimestamp(cue.endTimeSeconds, ",")}\n${cue.text.trim()}\n`,
    )
    .join("\n");

export const serializeWebVtt = (cues: readonly TimedTextCue[]): string => {
  const body = orderedCues(cues)
    .map(
      (cue) =>
        `${formatTimestamp(cue.startTimeSeconds, ".")} --> ${formatTimestamp(cue.endTimeSeconds, ".")}\n${cue.text.trim()}`,
    )
    .join("\n\n");
  return `WEBVTT\n\n${body}${body ? "\n" : ""}`;
};
