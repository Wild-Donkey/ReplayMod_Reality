import {SpaceGesture} from "./SpaceGesture";
import {Fragment, forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState} from "react";
import {AUDIO_TOKEN_MIME, audioBlockDuration, decodeAudioTokens, encodeAudioTokens, audioControlBlock, audioControlLabel, validateAudioBlocks, type AudioBlock} from "../../../../../../packages/media/src/audio-document";

type TokenSelection = {from: number; to: number};
export interface AudioTokenCanvasHandle {
  insertControl(value: string): void;
  selectAll(): void;
  copyAll(): void;
}
interface Props {
  tokens: AudioBlock[];
  sourcePath: string;
  duration: number;
  disabled: boolean;
  playing: string | null;
  onPlayback(index: number): void;
  onRecordStart(index: number): void;
  onRecordEnd(): void;
  onChange(tokens: AudioBlock[]): void;
  onInspect(index: number): void;
  onSplit(index: number): void;
  onUndo(redo: boolean): void;
  onStatus(message: string): void;
}
const uid = () => crypto.randomUUID();
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => ({"&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"}[c]!));

/** Atomic inline nodes retain the source ranges when selected, moved, or copied. */
export const AudioTokenCanvas = forwardRef<AudioTokenCanvasHandle, Props>(function AudioTokenCanvas({tokens, sourcePath, duration, disabled, playing, onPlayback, onRecordStart, onRecordEnd, onChange, onInspect, onSplit, onUndo, onStatus}, ref) {
  const root = useRef<HTMLDivElement>(null);
  const handlers = useRef({onPlayback,onRecordStart,onRecordEnd}); handlers.current = {onPlayback,onRecordStart,onRecordEnd};
  const gesture = useRef<SpaceGesture | null>(null);
  if(!gesture.current) gesture.current = new SpaceGesture({tap: index => handlers.current.onPlayback(index),start: index => handlers.current.onRecordStart(index),end: () => handlers.current.onRecordEnd()});
  useEffect(() => {
    const up = (event: KeyboardEvent) => {if((event.code === "Space" || event.key === " ") && gesture.current?.active) {event.preventDefault(); gesture.current.release();}};
    const blur = () => gesture.current?.release(true);
    window.addEventListener("keyup",up); window.addEventListener("blur",blur);
    return () => {window.removeEventListener("keyup",up); window.removeEventListener("blur",blur); gesture.current?.release(true);};
  }, []);
  const selection = useRef<TokenSelection>({from: 0, to: 0});
  const pendingCaret = useRef<number | null>(null);
  const [selected, setSelected] = useState<TokenSelection>(selection.current);
  const [draft, setDraft] = useState("");
  const [canvasRevision, setCanvasRevision] = useState(0);
  const draftRange = useRef<TokenSelection | null>(null);
  const record = (next: TokenSelection) => {
    selection.current = next;
    setSelected(old => old.from === next.from && old.to === next.to ? old : next);
  };
  useEffect(() => {setDraft(""); draftRange.current = null; selection.current = {from: 0, to: 0}; setSelected(selection.current);}, [sourcePath]);
  const capture = () => {
    const el = root.current, sel = window.getSelection();
    if (!el || !sel?.rangeCount) return selection.current;
    const range = sel.getRangeAt(0);
    if (!el.contains(range.startContainer) || !el.contains(range.endContainer)) return selection.current;
    const offset = (node: Node, index: number, end: boolean) => {
      const token = (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>("[data-audio-token-index]");
      if (token) return Number(token.dataset.audioTokenIndex) + (end ? 1 : 0);
      const prefix = document.createRange(); prefix.setStart(el, 0); prefix.setEnd(node, index);
      return prefix.cloneContents().querySelectorAll("[data-audio-token-index]").length;
    };
    const from = offset(range.startContainer, range.startOffset, range.collapsed);
    const to = range.collapsed ? from : offset(range.endContainer, range.endOffset, true);
    const next = {from: Math.min(tokens.length, from), to: Math.min(tokens.length, to)};
    record(next);
    return next;
  };
  // Use real DOM events: React's beforeInput synthesis misses some IME/native char paths.
  useEffect(() => {
    const el = root.current; if(!el) return;
    const beforeInput = (event: InputEvent) => {event.preventDefault();};
    const space = (event: KeyboardEvent) => {
      if(event.code !== "Space" && event.key !== " " && event.key !== "Spacebar") return;
      if(event.metaKey || event.ctrlKey || event.altKey) return;
      event.preventDefault(); event.stopPropagation();
      if(!disabled && !event.repeat) gesture.current?.press(capture().from);
    };
    el.addEventListener("beforeinput", beforeInput, {capture:true});
    el.addEventListener("keydown", space, {capture:true});
    return () => {el.removeEventListener("beforeinput",beforeInput,true); el.removeEventListener("keydown",space,true);};
  }, [disabled,tokens,canvasRevision]);
  useEffect(() => {document.addEventListener("selectionchange", capture); return () => document.removeEventListener("selectionchange", capture);}, [tokens]);
  const caret = (index: number) => {
    const el = root.current; if (!el) return;
    el.focus();
    const target = el.querySelector(`[data-audio-token-index="${index}"]`);
    const range = document.createRange();
    if (target) range.setStartBefore(target); else range.selectNodeContents(el);
    range.collapse(Boolean(target));
    const sel = window.getSelection(); sel?.removeAllRanges(); sel?.addRange(range);
    record({from: index, to: index});
  };
  useLayoutEffect(() => {if (pendingCaret.current !== null) {const index = Math.min(tokens.length, pendingCaret.current); pendingCaret.current = null; caret(index);}}, [tokens,canvasRevision]);
  const replace = (inserted: AudioBlock[], range = selection.current) => {
    if (disabled) return;
    const from = Math.min(tokens.length, range.from), to = Math.min(tokens.length, range.to);
    const next = [...tokens.slice(0,from), ...inserted, ...tokens.slice(to)];
    try {validateAudioBlocks(next, duration, true);} catch(e) {onStatus(String(e)); return;}
    pendingCaret.current = from + inserted.length;
    setDraft(""); draftRange.current = null;
    onChange(next);
  };
  const commitDraft = () => {
    const control = audioControlBlock(draft, uid());
    if (control === null) {onStatus("输入 0.2s、+0.1s 或 0.3s+，再按回车。Esc 取消输入。"); return false;}
    replace([control], draftRange.current ?? selection.current);
    return true;
  };
  const selectAll = () => {
    const el = root.current; if (!el) return;
    el.focus(); const range = document.createRange(); range.selectNodeContents(el);
    const sel = window.getSelection(); sel?.removeAllRanges(); sel?.addRange(range);
    record({from: 0, to: tokens.length});
  };
  useImperativeHandle(ref, () => ({
    insertControl(value) {const token = audioControlBlock(value, uid()); if(token) replace([token]);},
    selectAll,
    copyAll() {selectAll(); if (!document.execCommand("copy")) onStatus("请在序列中按 ⌘C / Ctrl+C 复制。");},
  }));
  return <div className="audio-token-paper-wrap"><div
    key={canvasRevision} ref={root} className={`audio-token-paper ${disabled ? "disabled" : ""}`}
    role="textbox" aria-label="声音 token 序列" aria-multiline="true" aria-describedby="audio-token-help"
    contentEditable={!disabled} suppressContentEditableWarning spellCheck={false}
    onMouseUp={() => {const range = capture(); if (range.to > range.from) onInspect(range.from);}}
    onClick={e => {const node = (e.target as HTMLElement).closest<HTMLElement>("[data-audio-token-index]"); if(node) onInspect(Number(node.dataset.audioTokenIndex));}}
    onBeforeInput={e => e.preventDefault()}
    onInputCapture={() => {
      // Some IME composition events cannot be cancelled. Recreate the controlled
      // surface so unmanaged text, spaces, or formatting never become sequence data.
      pendingCaret.current = selection.current.from;
      setCanvasRevision(value => value+1);
    }}
    onCopy={e => {
      const range = capture(); if(range.from === range.to) return;
      e.preventDefault();
      const copy = tokens.slice(range.from, range.to);
      const value = encodeAudioTokens(sourcePath, copy);
      e.clipboardData.setData(AUDIO_TOKEN_MIME, value);
      e.clipboardData.setData("text/html", `<span data-replay-audio="${encodeURIComponent(value)}">${escapeHtml(copy.map(b => b.kind === "silence" || b.kind === "extension" ? audioControlLabel(b) : b.text).join(" "))}</span>`);
      e.clipboardData.setData("text/plain", copy.map(b => b.kind === "silence" || b.kind === "extension" ? audioControlLabel(b) : b.text).join(" "));
      onStatus(`已复制 ${copy.length} 个完整声音 token，粘贴会保留对应音频。`);
    }}
    onCut={e => {
      if(disabled) {e.preventDefault(); return;}
      const range = capture(); e.preventDefault();
      if(range.from === range.to) return;
      const copy = tokens.slice(range.from, range.to), value = encodeAudioTokens(sourcePath, copy);
      e.clipboardData.setData(AUDIO_TOKEN_MIME, value);
      e.clipboardData.setData("text/html", `<span data-replay-audio="${encodeURIComponent(value)}">${escapeHtml(copy.map(b => b.text).join(" "))}</span>`);
      e.clipboardData.setData("text/plain", copy.map(b => b.kind === "silence" || b.kind === "extension" ? audioControlLabel(b) : b.text).join(" "));
      replace([], range);
    }}
    onPaste={e => {
      e.preventDefault(); if(disabled) return;
      try {
        capture();
        let value = e.clipboardData.getData(AUDIO_TOKEN_MIME);
        if(!value) {
          const encoded = /data-replay-audio=["']([^"']+)["']/.exec(e.clipboardData.getData("text/html"))?.[1];
          if(encoded) value = decodeURIComponent(encoded);
        }
        const plain = e.clipboardData.getData("text/plain").trim();
        if(!value && plain.startsWith('{')) value = plain;
        if(value) {const inserted = decodeAudioTokens(value, sourcePath, duration, uid); replace(inserted); onStatus(`已粘贴 ${inserted.length} 个声音 token。`);}
        else {
          const parts = plain.split(/\s+/).filter(Boolean), controls = parts.map(value => audioControlBlock(value, uid()));
          if(!parts.length || controls.some(t => t === null)) throw new Error("请复制声音 token 后粘贴；普通文字没有对应音频。也可直接粘贴 0.2s、+0.1s、0.3s+。");
          replace(controls as AudioBlock[]);
        }
      } catch(error) {onStatus(error instanceof Error ? error.message : String(error));}
    }}
    onDrop={e => {e.preventDefault(); onStatus("移动 token 请使用剪切和粘贴。");}}
    onKeyDown={e => {
      const command = e.metaKey || e.ctrlKey;
      if(command && e.key.toLowerCase() === "a") {e.preventDefault(); selectAll(); return;}
      if(command && e.key.toLowerCase() === "z") {e.preventDefault(); if(!disabled) {setDraft(""); onUndo(e.shiftKey);} return;}
      if(command && e.key.toLowerCase() === "y") {e.preventDefault(); if(!disabled) onUndo(true); return;}
      if(command) {
        if(!["c","x","v","ArrowLeft","ArrowRight","ArrowUp","ArrowDown","Home","End"].includes(e.key) && !["c","x","v"].includes(e.key.toLowerCase())) e.preventDefault();
        return;
      }
      if(e.altKey || e.nativeEvent.isComposing) return;
      if(disabled) {e.preventDefault(); return;}
      if(e.key === "Escape" && draft) {e.preventDefault(); e.stopPropagation(); setDraft(""); draftRange.current = null; return;}
      const range = capture();
      if(e.key === "Backspace" || e.key === "Delete") {
        e.preventDefault();
        if(draft) {setDraft(draft.slice(0,-1)); return;}
        if(range.from !== range.to) replace([], range);
        else if(e.key === "Backspace" && range.from > 0) replace([], {from: range.from-1, to: range.from});
        else if(e.key === "Delete" && range.to < tokens.length) replace([], {from: range.to, to: range.to+1});
      } else if(e.key === " ") {e.preventDefault(); if(!e.repeat) gesture.current?.press(range.from);}
      else if(e.key === "Enter") {e.preventDefault(); if(draft) commitDraft();}
      else if(e.key.length === 1) {
        e.preventDefault();
        if(!/^[\d.s秒+\[\]]$/i.test(e.key)) {onStatus("语音请从已有 token 复制；控制 token 可输入 0.2s、+0.1s、0.3s+ 再按回车。"); return;}
        if(!draft) draftRange.current = range;
        setDraft(d => d + e.key);
      }
    }}
    onKeyUp={e => {if(["ArrowLeft","ArrowRight","ArrowUp","ArrowDown","Home","End"].includes(e.key)) capture();}}
  >
    {tokens.map((b,i) => <Fragment key={b.id}>
      {draft && (draftRange.current?.from ?? selected.from) === i && <span contentEditable={false} className="audio-token-draft">{draft}▏</span>}
      <span contentEditable={false} data-audio-token-index={i}
        className={`audio-voice-token ${b.kind === "extension" ? "extension" : b.kind === "silence" ? "silence" : "speech"} ${i >= selected.from && i < selected.to ? "selected" : ""} ${playing === b.id ? "playing" : ""}`}
        title={b.kind === "extension" ? `${audioControlLabel(b)} · ${b.direction === "previous" ? "取前一个 token 结束后的原音" : "取后一个 token 开始前的原音"}` : b.kind === "silence" ? `静音 ${audioBlockDuration(b).toFixed(3)} 秒 · 双击拆分` : `${b.start.toFixed(3)}–${b.end.toFixed(3)} 秒 · 双击进一步拆分`}
        onDoubleClick={e => {e.preventDefault(); e.stopPropagation(); if(!disabled) {setDraft(""); onSplit(i);}}}
      >{b.kind === "silence" || b.kind === "extension" ? audioControlLabel(b) : b.text || "无字幕音频"}<small>{b.kind === "extension" ? b.direction === "previous" ? "向后取音" : "向前取音" : b.kind === "silence" ? "静音" : `${audioBlockDuration(b).toFixed(2)}s`}</small></span>{" "}
    </Fragment>)}
    {draft && (draftRange.current?.from ?? selected.from) >= tokens.length && <span contentEditable={false} className="audio-token-draft">{draft}▏</span>}
    {!tokens.length && !draft && <span contentEditable={false} className="audio-token-placeholder">{sourcePath ? "序列为空。粘贴声音 token，或输入 0.2s 后按回车插入静音。" : "导入录音或视频，生成可直接编辑的声音 token 序列。"}</span>}
  </div><footer className="audio-token-selection">{selected.to > selected.from ? `已选 ${selected.to-selected.from} 个 token` : `插入位置：第 ${Math.min(selected.from,tokens.length)} 个 token 后`}{draft && <span>输入中：{draft} · 回车确认 · Esc 取消</span>}</footer></div>;
});
