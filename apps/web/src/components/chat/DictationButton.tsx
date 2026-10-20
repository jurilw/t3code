import type { EnvironmentId } from "@t3tools/contracts";
import { LoaderCircleIcon, MicIcon, SquareIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

type DictationState = "idle" | "starting" | "recording" | "transcribing";

/** Long enough for a long prompt, short enough that one clip stays one frame. */
const MAX_RECORDING_MS = 5 * 60_000;
/** Shorter than this is a misclick, not speech. */
const MIN_RECORDING_MS = 400;

const PREFERRED_MIME_TYPES = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/webm"];

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  return PREFERRED_MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the recording."));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.readAsDataURL(blob);
  });
}

function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function failureMessage(cause: unknown): string {
  if (typeof cause === "object" && cause !== null && "error" in cause) {
    const error = (cause as { error: unknown }).error;
    if (error instanceof Error && error.message) return error.message;
  }
  return "Transcription failed.";
}

/**
 * Click to record, click again to stop; the clip is transcribed on the
 * environment's host (whisper-server) and the text lands at the caret.
 * Escape while recording throws the clip away.
 */
export function DictationButton(props: {
  readonly environmentId: EnvironmentId;
  readonly disabled?: boolean;
  readonly onTranscript: (text: string) => void;
}) {
  const { environmentId, onTranscript } = props;
  const transcribe = useAtomCommand(serverEnvironment.transcribeAudio, { reportFailure: false });
  const [state, setState] = useState<DictationState>("idle");
  const [elapsedMs, setElapsedMs] = useState(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const discardRef = useRef(false);
  const startedAtRef = useRef(0);

  const stop = useCallback((discard: boolean) => {
    discardRef.current = discard;
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") recorder.stop();
  }, []);

  // Tick the timer and enforce the cap while recording.
  useEffect(() => {
    if (state !== "recording") return;
    const id = window.setInterval(() => {
      const elapsed = Date.now() - startedAtRef.current;
      setElapsedMs(elapsed);
      if (elapsed >= MAX_RECORDING_MS) stop(false);
    }, 250);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      stop(true);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [state, stop]);

  // Unmounting mid-recording must release the microphone.
  useEffect(() => () => stop(true), [stop]);

  const finish = useCallback(
    async (blob: Blob, mimeType: string, durationMs: number) => {
      if (discardRef.current || durationMs < MIN_RECORDING_MS || blob.size === 0) {
        setState("idle");
        return;
      }
      setState("transcribing");
      try {
        const audioBase64 = await blobToBase64(blob);
        const result = await transcribe({ environmentId, input: { audioBase64, mimeType } });
        if (result._tag === "Success") {
          if (result.value.text) onTranscript(result.value.text);
          else toastManager.add({ type: "info", title: "No speech detected" });
        } else {
          toastManager.add({
            type: "error",
            title: "Dictation failed",
            description: failureMessage(result.cause),
          });
        }
      } catch (cause) {
        toastManager.add({
          type: "error",
          title: "Dictation failed",
          description: cause instanceof Error ? cause.message : String(cause),
        });
      } finally {
        setState("idle");
      }
    },
    [environmentId, onTranscript, transcribe],
  );

  const start = useCallback(async () => {
    const mimeType = pickMimeType();
    if (!mimeType || !navigator.mediaDevices?.getUserMedia) {
      toastManager.add({
        type: "error",
        title: "Dictation unavailable",
        description: "This window cannot record audio.",
      });
      return;
    }
    setState("starting");
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
      });
    } catch (cause) {
      setState("idle");
      toastManager.add({
        type: "error",
        title: "Microphone unavailable",
        description:
          cause instanceof DOMException && cause.name === "NotAllowedError"
            ? "Microphone access was denied."
            : "No microphone could be opened.",
      });
      return;
    }
    const recorder = new MediaRecorder(stream, { mimeType });
    const chunks: Blob[] = [];
    discardRef.current = false;
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    recorder.onstop = () => {
      for (const track of stream.getTracks()) track.stop();
      recorderRef.current = null;
      const durationMs = Date.now() - startedAtRef.current;
      void finish(new Blob(chunks, { type: mimeType }), mimeType, durationMs);
    };
    recorderRef.current = recorder;
    startedAtRef.current = Date.now();
    setElapsedMs(0);
    recorder.start(1000);
    setState("recording");
  }, [finish]);

  const recording = state === "recording";
  const busy = state === "starting" || state === "transcribing";
  const label = recording
    ? "Stop and transcribe (Esc to discard)"
    : state === "transcribing"
      ? "Transcribing…"
      : "Dictate a prompt";

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size={recording ? "sm" : "icon-sm"}
            className={cn(
              recording && "gap-1.5 px-2 text-destructive hover:text-destructive tabular-nums",
            )}
            disabled={(props.disabled && !recording) || busy}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => (recording ? stop(false) : void start())}
            aria-label={label}
            aria-pressed={recording}
          />
        }
      >
        {recording ? (
          <>
            <span className="relative flex size-2">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-destructive opacity-60 motion-reduce:animate-none" />
              <span className="relative inline-flex size-2 rounded-full bg-destructive" />
            </span>
            <span className="text-xs">{formatElapsed(elapsedMs)}</span>
            <SquareIcon className="size-3 fill-current" />
          </>
        ) : busy ? (
          <LoaderCircleIcon className="animate-spin" />
        ) : (
          <MicIcon />
        )}
      </TooltipTrigger>
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}
