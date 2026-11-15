import {LocalSpeechModels} from "./LocalSpeechModels";
import {useAudioRecording} from "./useAudioRecording";
import {useEffect, useMemo, useRef, useState} from "react";
import {audioBlockDuration, audioSequenceDuration, silenceBlock, audioControlBlock, audioControlLabel, resolveAudioBlocks, validateAudioBlocks, type AudioDocument, type AudioBlock} from "../../../../../../packages/media/src/audio-document";
import {AudioTokenCanvas, type AudioTokenCanvasHandle} from "./AudioTokenCanvas";

function TokenInspector({block, disabled, onApply, onSplit, onManualSplit, onPlay}: {block: AudioBlock; disabled: boolean; onApply(block: AudioBlock): void; onSplit(): void; onManualSplit(offset: number, left: string, right: string): void; onPlay(): void}) {
  const [text, setText] = useState(block.text);
  const [start, setStart] = useState(String(block.start));
  const [end, setEnd] = useState(String(block.end));
  const [offset, setOffset] = useState((audioBlockDuration(block)/2).toFixed(3));
  const chars = Array.from(block.text), middle = Math.ceil(chars.length/2);
  const [left, setLeft] = useState(chars.slice(0,middle).join(""));
  const [right, setRight] = useState(chars.slice(middle).join(""));
  return <aside className="audio-token-inspector" aria-label="选中 token 的属性"><div className="audio-inspector-title"><strong>{block.kind === "extension" ? `延伸 token ${audioControlLabel(block)}` : block.kind === "silence" ? "静音 token" : "语音 token"}</strong><span>{audioBlockDuration(block).toFixed(3)}s{(block.kind !== "silence" && block.kind !== "extension") && ` · ${block.level === "token" ? "识别最细粒度" : block.level === "word" ? "词 / 字" : "短句"}`}</span><button disabled={disabled} onClick={onPlay}>试听此 token</button><button disabled={disabled} onClick={onSplit}>进一步打散</button></div>
    <form onSubmit={e => {e.preventDefault(); onApply({...block, text, start: block.kind === "silence" || block.kind === "extension" ? 0 : Number(start), end: Number(end)});}}>
      {(block.kind !== "silence" && block.kind !== "extension") && <label>显示文字<input disabled={disabled} value={text} onChange={e => setText(e.target.value)}/></label>}
      {(block.kind !== "silence" && block.kind !== "extension") && <label>原音入点（秒）<input disabled={disabled} type="number" step="0.001" min="0" value={start} onChange={e => setStart(e.target.value)}/></label>}
      <label>{block.kind === "extension" ? "延伸时长（秒）" : block.kind === "silence" ? "静音时长（秒）" : "原音出点（秒）"}<input disabled={disabled} type="number" step="0.001" min="0" value={end} onChange={e => setEnd(e.target.value)}/></label><button disabled={disabled}>应用校对</button>
    </form>
    {(block.kind !== "silence" && block.kind !== "extension") && <details><summary>手动指定切点</summary><p>没有更细的识别时间戳时，可试听后指定切点，并校对两侧文字。</p><form onSubmit={e => {e.preventDefault(); onManualSplit(Number(offset), left, right);}}><label>从此 token 起点算（秒）<input disabled={disabled} type="number" step="0.001" min="0.001" max={audioBlockDuration(block)} value={offset} onChange={e => setOffset(e.target.value)}/></label><label>左侧文字<input disabled={disabled} value={left} onChange={e => setLeft(e.target.value)}/></label><label>右侧文字<input disabled={disabled} value={right} onChange={e => setRight(e.target.value)}/></label><button disabled={disabled}>按此切点拆成两个 token</button></form></details>}
  </aside>;
}

