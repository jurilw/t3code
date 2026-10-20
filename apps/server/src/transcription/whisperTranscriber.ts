import { ServerTranscriptionError, type ServerTranscribeAudioInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/**
 * Dictation goes to a whisper.cpp `whisper-server` on the same host as this
 * server, so audio never leaves the machine and the GPU does the work. Run it
 * with `--convert` so it accepts the browser's webm/opus directly.
 */
export const DEFAULT_TRANSCRIBE_URL = "http://127.0.0.1:8178/inference";
const TRANSCRIBE_TIMEOUT_MS = 120_000;

/** whisper-server answers `{ text }` on success and `{ error }` on a bad upload. */
const decodeWhisperResponse = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      text: Schema.optional(Schema.String),
      error: Schema.optional(Schema.String),
    }),
  ),
);

export function resolveTranscribeUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const configured = env.T3CODE_TRANSCRIBE_URL?.trim();
  if (configured === undefined || configured === "") return DEFAULT_TRANSCRIBE_URL;
  // An explicit "off" lets a host opt out without the button pretending to work.
  return configured === "off" ? null : configured;
}

function extensionFor(mimeType: string): string {
  const base = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (base.endsWith("/ogg")) return "ogg";
  if (base.endsWith("/mp4") || base.endsWith("/m4a")) return "m4a";
  if (base.endsWith("/wav") || base.endsWith("/x-wav")) return "wav";
  if (base.endsWith("/mpeg")) return "mp3";
  return "webm";
}

/** whisper.cpp marks non-speech as `[BLANK_AUDIO]`, `(music)` and the like. */
export function cleanTranscript(text: string): string {
  return text
    .replace(/\[[A-Z_ ]+\]/g, " ")
    .replace(/\((?:music|silence|inaudible|applause|laughter)\)/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export const transcribeAudio = Effect.fn("transcription.transcribeAudio")(function* (
  input: ServerTranscribeAudioInput,
  request: (url: string, init: RequestInit) => Promise<Response> = globalThis.fetch,
) {
  const url = resolveTranscribeUrl();
  if (url === null) {
    return yield* new ServerTranscriptionError({
      reason: "unconfigured",
      detail: "Dictation is turned off on this server (T3CODE_TRANSCRIBE_URL=off).",
    });
  }
  const audio = Buffer.from(input.audioBase64, "base64");
  const form = new FormData();
  form.append(
    "file",
    new Blob([audio], { type: input.mimeType }),
    `dictation.${extensionFor(input.mimeType)}`,
  );
  form.append("response_format", "json");
  form.append("temperature", "0");
  if (input.language) form.append("language", input.language);

  const response = yield* Effect.tryPromise({
    try: (signal) =>
      request(url, {
        method: "POST",
        body: form,
        signal: AbortSignal.any([signal, AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS)]),
      }),
    catch: () =>
      new ServerTranscriptionError({
        reason: "unreachable",
        detail: `No speech-to-text server answered at ${url}. Start whisper-server on the host running T3 Code.`,
      }),
  });
  const body = yield* Effect.tryPromise({
    try: () => response.text(),
    catch: () =>
      new ServerTranscriptionError({ reason: "failed", detail: "Transcription was cut off." }),
  });
  if (!response.ok) {
    return yield* new ServerTranscriptionError({
      reason: "failed",
      detail: `Transcription failed (${response.status}): ${body.slice(0, 200)}`,
    });
  }
  const parsed = yield* decodeWhisperResponse(body).pipe(
    Effect.mapError(
      () =>
        new ServerTranscriptionError({
          reason: "failed",
          detail: `Transcription failed: ${body.slice(0, 200) || "empty response"}`,
        }),
    ),
  );
  if (parsed.text === undefined) {
    return yield* new ServerTranscriptionError({
      reason: "failed",
      detail: `Transcription failed: ${parsed.error ?? "unexpected response"}`,
    });
  }
  const text = parsed.text;
  return { text: cleanTranscript(text) };
});
