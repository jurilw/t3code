import { useSyncExternalStore } from "react";

import { toastManager } from "../ui/toast";

/**
 * One microphone, one dictation session. The recorder lives here rather than
 * in the button so that layout changes (the composer resting on a timeline
 * scroll, a thread switch) can never stop or discard a recording. A session
 * ends only on an explicit stop, Escape (discard), the length cap, or the
 * microphone track ending.
 */

export type DictationPhase = "idle" | "starting" | "recording" | "transcribing";

export interface DictationSnapshot {
  readonly phase: DictationPhase;
  /** The composer that started the session; its transcript goes back there. */
  readonly targetKey: string | null;
  /** Epoch ms when recording began; 0 unless recording. */
  readonly startedAt: number;
}

export type DictationTranscribeOutcome =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly message: string };

export type DictationTranscribe = (input: {
  readonly audioBase64: string;
  readonly mimeType: string;
}) => Promise<DictationTranscribeOutcome>;

/** Returns true when the text landed in the composer. */
export type DictationDeliverer = (text: string) => boolean;

interface RecorderLike {
  readonly state: "inactive" | "recording" | "paused";
  ondataavailable: ((event: { data: Blob }) => void) | null;
  onstop: (() => void) | null;
  start(timeslice?: number): void;
  stop(): void;
}

interface TrackLike {
  stop(): void;
  addEventListener(type: "ended", listener: () => void): void;
}

interface StreamLike {
  getTracks(): ReadonlyArray<TrackLike>;
}

export interface DictationNotice {
  readonly type: "info" | "error";
  readonly title: string;
  readonly description?: string;
}