export function AudioTextEditor({open, onClose}: {open: boolean; onClose: () => void}) {
  const [localReady,setLocalReady] = useState(false);
  const [doc, setDoc] = useState<AudioDocument | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [history, setHistory] = useState<AudioBlock[][]>([]);
  const [future, setFuture] = useState<AudioBlock[][]>([]);
  const [inspected, setInspected] = useState<string | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const [silence, setSilence] = useState("0.2s");
  const audio = useRef<HTMLAudioElement>(null);
  const canvas = useRef<AudioTokenCanvasHandle>(null);
  const dialog = useRef<HTMLElement>(null);
  const playback = useRef({generation: 0, timer: 0, frame: 0});
  const projectInput = useRef<HTMLInputElement>(null);
  const recordingContext = useRef<{doc: AudioDocument | null; blocks: AudioBlock[]}>({doc:null,blocks:[]});
  const blocks = doc?.blocks ?? [];
  const sequence = useMemo(() => {try {return {resolved: resolveAudioBlocks(blocks, doc?.duration ?? 0), error: ""};} catch(e) {return {resolved: [] as AudioBlock[], error: e instanceof Error ? e.message : String(e)};}}, [blocks, doc?.duration]);
  const chosen = blocks.find(b => b.id === inspected);
  const stop = () => {
    playback.current.generation++;
    clearTimeout(playback.current.timer); cancelAnimationFrame(playback.current.frame);
    if(audio.current) {audio.current.pause(); audio.current.onended = null;}
    setPlaying(null);
  };
  useEffect(()=>{if(!open)return;return window.replaymod?.onLocalSpeechProgress(update=>{if(update.sourcePath)setStatus(update.message);});},[open]);
  useEffect(() => {if(!open) stop(); return () => {playback.current.generation++; clearTimeout(playback.current.timer); cancelAnimationFrame(playback.current.frame); audio.current?.pause();};}, [open]);
  useEffect(() => {
    if(!open) return;
    const key = (e: KeyboardEvent) => {
      if(e.key === "Escape" && !e.defaultPrevented && !busy) onClose();
      if(e.key === "Tab") {
        const fields = dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled):not([type="file"]), select:not(:disabled), [contenteditable="true"], summary');
        if(!fields?.length) return;
        const first = fields[0], last = fields[fields.length-1];
        if(e.shiftKey && document.activeElement === first) {e.preventDefault(); last.focus();}
        else if(!e.shiftKey && document.activeElement === last) {e.preventDefault(); first.focus();}
      }
    };
    window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key);
  }, [open, busy, onClose]);
  const change = (next: AudioBlock[]) => {
    if(!doc) return;
    validateAudioBlocks(next, doc.duration, true);
    stop(); setHistory(h => [...h.slice(-49), blocks]); setFuture([]); setDoc({...doc, blocks: next});
    if(!next.some(b => b.id === inspected)) setInspected(null);
  };
  const undo = (redo: boolean) => {
    if(!doc || busy) return;
    const stack = redo ? future : history;
    if(!stack.length) return;
    stop(); setInspected(null); setDoc({...doc, blocks: stack[stack.length-1]});
    if(redo) {setFuture(f => f.slice(0,-1)); setHistory(h => [...h, blocks]);}
    else {setHistory(h => h.slice(0,-1)); setFuture(f => [...f, blocks]);}
  };
  const task = async (fn: () => Promise<void>) => {
    setBusy(true); stop(); try {await fn();} catch(e) {setStatus(e instanceof Error ? e.message : String(e));} finally {setBusy(false);}
  };
  const play = (index = 0, single = false) => {
    stop();
    const player = audio.current; if(!player || !blocks[index]) return;
    if(sequence.error) {setStatus(sequence.error); return;}
    const generation = playback.current.generation;
    const next = (i: number) => {
      if(playback.current.generation !== generation) return;
      const b = sequence.resolved[i];
      if(!b || (single && i !== index)) {stop(); return;}
      player.pause(); player.onended = null;
      setPlaying(b.id);
      if(b.kind === "silence") {playback.current.timer = window.setTimeout(() => next(i+1), audioBlockDuration(b)*1000); return;}
      // Continuous source ranges play without pausing or seeking between word tokens.
      let last = i;
      if (!single) while(last+1 < sequence.resolved.length && sequence.resolved[last+1].kind !== "silence" && (sequence.resolved[last].sourcePath ?? doc?.sourcePath) === (sequence.resolved[last+1].sourcePath ?? doc?.sourcePath) && Math.abs(sequence.resolved[last].end-sequence.resolved[last+1].start) < 1e-9) last++;
      const end = sequence.resolved[last].end;
      let highlighted = i;
      const url = `replay-media://preview/${encodeURIComponent(b.sourcePath ?? doc!.sourcePath)}`;
      if(player.src !== url) player.src = url;
      player.currentTime = b.start;
      let advancing = false;
      const advance = () => {if(advancing) return; advancing = true; cancelAnimationFrame(playback.current.frame); next(last+1);};
      player.onended = advance;
      void player.play().then(() => {
        const tick = () => {
          if(playback.current.generation !== generation || advancing) return;
          if(player.currentTime >= end) advance();
          else {
            while(highlighted < last && player.currentTime >= sequence.resolved[highlighted].end) highlighted++;
            setPlaying(sequence.resolved[highlighted].id);
            playback.current.frame = requestAnimationFrame(tick);
          }
        };
        playback.current.frame = requestAnimationFrame(tick);
      }).catch(e => {if(playback.current.generation === generation) {stop(); setStatus(`无法试听：${String(e)}`);}});
    };
    next(index);
  };
  const split = (index: number) => {
    const b = blocks[index]; if(!doc || !b || busy) return;
    setInspected(b.id);
    if(b.kind === "silence" || b.kind === "extension") {
      const half = audioBlockDuration(b)/2;
      if(half < .001) {setStatus("此静音 token 已短于可继续拆分的范围。"); return;}
      const children = [0,1].map(() => b.kind === "silence" ? silenceBlock(half, crypto.randomUUID()) : {...b, id: crypto.randomUUID(), end: half});
      change([...blocks.slice(0,index), ...children, ...blocks.slice(index+1)]);
      setStatus("控制 token 已拆成两个，总时长不变。"); return;
    }
    void task(async () => {
      setStatus("正在读取 ForcedAligner 的词/字时间戳…");
      const finer = await window.replaymod!.splitAudioEdit(doc.sourcePath, b);
      if(finer.length < 2) {setStatus("已到 ForcedAligner 返回的最细时间戳。可在下方展开「手动指定切点」继续拆分。"); return;}
      change([...blocks.slice(0,index), ...finer, ...blocks.slice(index+1)]);
      setInspected(finer[0].id);
      setStatus(`已打散为 ${finer.length} 个更细的 token，原片段完整音频和总时长保留。`);
    });
  };
  const microphone = useAudioRecording(async (blob, index) => {
    setStatus("正在保存录音并插入声音 token…");
    const context = recordingContext.current;
    const saved = await window.replaymod!.saveAudioRecording(context.doc?.sourcePath ?? null, new Uint8Array(await blob.arrayBuffer()));
    const at = Math.min(index,context.blocks.length);
    const next = [...context.blocks.slice(0,at),...saved.tokens,...context.blocks.slice(at)];
    if(context.doc) change(next);
    else {setDoc({...saved.document,blocks:next}); setHistory([]); setFuture([]);}
    setInspected(saved.tokens[0].id); setStatus("已将录音插入光标处。双击录音 token 可在本地识别并打散。");
  }, setStatus);
  const locked = busy || microphone.phase !== "idle";
  if(!open) return null;
  return <div className="subtitle-editor-backdrop"><section ref={dialog} className="subtitle-editor audio-text-editor" role="dialog" aria-modal="true" aria-label="声音 token 编辑器">
    <header><div><span>音频工作台</span><h1>像编辑文字一样剪声音</h1></div><button autoFocus disabled={locked} onClick={onClose} aria-label="关闭">×</button></header>
    <LocalSpeechModels disabled={locked} onReady={setLocalReady} onInstalling={setBusy}/>
    <div className="subtitle-editor-toolbar">
      <button disabled={locked || !localReady} onClick={() => void task(async () => {
        const source = await window.replaymod!.openAudioEdit(); if(!source) return;
        setDoc(source); setHistory([]); setFuture([]); setInspected(null);
        setStatus("正在用本地 Qwen3-ASR 识别文字，并用 ForcedAligner 对齐时间…");
        const next = await window.replaymod!.transcribeAudioEdit(source.sourcePath, "phrase");
        setDoc({...source, blocks: next}); setStatus(`已生成 ${next.length} 个短句 token。双击任意一个可继续打散。`);
      })}>导入音频 / 视频</button>
      <button disabled={locked || !history.length} onClick={() => undo(false)}>撤销</button>
      <button disabled={locked || !future.length} onClick={() => undo(true)}>重做</button>
      <button disabled={locked || !blocks.length} onClick={() => canvas.current?.selectAll()}>全选</button>
      <button disabled={locked || !blocks.length} onClick={() => canvas.current?.copyAll()}>复制整个序列</button>
      <button disabled={locked || !doc} onClick={() => projectInput.current?.click()}>恢复剪辑</button>
      <input ref={projectInput} type="file" accept=".json" hidden onChange={e => {
        const file = e.target.files?.[0]; e.target.value = ""; if(!file || !doc) return;
        void task(async () => {
          const {decodeAudioTokens} = await import("../../../../../../packages/media/src/audio-document");
          const next = decodeAudioTokens(await file.text(), doc.sourcePath, doc.duration, () => crypto.randomUUID()); await window.replaymod!.prepareAudioEdit(doc.sourcePath,next); change(next); setStatus("已恢复声音 token 序列。");
        });
      }}/>
    </div>
    <p className="audio-help" id="audio-token-help">拖选、⌘/Ctrl+A 全选，C / X / V 复制、剪切、粘贴，Backspace 删除。双击 token 继续打散。轻按空格从光标播放/暂停，按住空格录音、松开结束。输入后按回车：<kbd>0.2s</kbd> 静音；<kbd>+0.1s</kbd> 取前 token 后的原音；<kbd>0.3s+</kbd> 取后 token 前的原音。</p>
    <div className="audio-source"><strong>{doc?.sourceName ?? "尚未导入素材"}</strong><span>{blocks.length} 个 token · 成片 {audioSequenceDuration(blocks).toFixed(3)}s{doc && ` · 原始 ${doc.duration.toFixed(2)}s`}</span>
      <audio ref={audio} preload="metadata" src={`replay-media://preview/${encodeURIComponent(doc?.sourcePath ?? "")}`} onError={() => {stop(); setStatus("音轨预览加载失败，请确认素材仍在原位置。");}}/>
      <button disabled={locked || !blocks.length || !!sequence.error} onClick={() => playing ? stop() : play()}>{playing ? "暂停试听" : "试听整个序列"}</button>
      <label className="audio-silence-input">插入 token<input aria-label="插入控制 token" disabled={locked || !doc} value={silence} onChange={e => setSilence(e.target.value)}/></label>
      <button disabled={locked || !doc} onClick={() => {const token = audioControlBlock(silence, crypto.randomUUID()); if(!token) {setStatus("请输入 0.2s、+0.1s 或 0.3s+。"); return;} canvas.current?.insertControl(silence);}}>插入光标处</button>
      <button disabled={locked || !blocks.length || !!sequence.error} onClick={() => doc && void task(async () => {
        setStatus("正在按 token 序列拼接音频，包含重复片段和静音…");
        const output = await window.replaymod!.exportAudioEdit(doc.sourcePath, blocks);
        setStatus(output ? `已导出音频、同步字幕和可恢复的剪辑序列：${output}` : "已取消导出。");
      })}>导出音频</button>
    </div>
    {sequence.error && <div className="audio-sequence-error" role="alert">{sequence.error} 选中 token 可修改，或删除后重新插入。</div>}
    <div className={`audio-status ${microphone.phase === "recording" ? "recording" : ""}`} role="status">{status || "每个 token 都绑定一段声音；复制 token 会复制对应音频，静音也是一个 token。"}</div>
    <AudioTokenCanvas ref={canvas} tokens={blocks} sourcePath={doc?.sourcePath ?? ""} duration={doc?.duration ?? 0} disabled={locked} playing={playing}
      onPlayback={index => {if(playing) stop(); else play(index);}}
      onRecordStart={index => {stop(); recordingContext.current = {doc,blocks}; void microphone.start(index);}} onRecordEnd={microphone.end}
      onChange={change} onInspect={i => setInspected(blocks[i]?.id ?? null)} onSplit={split} onUndo={undo} onStatus={setStatus}/>
    {chosen && <TokenInspector key={`${chosen.id}:${chosen.start}:${chosen.end}:${chosen.text}`} block={chosen} disabled={locked}
      onPlay={() => play(blocks.findIndex(b => b.id === chosen.id), true)} onSplit={() => split(blocks.findIndex(b => b.id === chosen.id))}
      onApply={next => {try {if(next.kind === "silence") next = silenceBlock(next.end, next.id);
        else if(next.kind === "extension") {const value = next.direction === "previous" ? `+${next.end}s` : `${next.end}s+`; const control = audioControlBlock(value, next.id); if(!control) throw new Error("延伸时长无效。"); next = control;} change(blocks.map(b => b.id === chosen.id ? next : b)); setStatus("已更新 token；文字校对不会生成新的语音。");} catch(e) {setStatus(e instanceof Error ? e.message : String(e));}}}
      onManualSplit={(offset, left, right) => {
        if(!Number.isFinite(offset) || offset <= 0 || offset >= audioBlockDuration(chosen)) {setStatus("切点必须位于 token 内部。"); return;}
        const i = blocks.findIndex(b => b.id === chosen.id), point = chosen.start + offset;
        const children = [{...chosen, id: crypto.randomUUID(), end: point, text: left}, {...chosen, id: crypto.randomUUID(), start: point, text: right}];
        change([...blocks.slice(0,i), ...children, ...blocks.slice(i+1)]); setInspected(children[0].id); setStatus("已按指定时间拆分，总时长不变。");
      }}/>}
  </section></div>;
}
