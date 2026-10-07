"""Wumpy's transcriber.

Runs as a child process of the app and stays alive, because loading the model is
the expensive part: a second or two for base.en, against a fraction of that to
transcribe a short utterance. Starting a fresh process per clip would make every
sentence pay the load, which is the same mistake as letting Ollama drop its
context between turns.

Protocol, one JSON object per line each way:

    in   {"id": 1, "path": "C:/.../clip.webm"}
    out  {"ready": true, "model": "base.en", "load_ms": 1200}
         {"id": 1, "text": "...", "ms": 420, "audio": 2.1, "confidence": 0.82}
         {"id": 1, "error": "..."}

Exits when stdin closes, so it cannot outlive the app.
"""
import json
import os
import sys
import time

# Words no acoustic model has heard of. Whisper accepts a prompt and biases
# towards its vocabulary, which fixes some of these before they go wrong; the
# table in src/shared/dictation.ts catches what survives.
VOCABULARY = (
    "Wumpy, Ollama, phi4-mini, qwen2.5, llama3.2, qwen2.5-coder, Whisper, "
    "PowerShell, GitHub, Node.js, Electron, TypeScript, JSON, YAML, "
    "tier, thinker, keep-alive, accept edits, auto-compact, "
    "/also, /tier, /new, /model, .py, .ts, .md, .json"
)


def send(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def main():
    size = os.environ.get("WUMPY_WHISPER_MODEL", "base.en")
    root = os.environ.get("WUMPY_WHISPER_MODELS") or None

    try:
        from faster_whisper import WhisperModel
    except Exception as err:  # noqa: BLE001 - reported to the app, not raised
        send({"fatal": f"faster-whisper is not installed in this interpreter: {err}"})
        return 1

    # How many cores to take.
    #
    # ctranslate2 defaults to all of them, and on this machine that was 2.7x
    # SLOWER than using half: 16 threads gave a 4.04s median on a 2.5s clip,
    # 8 threads 1.51s, 4 threads 1.83s. Too many threads on a short utterance
    # spend their time synchronising, and the machine has other work - Ollama
    # above all, which this app needs more than it needs a transcript half a
    # second sooner.
    #
    # Half the cores, never more than eight, never fewer than two: eight was the
    # best measured here, and halving keeps it from oversubscribing a small
    # machine where eight would be every core it has.
    cores = os.cpu_count() or 4
    threads = int(os.environ.get("WUMPY_WHISPER_THREADS") or 0) or max(2, min(8, cores // 2))

    t0 = time.time()
    try:
        # int8 on CPU is roughly twice the speed of float32 for no measurable
        # accuracy cost at these model sizes, and this app only ever has the CPU.
        model = WhisperModel(
            size, device="cpu", compute_type="int8", download_root=root, cpu_threads=threads
        )
    except Exception as err:  # noqa: BLE001
        send({"fatal": f"could not load {size}: {err}"})
        return 1
    send(
        {
            "ready": True,
            "model": size,
            "threads": threads,
            "load_ms": int((time.time() - t0) * 1000),
        }
    )

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except ValueError:
            continue

        rid = req.get("id")
        path = req.get("path")
        if not path:
            send({"id": rid, "error": "no path"})
            continue

        t1 = time.time()
        try:
            segments, info = model.transcribe(
                path,
                language="en",
                beam_size=5,
                # Silence is where Whisper invents things, so it is cut before
                # the model ever sees it rather than filtered out afterwards.
                vad_filter=True,
                vad_parameters={"min_silence_duration_ms": 400},
                # Each utterance stands alone. Conditioning on the previous one
                # is what makes Whisper repeat a phrase forever.
                condition_on_previous_text=False,
                initial_prompt=VOCABULARY,
                no_speech_threshold=0.6,
            )
            parts = []
            logprobs = []
            for s in segments:
                parts.append(s.text)
                logprobs.append(s.avg_logprob)
            text = " ".join(p.strip() for p in parts).strip()
            send(
                {
                    "id": rid,
                    "text": text,
                    "ms": int((time.time() - t1) * 1000),
                    "audio": round(info.duration, 2),
                    # Mean per-token log probability, mapped to 0..1. Low means
                    # the model was guessing, which the app can say out loud
                    # rather than presenting a guess as a transcript.
                    "confidence": round(min(1.0, max(0.0, 1.0 + sum(logprobs) / len(logprobs))), 2)
                    if logprobs
                    else 0.0,
                }
            )
        except Exception as err:  # noqa: BLE001
            send({"id": rid, "error": str(err)})

    return 0


if __name__ == "__main__":
    sys.exit(main())