export interface DictationDeps {
  pickMimeType(): string | undefined;
  getUserMedia(): Promise<StreamLike>;
  createRecorder(stream: StreamLike, mimeType: string): RecorderLike;
  blobToBase64(blob: Blob): Promise<string>;
  copyToClipboard(text: string): Promise<boolean>;
  notify(notice: DictationNotice): void;
  /** Subscribes to Escape key presses; returns the unsubscribe. */
  onEscape(handler: () => void): () => void;
  now(): number;
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Long enough for a long prompt, short enough that one clip stays one frame. */
export const MAX_RECORDING_MS = 5 * 60_000;
/** Shorter than this is a misclick, not speech. */
export const MIN_RECORDING_MS = 400;

const IDLE: DictationSnapshot = { phase: "idle", targetKey: null, startedAt: 0 };

export function dictationTargetKey(environmentId: string, composerKey: string): string {
  return `${environmentId}::${composerKey}`;
}

export function createDictationSessionStore(deps: DictationDeps) {
  let snapshot: DictationSnapshot = IDLE;
  const listeners = new Set<() => void>();
  const deliverers = new Map<string, DictationDeliverer[]>();
  const pending = new Map<string, string>();

  let recorder: RecorderLike | null = null;
  let stream: StreamLike | null = null;
  let discard = false;
  let capTimer: unknown = null;
  let removeEscape: (() => void) | null = null;

  function set(next: DictationSnapshot) {
    snapshot = next;
    for (const listener of listeners) listener();
  }

  function releaseStream() {
    if (capTimer !== null) {
      deps.clearTimeout(capTimer);
      capTimer = null;
    }
    removeEscape?.();
    removeEscape = null;
    const current = stream;
    stream = null;
    if (current) for (const track of current.getTracks()) track.stop();
  }

  function deliverNow(targetKey: string, text: string): boolean {
    const stack = deliverers.get(targetKey);
    const deliver = stack?.[stack.length - 1];
    if (!deliver) return false;
    try {
      return deliver(text);
    } catch {
      return false;
    }
  }

  function holdPending(targetKey: string, text: string) {
    const existing = pending.get(targetKey);
    pending.set(targetKey, existing ? `${existing} ${text}` : text);
    void deps.copyToClipboard(text).then((copied) => {
      deps.notify({
        type: "info",
        title: "Dictation saved",
        description: copied
          ? "Copied to the clipboard; it will also be inserted when you return to that composer."
          : "It will be inserted when you return to that composer.",
      });
    });
  }

  function deliver(targetKey: string, text: string) {
    if (deliverNow(targetKey, text)) return;
    holdPending(targetKey, text);
  }

  async function finish(
    targetKey: string,
    blob: Blob,
    mimeType: string,
    durationMs: number,
    transcribe: DictationTranscribe,
  ) {
    if (discard || durationMs < MIN_RECORDING_MS || blob.size === 0) {
      set(IDLE);
      return;
    }
    set({ phase: "transcribing", targetKey, startedAt: 0 });
    try {
      const audioBase64 = await deps.blobToBase64(blob);
      const result = await transcribe({ audioBase64, mimeType });
      if (!result.ok) {
        deps.notify({ type: "error", title: "Dictation failed", description: result.message });
      } else if (result.text) {
        deliver(targetKey, result.text);
      } else {
        deps.notify({ type: "info", title: "No speech detected" });
      }
    } catch (cause) {
      deps.notify({
        type: "error",
        title: "Dictation failed",
        description: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      set(IDLE);
    }
  }

  function stop(discardRecording: boolean) {
    if (snapshot.phase !== "recording" || !recorder) return;
    discard = discardRecording;
    if (recorder.state !== "inactive") {
      recorder.stop();
    } else {
      // Already stopped without an onstop; make sure the mic is released.
      recorder = null;
      releaseStream();
      set(IDLE);
    }
  }

  async function start(targetKey: string, transcribe: DictationTranscribe): Promise<void> {
    if (snapshot.phase !== "idle") return;
    const mimeType = deps.pickMimeType();
    if (!mimeType) {
      deps.notify({
        type: "error",
        title: "Dictation unavailable",
        description: "This window cannot record audio.",
      });
      return;
    }
    set({ phase: "starting", targetKey, startedAt: 0 });
    let opened: StreamLike;
    try {
      opened = await deps.getUserMedia();
    } catch (cause) {
      set(IDLE);
      deps.notify({
        type: "error",
        title: "Microphone unavailable",
        description:
          typeof cause === "object" &&
          cause !== null &&
          (cause as { name?: unknown }).name === "NotAllowedError"
            ? "Microphone access was denied."
            : "No microphone could be opened.",
      });
      return;
    }
    stream = opened;
    let next: RecorderLike;
    try {
      next = deps.createRecorder(opened, mimeType);
    } catch (cause) {
      releaseStream();
      set(IDLE);
      deps.notify({
        type: "error",
        title: "Dictation unavailable",
        description: cause instanceof Error ? cause.message : "Could not start recording.",
      });
      return;
    }
    const chunks: Blob[] = [];
    const startedAt = deps.now();
    discard = false;
    next.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    next.onstop = () => {
      if (recorder !== next) return;
      recorder = null;
      releaseStream();
      void finish(
        targetKey,
        new Blob(chunks, { type: mimeType }),
        mimeType,
        deps.now() - startedAt,
        transcribe,
      );
    };
    // A microphone that goes away (unplugged, revoked) ends the clip; what was
    // captured so far is still transcribed.
    for (const track of opened.getTracks()) {
      track.addEventListener("ended", () => stop(false));
    }
    recorder = next;
    capTimer = deps.setTimeout(() => stop(false), MAX_RECORDING_MS);
    removeEscape = deps.onEscape(() => stop(true));
    next.start(1000);
    set({ phase: "recording", targetKey, startedAt });
  }

  /**
   * Registers the mounted composer for a target. Text held for that target is
   * delivered right away. Returns the unregister function.
   */
  function registerDeliverer(targetKey: string, deliverer: DictationDeliverer): () => void {
    const stack = deliverers.get(targetKey) ?? [];
    stack.push(deliverer);
    deliverers.set(targetKey, stack);
    flushPending(targetKey);
    return () => {
      const current = deliverers.get(targetKey);
      if (!current) return;
      const index = current.lastIndexOf(deliverer);
      if (index !== -1) current.splice(index, 1);
      if (current.length === 0) deliverers.delete(targetKey);
    };
  }

  function flushPending(targetKey: string): boolean {
    const text = pending.get(targetKey);
    if (text === undefined) return false;
    if (!deliverNow(targetKey, text)) return false;
    pending.delete(targetKey);
    return true;
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start,
    stop,
    registerDeliverer,
    flushPending,
    getPending: (targetKey: string): string | undefined => pending.get(targetKey),
  };
}

export type DictationSessionStore = ReturnType<typeof createDictationSessionStore>;

const PREFERRED_MIME_TYPES = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/webm"];

function browserDeps(): DictationDeps {
  return {
    pickMimeType() {
      if (typeof MediaRecorder === "undefined") return undefined;
      if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
        return undefined;
      }
      return PREFERRED_MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
    },
    getUserMedia: () =>
      navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
      }),
    createRecorder: (stream, mimeType) =>
      new MediaRecorder(stream as MediaStream, { mimeType }) as unknown as RecorderLike,
    blobToBase64: (blob) =>
      new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.addEventListener("error", () =>
          reject(reader.error ?? new Error("Could not read the recording.")),
        );
        reader.addEventListener("load", () => {
          const result = typeof reader.result === "string" ? reader.result : "";
          resolve(result.slice(result.indexOf(",") + 1));
        });
        reader.readAsDataURL(blob);
      }),
    async copyToClipboard(text) {
      try {
        if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) return false;
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        return false;
      }
    },
    notify: (notice) => {
      toastManager.add(notice);
    },
    onEscape(handler) {
      const onKeyDown = (event: KeyboardEvent) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        handler();
      };
      window.addEventListener("keydown", onKeyDown, true);
      return () => window.removeEventListener("keydown", onKeyDown, true);
    },
    now: () => Date.now(),
    setTimeout: (handler, ms) => window.setTimeout(handler, ms),
    clearTimeout: (handle) => window.clearTimeout(handle as number),
  };
}

/** The app-wide session: there is one microphone. */
export const dictationSession: DictationSessionStore = createDictationSessionStore(browserDeps());

export function useDictationSession(): DictationSnapshot {
  return useSyncExternalStore(
    dictationSession.subscribe,
    dictationSession.getSnapshot,
    dictationSession.getSnapshot,
  );
}

/** True while any session is starting, recording or transcribing. */
export function useIsDictating(): boolean {
  return useDictationSession().phase !== "idle";
}
