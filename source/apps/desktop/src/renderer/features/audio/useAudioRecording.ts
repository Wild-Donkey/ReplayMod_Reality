import {useEffect, useRef, useState} from "react";

export function useAudioRecording(save: (blob: Blob, index: number) => Promise<void>, status: (text: string) => void) {
  const [phase, setPhase] = useState<"idle" | "permission" | "recording" | "saving">("idle");
  const active = useRef({generation: 0, held: false, stream: null as MediaStream | null, recorder: null as MediaRecorder | null});
  const callbacks = useRef({save, status}); callbacks.current = {save, status};
  const cancel = () => {
    const session = active.current; session.generation++; session.held = false;
    if(session.recorder?.state === "recording") session.recorder.stop();
    session.stream?.getTracks().forEach(track => track.stop()); session.stream = null; session.recorder = null;
  };
  useEffect(() => cancel, []);
  const start = async (index: number) => {
    cancel(); const session = active.current, generation = session.generation; session.held = true;
    setPhase("permission"); callbacks.current.status("正在请求麦克风，按住空格说话，松开结束。首次使用需要允许麦克风。");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({audio: true});
      if(generation !== session.generation || !session.held) {stream.getTracks().forEach(t => t.stop()); if(generation === session.generation) setPhase("idle"); return;}
      session.stream = stream;
      const mimeType = ["audio/webm;codecs=opus", "audio/webm"].find(type => MediaRecorder.isTypeSupported(type));
      const recorder = new MediaRecorder(stream, mimeType ? {mimeType} : undefined); session.recorder = recorder;
      const chunks: Blob[] = [];
      recorder.ondataavailable = event => {if(event.data.size) chunks.push(event.data);};
      recorder.onerror = () => {if(generation === session.generation) {cancel(); setPhase("idle"); callbacks.current.status("录音失败，请检查麦克风后重试。");}};
      recorder.onstop = async () => {
        stream.getTracks().forEach(track => track.stop());
        if(generation !== session.generation) return;
        session.stream = null; session.recorder = null;
        const blob = new Blob(chunks, {type: recorder.mimeType});
        if(!blob.size) {setPhase("idle"); callbacks.current.status("没有录到声音，请按住空格再试。"); return;}
        setPhase("saving");
        try {await callbacks.current.save(blob,index);} catch(e) {callbacks.current.status(e instanceof Error ? e.message : String(e));}
        finally {if(generation === session.generation) setPhase("idle");}
      };
      recorder.start(250); setPhase("recording"); callbacks.current.status("● 正在录音 · 松开空格结束并插入光标处");
    } catch(e) {
      if(generation !== session.generation) return;
      session.held = false; session.stream?.getTracks().forEach(t => t.stop()); session.stream = null;
      setPhase("idle"); callbacks.current.status(e instanceof DOMException && (e.name === "NotAllowedError" || e.name === "PermissionDeniedError") ? "麦克风未获授权。允许应用使用麦克风后，再按住空格录音。" : `无法录音：${String(e)}`);
    }
  };
  const end = () => {
    const wasHeld = active.current.held;
    active.current.held = false;
    if(active.current.recorder?.state === "recording") active.current.recorder.stop();
    else if(!active.current.recorder && wasHeld) {setPhase("idle"); callbacks.current.status("已松开空格；尚未开始的麦克风录音已取消。");}
  };
  return {phase, start, end};
}
