"""Wumpy's transcriber.

Runs as a child process of the app and stays alive, because loading the model is
the expensive part: a second or two for base.en, against a fraction of that to
transcribe a short utterance. Starting a fresh process per clip would make every
sentence pay the load, which is the same mistake as letting Ollama drop its
context between turns.

Protocol, one JSON object per line each way:

    in   {"id": 1, "path": "C:/.../clip.webm", "language": "en"}
    out  {"ready": true, "model": "base.en", "load_ms": 1200}
         {"id": 1, "text": "...", "ms": 420, "audio": 2.1, "confidence": 0.82,
          "language": "en", "language_confidence": 0.99}
         {"id": 1, "error": "..."}

`language` is a code to pin, or null to detect it per clip. Null needs a
multilingual model: the `.en` sizes have no other language in them and no
detector either, so the app picks the size from the same setting.

Exits when stdin closes, so it cannot outlive the app.
"""
import json
import os
import sys
import time

# Words no acoustic model has heard of. Whisper accepts a prompt and biases
# towards its vocabulary, which fixes some of these before they go wrong; the
# table in src/shared/dictation.ts catches what survives.
#
# The addresses at the end are doing a second job. An initial prompt sets the
# STYLE of the transcript as well as its vocabulary, and Whisper's default
# style for a dictated run of digits is the one subtitles use: "1-2-3-4-5-6".
# Showing it a URL with a plain six-digit code is what stops the hyphens being
# written in the first place. src/shared/spokenurl.ts repairs the rest, but it
# has to refuse to guess at "123-456" - so it is worth more to prevent the
# hyphens than to unpick them.
VOCABULARY = (
    "Wumpy, Ollama, phi4-mini, qwen2.5, llama3.2, qwen2.5-coder, Whisper, "
    "PowerShell, GitHub, Node.js, Electron, TypeScript, JSON, YAML, "
    "tier, thinker, keep-alive, accept edits, auto-compact, "
    "/also, /tier, /new, /model, .py, .ts, .md, .json, "
    "https://vocabulary.com/join/123456, https://github.com/psyduck-z/wumpy, "
    "www.example.com/signup?code=408217"
)

# THE PROMPT ABOVE IS ENGLISH, AND A PROMPT IS NOT A HINT.
#
# An initial prompt is prepended to the decoder's context, so it steers style
# and vocabulary in whatever language it is written in. Handing a Chinese
# utterance a line of English product names biases the decoding towards
# English - the one thing that must not happen to the feature that exists so
# Chinese comes out as Chinese.
#
# The detection pass itself is unaffected: it runs on the mel features before
# any decoding, so the prompt cannot reach it. What it can reach is the words
# that come out afterwards, which is why the prompt is chosen AFTER the
# language is known rather than passed in regardless.
PROMPTS = {"en": VOCABULARY}


def send(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def detect(model, audio, vad):
    """The spoken language and how sure the model is, or None when it cannot.

    A separate pass rather than `transcribe(language=None)`, for one reason:
    this way the language is known BEFORE the prompt is chosen. See PROMPTS.

    It costs one encoder forward over the first window - measured at about a
    third of a second for `base` on this machine - and only happens when the
    user asked for detection. Pinning a language skips it entirely.

    Wrapped because it is the one call here that depends on a faster-whisper
    newer than the floor in scripts/install-speech.mjs. An older one loses
    detection and keeps everything else, rather than losing dictation.
    """
    try:
        lang, prob, _ = model.detect_language(audio=audio, vad_filter=True, vad_parameters=vad)
        return lang, round(float(prob), 2)
    except Exception:  # noqa: BLE001 - optional capability, never fatal
        return None, 0.0


def main():
    # The size follows the language setting, because the two are one choice:
    # a `.en` model has no other language in it and cannot detect one. The app
    # passes it; the variable still overrides both by hand.
    size = os.environ.get("WUMPY_WHISPER_MODEL") or "base.en"
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

        # A code to pin, or absent/null to work it out from the audio. Absent
        # is read as English so an older app talking to a newer worker keeps
        # the behaviour it was written against.
        wanted = req.get("language", "en")

        t1 = time.time()
        try:
            vad = {"min_silence_duration_ms": 400}
            clip = path
            language = wanted
            confidence = 1.0
            if wanted is None:
                # Decoded once and reused: detection and transcription both
                # want 16kHz mono floats, and decoding a clip twice is the
                # kind of waste that turns a third of a second into two.
                from faster_whisper.audio import decode_audio

                clip = decode_audio(path, sampling_rate=16000)
                language, confidence = detect(model, clip, vad)
                # UNSURE MEANS ENGLISH, NOT A GUESS.
                #
                # Detection reads the first window, and a dictated clip is
                # often two seconds of it. Whisper will call a short English
                # phrase Welsh or Dutch with middling confidence, and a
                # transcript in the wrong language is not a near miss - it is
                # unusable, where falling back costs nothing to someone
                # speaking English anyway.
                if not language or confidence < 0.5:
                    language, confidence = "en", confidence
            segments, info = model.transcribe(
                clip,
                language=language,
                beam_size=5,
                # Silence is where Whisper invents things, so it is cut before
                # the model ever sees it rather than filtered out afterwards.
                vad_filter=True,
                vad_parameters=vad,
                # Each utterance stands alone. Conditioning on the previous one
                # is what makes Whisper repeat a phrase forever.
                condition_on_previous_text=False,
                # Chosen by language, never regardless of it. See PROMPTS.
                initial_prompt=PROMPTS.get(language or ""),
                no_speech_threshold=0.6,
            )
            parts = []
            logprobs = []
            for s in segments:
                parts.append(s.text)
                logprobs.append(s.avg_logprob)
            text = " ".join(p.strip() for p in parts).strip()
            # `info` carries what the model settled on, which is the same as
            # the detection above except when an old faster-whisper made the
            # detection a no-op. Preferring it keeps the two from disagreeing.
            spoken = getattr(info, "language", None) or language or "en"
            send(
                {
                    "id": rid,
                    "text": text,
                    "ms": int((time.time() - t1) * 1000),
                    "audio": round(info.duration, 2),
                    "language": spoken,
                    "language_confidence": round(
                        float(getattr(info, "language_probability", 0.0) or confidence), 2
                    ),
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
