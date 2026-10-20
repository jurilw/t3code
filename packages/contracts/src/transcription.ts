import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Upper bound on one dictation clip, in base64 characters. Opus at the
 * browser's default bitrate is roughly 4 KB a second, so this is several
 * minutes of speech while keeping one WebSocket frame reasonable.
 */
export const TRANSCRIBE_AUDIO_MAX_BASE64_LENGTH = 8 * 1024 * 1024;

/** One recorded clip from the composer's dictation button. */
export const ServerTranscribeAudioInput = Schema.Struct({
  audioBase64: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(TRANSCRIBE_AUDIO_MAX_BASE64_LENGTH),
  ),
  /** The recorder's container, e.g. `audio/webm;codecs=opus`. */
  mimeType: TrimmedNonEmptyString,
  /** ISO 639-1 hint; omitted lets the model detect the language. */
  language: Schema.optional(TrimmedNonEmptyString),
});
export type ServerTranscribeAudioInput = typeof ServerTranscribeAudioInput.Type;

export const ServerTranscribeAudioResult = Schema.Struct({
  text: Schema.String,
});
export type ServerTranscribeAudioResult = typeof ServerTranscribeAudioResult.Type;

export class ServerTranscriptionError extends Schema.TaggedError<ServerTranscriptionError>()(
  "ServerTranscriptionError",
  {
    reason: Schema.Literals(["unconfigured", "unreachable", "failed"]),
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}
