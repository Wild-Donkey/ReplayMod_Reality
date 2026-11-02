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
