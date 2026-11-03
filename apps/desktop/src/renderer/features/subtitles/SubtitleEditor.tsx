import type { SubtitleTrack, TimedTextCue } from "../../../../../../packages/media/src";

interface SubtitleEditorProps {
  readonly track: SubtitleTrack | null;
  readonly busy: boolean;
  readonly status: string;
  readonly onChange: (track: SubtitleTrack) => void;
  readonly onClose: () => void;
  readonly onGenerate: () => void;
  readonly onSave: () => void;
}

const replaceCue = (
  track: SubtitleTrack,
  index: number,
  patch: Partial<TimedTextCue>,
): SubtitleTrack => ({
  ...track,
  cues: track.cues.map((cue, cueIndex) =>
    cueIndex === index ? { ...cue, ...patch } : cue),
});

export const SubtitleEditor = ({
  track,
  busy,
  status,
  onChange,
  onClose,
  onGenerate,
  onSave,
}: SubtitleEditorProps) => (
  <div className="subtitle-editor-backdrop" role="presentation" onMouseDown={onClose}>
    <section
      className="subtitle-editor"
      role="dialog"
      aria-modal="true"
      aria-label="字幕轨编辑器"
      onMouseDown={(event) => event.stopPropagation()}
    >
      <header>
        <div>
          <span>谈话类时间压缩</span>
          <h1>可编辑字幕轨</h1>
        </div>
        <button type="button" onClick={onClose} aria-label="关闭">×</button>
      </header>
      <div className="subtitle-editor-toolbar">
        <button type="button" disabled={busy} onClick={onGenerate}>
          {busy ? "正在识别人声…" : track ? "重新生成" : "自动生成字幕"}
        </button>
        <button type="button" disabled={busy || !track} onClick={onSave}>
          保存 JSON + SRT
        </button>
        <span>{status || (track ? `${track.cues.length} 条字幕` : "尚未生成字幕")}</span>
      </div>
      <div className="subtitle-cue-header">
        <span>#</span><span>入点 / 出点（秒）</span><span>字幕文本</span><span />
      </div>
      <div className="subtitle-cues">
        {track?.cues.map((cue, index) => (
          <div className="subtitle-cue" key={`${index}-${cue.startTimeSeconds}`}>
            <span>{index + 1}</span>
            <div className="subtitle-times">
              <input
                type="number"
                min="0"
                step="0.01"
                value={cue.startTimeSeconds}
                onChange={(event) => onChange(replaceCue(track, index, {
                  startTimeSeconds: Number(event.target.value),
                }))}
              />
              <input
                type="number"
                min="0"
                step="0.01"
                value={cue.endTimeSeconds}
                onChange={(event) => onChange(replaceCue(track, index, {
                  endTimeSeconds: Number(event.target.value),
                }))}
              />
            </div>
            <textarea
              rows={2}
              value={cue.text}
              onChange={(event) => onChange(replaceCue(track, index, {
                text: event.target.value,
              }))}
            />
            <button
              className="subtitle-delete"
              type="button"
              aria-label={`删除第 ${index + 1} 条字幕`}
              onClick={() => onChange({
                ...track,
                cues: track.cues.filter((_, cueIndex) => cueIndex !== index),
              })}
            >删除</button>
          </div>
        ))}
        {!track && <div className="subtitle-empty">载入视频后，使用本地语音识别生成字幕。</div>}
      </div>
      {track && (
        <button
          className="subtitle-add"
          type="button"
          onClick={() => onChange({
            ...track,
            cues: [...track.cues, {
              startTimeSeconds: track.cues.at(-1)?.endTimeSeconds ?? 0,
              endTimeSeconds: (track.cues.at(-1)?.endTimeSeconds ?? 0) + 2,
              text: "",
            }],
          })}
        >+添加字幕</button>
      )}
    </section>
  </div>
);
