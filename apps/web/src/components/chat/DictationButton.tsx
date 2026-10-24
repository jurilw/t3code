import type { EnvironmentId } from "@t3tools/contracts";
import { LoaderCircleIcon, MicIcon, SquareIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  type DictationTranscribe,
  dictationSession,
  dictationTargetKey,
  useDictationSession,
} from "./dictationSession";

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
 * environment's host (whisper-server) and the text lands at the caret of the
 * composer that started it. Escape while recording throws the clip away.
 *
 * The recording itself lives in `dictationSession`, so this button can
 * unmount (thread switch, layout change) without losing it; a transcript for
 * a composer that is not mounted is held and inserted when it returns.
 */
export function DictationButton(props: {
  readonly environmentId: EnvironmentId;
  /** Identifies this composer (draft or thread) within the environment. */
  readonly composerKey: string;
  readonly disabled?: boolean;
  /** Inserts the text; returns false when the composer could not take it. */
  readonly onTranscript: (text: string) => boolean;
}) {
  const { environmentId, composerKey, onTranscript } = props;
  const targetKey = dictationTargetKey(environmentId, composerKey);
  const transcribeCommand = useAtomCommand(serverEnvironment.transcribeAudio, {
    reportFailure: false,
  });
  const session = useDictationSession();
  const [elapsedMs, setElapsedMs] = useState(0);

  const onTranscriptRef = useRef(onTranscript);
  useEffect(() => {
    onTranscriptRef.current = onTranscript;
  }, [onTranscript]);

  useEffect(
    () => dictationSession.registerDeliverer(targetKey, (text) => onTranscriptRef.current(text)),
    [targetKey],
  );

  const recording = session.phase === "recording";

  // Display-only timer; the cap is enforced by the session.
  useEffect(() => {
    if (!recording) return;
    const tick = () => setElapsedMs(Date.now() - session.startedAt);
    tick();
    const id = window.setInterval(tick, 250);
    return () => window.clearInterval(id);
  }, [recording, session.startedAt]);

  const start = useCallback(() => {
    const transcribe: DictationTranscribe = async (input) => {
      const result = await transcribeCommand({ environmentId, input });
      return result._tag === "Success"
        ? { ok: true, text: result.value.text }
        : { ok: false, message: failureMessage(result.cause) };
    };
    void dictationSession.start(targetKey, transcribe);
  }, [environmentId, targetKey, transcribeCommand]);

  const busy = session.phase === "starting" || session.phase === "transcribing";
  const label = recording
    ? "Stop and transcribe (Esc to discard)"
    : session.phase === "transcribing"
      ? "Transcribing…"
      : "Dictate a prompt";

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant={recording ? "ghost-destructive" : "ghost"}
            size={recording ? "sm" : "icon-sm"}
            disabled={(props.disabled && !recording) || busy}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => (recording ? dictationSession.stop(false) : start())}
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
            <span className="text-xs tabular-nums">{formatElapsed(elapsedMs)}</span>
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
