import { describe, expect, it, vi } from "vite-plus/test";

import {
  type DictationDeps,
  type DictationNotice,
  type DictationTranscribe,
  MAX_RECORDING_MS,
  createDictationSessionStore,
} from "./dictationSession";

class FakeTrack {
  stopped = false;
  private endedListeners: Array<() => void> = [];
  stop() {
    this.stopped = true;
  }
  addEventListener(_type: "ended", listener: () => void) {
    this.endedListeners.push(listener);
  }
  end() {
    for (const listener of this.endedListeners) listener();
  }
}

class FakeRecorder {
  state: "inactive" | "recording" | "paused" = "inactive";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["audio"]) });
    this.onstop?.();
  }
}

function setup() {
  let now = 1_000;
  const track = new FakeTrack();
  const recorders: FakeRecorder[] = [];
  const notices: DictationNotice[] = [];
  const clipboard: string[] = [];
  const timers = new Map<number, () => void>();
  let nextTimer = 1;
  let escapeHandler: (() => void) | null = null;

  const deps: DictationDeps = {
    pickMimeType: () => "audio/webm",
    getUserMedia: async () => ({ getTracks: () => [track] }),
    createRecorder: () => {
      const recorder = new FakeRecorder();
      recorders.push(recorder);
      return recorder;
    },
    blobToBase64: async () => "QUJD",
    copyToClipboard: async (text) => {
      clipboard.push(text);
      return true;
    },
    notify: (notice) => notices.push(notice),
    onEscape: (handler) => {
      escapeHandler = handler;
      return () => {
        if (escapeHandler === handler) escapeHandler = null;
      };
    },
    now: () => now,
    setTimeout: (handler) => {
      const id = nextTimer++;
      timers.set(id, handler);
      return id;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as number);
    },
  };

  const store = createDictationSessionStore(deps);
  const transcribe = vi.fn<DictationTranscribe>(async () => ({ ok: true, text: "hello world" }));
  return {
    store,
    track,
    recorders,
    notices,
    clipboard,
    timers,
    transcribe,
    advance: (ms: number) => {
      now += ms;
    },
    pressEscape: () => escapeHandler?.(),
    hasEscapeHandler: () => escapeHandler !== null,
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("dictationSession", () => {
  it("keeps recording after the button that started it unmounts", async () => {
    const t = setup();
    const unregister = t.store.registerDeliverer("env::thread-a", () => true);
    await t.store.start("env::thread-a", t.transcribe);
    expect(t.store.getSnapshot()).toMatchObject({ phase: "recording", targetKey: "env::thread-a" });

    // The composer rests / the thread switches: the button unmounts.
    unregister();

    expect(t.store.getSnapshot().phase).toBe("recording");
    expect(t.recorders[0]?.state).toBe("recording");
    expect(t.track.stopped).toBe(false);
  });

  it("delivers the transcript to the composer that started it", async () => {
    const t = setup();
    const intoA = vi.fn(() => true);
    const intoB = vi.fn(() => true);
    t.store.registerDeliverer("env::thread-a", intoA);
    t.store.registerDeliverer("env::thread-b", intoB);
    await t.store.start("env::thread-a", t.transcribe);
    t.advance(2_000);
    t.store.stop(false);
    await flush();

    expect(t.transcribe).toHaveBeenCalledWith({ audioBase64: "QUJD", mimeType: "audio/webm" });
    expect(intoA).toHaveBeenCalledWith("hello world");
    expect(intoB).not.toHaveBeenCalled();
    expect(t.track.stopped).toBe(true);
    expect(t.store.getSnapshot().phase).toBe("idle");
    expect(t.clipboard).toEqual([]);
  });

  it("discards on Escape, releases the mic and stops listening for Escape", async () => {
    const t = setup();
    const deliver = vi.fn(() => true);
    t.store.registerDeliverer("env::thread-a", deliver);
    expect(t.hasEscapeHandler()).toBe(false);
    await t.store.start("env::thread-a", t.transcribe);
    expect(t.hasEscapeHandler()).toBe(true);
    t.advance(2_000);
    t.pressEscape();
    await flush();

    expect(t.transcribe).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
    expect(t.track.stopped).toBe(true);
    expect(t.hasEscapeHandler()).toBe(false);
    expect(t.timers.size).toBe(0);
    expect(t.store.getSnapshot().phase).toBe("idle");
  });

  it("holds the transcript when its composer is gone and inserts it on return", async () => {
    const t = setup();
    const unregister = t.store.registerDeliverer("env::thread-a", () => true);
    await t.store.start("env::thread-a", t.transcribe);
    unregister();
    t.advance(2_000);
    t.store.stop(false);
    await flush();

    expect(t.store.getPending("env::thread-a")).toBe("hello world");
    expect(t.clipboard).toEqual(["hello world"]);
    expect(t.notices).toContainEqual(expect.objectContaining({ type: "info" }));

    // A different composer mounting does not take it.
    const intoB = vi.fn(() => true);
    t.store.registerDeliverer("env::thread-b", intoB);
    expect(intoB).not.toHaveBeenCalled();

    const intoA = vi.fn(() => true);
    t.store.registerDeliverer("env::thread-a", intoA);
    expect(intoA).toHaveBeenCalledWith("hello world");
    expect(t.store.getPending("env::thread-a")).toBeUndefined();
  });

  it("keeps the text pending when the mounted composer refuses it", async () => {
    const t = setup();
    t.store.registerDeliverer("env::thread-a", () => false);
    await t.store.start("env::thread-a", t.transcribe);
    t.advance(2_000);
    t.store.stop(false);
    await flush();

    expect(t.store.getPending("env::thread-a")).toBe("hello world");
    expect(t.clipboard).toEqual(["hello world"]);
  });

  it("transcribes at the length cap", async () => {
    const t = setup();
    const deliver = vi.fn(() => true);
    t.store.registerDeliverer("env::thread-a", deliver);
    await t.store.start("env::thread-a", t.transcribe);
    expect(t.timers.size).toBe(1);
    t.advance(MAX_RECORDING_MS);
    for (const handler of t.timers.values()) handler();
    await flush();

    expect(deliver).toHaveBeenCalledWith("hello world");
    expect(t.track.stopped).toBe(true);
  });

  it("transcribes what was captured when the microphone track ends", async () => {
    const t = setup();
    const deliver = vi.fn(() => true);
    t.store.registerDeliverer("env::thread-a", deliver);
    await t.store.start("env::thread-a", t.transcribe);
    t.advance(2_000);
    t.track.end();
    await flush();

    expect(deliver).toHaveBeenCalledWith("hello world");
    expect(t.store.getSnapshot().phase).toBe("idle");
  });

  it("ignores a second start while a session is active", async () => {
    const t = setup();
    await t.store.start("env::thread-a", t.transcribe);
    await t.store.start("env::thread-b", t.transcribe);
    expect(t.recorders).toHaveLength(1);
    expect(t.store.getSnapshot().targetKey).toBe("env::thread-a");
  });

  it("drops misclicks shorter than the minimum", async () => {
    const t = setup();
    await t.store.start("env::thread-a", t.transcribe);
    t.advance(100);
    t.store.stop(false);
    await flush();
    expect(t.transcribe).not.toHaveBeenCalled();
    expect(t.track.stopped).toBe(true);
    expect(t.store.getSnapshot().phase).toBe("idle");
  });
});
