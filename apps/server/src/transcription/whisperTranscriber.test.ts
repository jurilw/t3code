import { describe, expect, it } from "vite-plus/test";

import {
  cleanTranscript,
  DEFAULT_TRANSCRIBE_URL,
  resolveTranscribeUrl,
} from "./whisperTranscriber.ts";

describe("whisperTranscriber", () => {
  it("drops whisper's non-speech markers and collapses whitespace", () => {
    expect(cleanTranscript(" [BLANK_AUDIO]\n Fix the build. (music) ")).toBe("Fix the build.");
  });

  it("defaults to a local whisper-server and can be turned off", () => {
    expect(resolveTranscribeUrl({})).toBe(DEFAULT_TRANSCRIBE_URL);
    expect(resolveTranscribeUrl({ T3CODE_TRANSCRIBE_URL: "http://gpu:9000/inference" })).toBe(
      "http://gpu:9000/inference",
    );
    expect(resolveTranscribeUrl({ T3CODE_TRANSCRIBE_URL: "off" })).toBeNull();
  });
});
