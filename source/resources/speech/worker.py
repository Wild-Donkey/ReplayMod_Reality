# coding: utf-8
"""Offline JSON-lines worker. ASR supplies text; the aligner supplies word times."""
import contextlib
import json
import os
import sys
from pathlib import Path


def word_cues(items, offset, duration):
    # A zero-duration character shares its neighbour's audio instead of disappearing.
    result = []
    pending = ""
    for item in items:
        text = item.text.strip()
        if not text:
            continue
        start = max(0.0, float(item.start_time))
        end = min(duration, float(item.end_time))
        if end <= start:
            if result:
                result[-1]["text"] += text
            else:
                pending += text
            continue
        result.append({"startTimeSeconds": offset + start, "endTimeSeconds": offset + end, "text": pending + text})
        pending = ""
    return result

def phrase_cues(text, words, offset, duration):
    """Group aligned words into readable phrases without losing ASR punctuation."""
    if not words:
        return [{"startTimeSeconds": offset, "endTimeSeconds": offset + duration, "text": text}]
    positions = []
    cursor = 0
    for word in words:
        found = text.find(word["text"], cursor)
        if found < 0:
            return [{"startTimeSeconds": offset, "endTimeSeconds": offset + duration, "text": text}]
        positions.append(found)
        cursor = found + len(word["text"])
    result = []
    first = 0
    for index, word in enumerate(words):
        end = positions[index + 1] if index + 1 < len(words) else len(text)
        start = positions[first] if first else 0
        phrase = text[start:end].strip()
        gap = words[index + 1]["startTimeSeconds"] - word["endTimeSeconds"] if index + 1 < len(words) else 0
        if index == len(words) - 1 or phrase.endswith(tuple("，。！？；,.!?;")) or len(phrase) >= 28 or word["endTimeSeconds"] - words[first]["startTimeSeconds"] >= 8 or gap >= .65:
            result.append({"startTimeSeconds": words[first]["startTimeSeconds"], "endTimeSeconds": word["endTimeSeconds"], "text": phrase})
            first = index + 1
    return result

def main():
    mode = sys.argv[1]
    runtime = Path(sys.argv[2]).resolve()
    os.environ["HF_HOME"] = str(runtime / "huggingface")
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    import mlx.core as mx
    if not mx.metal.is_available():
        raise RuntimeError("没有可用的 Apple Metal GPU。")
    from mlx_audio.stt import load
    asr_directory = Path(sys.argv[3]).resolve()
    aligner_directory = Path(sys.argv[4]).resolve()
    asr = None
    aligner = None
    import numpy as np
    import soundfile as sf
    import time
    protocol_output = sys.stdout
    def emit(value):
        protocol_output.write(json.dumps(value, ensure_ascii=False, allow_nan=False) + "\n")
        protocol_output.flush()
    emit({"type": "ready"})
    for line in sys.stdin:
        request = None
        try:
            request = json.loads(line)
            started = time.monotonic()
            audio, sr = sf.read(request["audio"], dtype="float32")
            if sr != 16000 or audio.ndim != 1:
                raise ValueError("Worker requires 16 kHz mono WAV.")
            words = []
            sentences = []
            chunks = max(1, int(np.ceil(len(audio) / (30 * sr))))
            with contextlib.redirect_stdout(sys.stderr):
                if aligner is None:
                    aligner = load(str(aligner_directory))
                if request.get("text") is None and asr is None:
                    asr = load(str(asr_directory))
                for index in range(chunks):
                    offset = index * 30.0
                    waveform = audio[index * 30 * sr:(index + 1) * 30 * sr]
                    duration = len(waveform) / sr
                    if duration <= 0:
                        continue
                    emit({"type": "progress", "id": request["id"], "done": index, "total": chunks, "stage": "asr"})
                    text = request.get("text")
                    if text is None:
                        text = asr.generate(waveform, language="Chinese", max_tokens=1024, temperature=0.0).text.strip()
                    if not text:
                        continue
                    emit({"type": "progress", "id": request["id"], "done": index, "total": chunks, "stage": "align"})
                    aligned = aligner.generate(audio=waveform, text=text, language="Chinese")
                    items = getattr(aligned, "items", aligned)
                    chunk_words = word_cues(items, offset, duration)
                    words.extend(chunk_words)
                    sentences.extend(phrase_cues(text, chunk_words, offset, duration))
            emit({"type": "result", "id": request["id"], "sentences": sentences, "words": words, "elapsedSeconds": time.monotonic() - started, "peakMemoryBytes": mx.get_peak_memory()})
            mx.clear_cache()
        except Exception as error:
            import traceback
            traceback.print_exc(file=sys.stderr)
            emit({"type": "error", "id": request.get("id") if isinstance(request, dict) else None, "message": str(error)})

if __name__ == "__main__":
    main()
