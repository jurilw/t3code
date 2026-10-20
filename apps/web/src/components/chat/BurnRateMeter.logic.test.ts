import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  appendSample,
  formatPace,
  headlineBurn,
  paceTone,
  providerBurns,
  recordReadings,
  recentRate,
  windowBurn,
} from "./BurnRateMeter.logic";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = Date.parse("2026-10-19T12:00:00.000Z");

function sessionWindow(usedPercent: number, msUntilReset: number): ServerProviderUsageWindow {
  return {
    id: "five_hour",
    kind: "session",
    label: "Session",
    usedPercent,
    resetsAt: new Date(NOW + msUntilReset).toISOString(),
    windowDurationMins: 300,
  };
}

describe("windowBurn", () => {
  it("is 1x when spend matches the clock", () => {
    // 2.5h of 5h gone, 50% used.
    const burn = windowBurn(sessionWindow(50, 2.5 * HOUR), NOW);
    expect(burn?.averagePace).toBeCloseTo(1);
    expect(burn?.msUntilExhausted).toBeNull();
  });

  it("projects running out before the reset when ahead of pace", () => {
    // 1h of 5h gone, 40% used: 2x, 60% left at 40%/h → 1.5h.
    const burn = windowBurn(sessionWindow(40, 4 * HOUR), NOW);
    expect(burn?.averagePace).toBeCloseTo(2);
    expect(burn?.msUntilExhausted).toBeCloseTo(1.5 * HOUR);
  });

  it("holds the average back in the first moments of a window", () => {
    const burn = windowBurn(sessionWindow(3, 5 * HOUR - MINUTE), NOW);
    expect(burn?.averagePace).toBeNull();
  });

  it("measures the recent rate against what is left, not the whole window", () => {
    // 50% used with 2.5h left: even is 20%/h. 10 points in the last 30m is 20%/h → 1x.
    const samples = [
      { at: NOW - 40 * MINUTE, usedPercent: 40 },
      { at: NOW - 5 * MINUTE, usedPercent: 50 },
    ];
    const burn = windowBurn(sessionWindow(50, 2.5 * HOUR), NOW, samples);
    expect(burn?.recentPace).toBeCloseTo(1);
  });

  it("marks a spent window as exhausted", () => {
    const burn = windowBurn(sessionWindow(100, HOUR), NOW);
    expect(burn?.exhausted).toBe(true);
    expect(paceTone(burn?.averagePace ?? null, true)).toBe("hot");
  });

  it("needs a reset time and a length", () => {
    expect(windowBurn({ ...sessionWindow(10, HOUR), resetsAt: undefined }, NOW)).toBeNull();
  });
});

describe("samples", () => {
  it("keeps only changes and ignores readings that go backwards", () => {
    let samples = appendSample([], { at: NOW - 10 * MINUTE, usedPercent: 10 });
    samples = appendSample(samples, { at: NOW - 9 * MINUTE, usedPercent: 10 });
    samples = appendSample(samples, { at: NOW - 8 * MINUTE, usedPercent: 8 });
    samples = appendSample(samples, { at: NOW - 7 * MINUTE, usedPercent: 12 });
    expect(samples.map((sample) => sample.usedPercent)).toEqual([10, 12]);
  });

  it("decays the recent rate through a quiet stretch", () => {
    const samples = [
      { at: NOW - 20 * MINUTE, usedPercent: 10 },
      { at: NOW - 15 * MINUTE, usedPercent: 20 },
    ];
    // 10 points over the 20 minutes since the first reading.
    expect(recentRate(samples, NOW)).toBeCloseTo(10 / (20 * MINUTE));
  });

  it("needs a few minutes of history", () => {
    expect(recentRate([{ at: NOW - MINUTE, usedPercent: 5 }], NOW)).toBeNull();
  });
});

describe("presentation", () => {
  it("headlines the hottest window", () => {
    const session = windowBurn(sessionWindow(20, 4 * HOUR), NOW)!;
    const weekly = windowBurn(
      {
        id: "seven_day",
        kind: "weekly",
        label: "Weekly",
        usedPercent: 60,
        resetsAt: new Date(NOW + 3.5 * 24 * HOUR).toISOString(),
        windowDurationMins: 7 * 24 * 60,
      },
      NOW,
    )!;
    expect(headlineBurn([session, weekly])?.id).toBe("seven_day");
  });

  it("formats multiples", () => {
    expect(formatPace(0.84)).toBe("0.8x");
    expect(formatPace(1.46)).toBe("1.5x");
    expect(formatPace(12.4)).toBe("12x");
    expect(formatPace(null)).toBe("–");
  });
});

describe("providerBurns", () => {
  const checkedAt = new Date(NOW).toISOString();

  it("is empty for accounts without quota windows, so the meter hides", () => {
    expect(providerBurns(undefined, NOW)).toEqual([]);
    expect(
      providerBurns({ checkedAt, windows: [], unavailable: { reason: "unsupported" } }, NOW),
    ).toEqual([]);
    expect(providerBurns({ checkedAt, windows: [] }, NOW)).toEqual([]);
  });

  it("skips windows it cannot pace and orders session before weekly", () => {
    const burns = providerBurns(
      {
        checkedAt,
        windows: [
          { id: "credits", kind: "other", label: "Credits", usedPercent: 10 },
          {
            id: "seven_day",
            kind: "weekly",
            label: "Weekly",
            usedPercent: 30,
            resetsAt: new Date(NOW + 3 * 24 * HOUR).toISOString(),
            windowDurationMins: 7 * 24 * 60,
          },
          sessionWindow(20, 4 * HOUR),
        ],
      },
      NOW,
    );
    expect(burns.map((burn) => burn.id)).toEqual(["five_hour", "seven_day"]);
  });
});

describe("recordReadings", () => {
  const report = (usedPercent: number, resetsAt: string) => ({
    // Deliberately stale: readings are stamped with the observation time.
    checkedAt: new Date(NOW - 6 * HOUR).toISOString(),
    windows: [{ ...sessionWindow(usedPercent, 2 * HOUR), resetsAt }],
  });
  const reset = new Date(NOW + 2 * HOUR);
  const probeReset = new Date(reset.getTime() + 812).toISOString();
  const eventReset = reset.toISOString();

  it("keeps one series when the same reset arrives with different precision", () => {
    let store = recordReadings({}, "claude:me", report(10, probeReset), NOW - 20 * MINUTE);
    store = recordReadings(store, "claude:me", report(14, eventReset), NOW - 10 * MINUTE);
    store = recordReadings(store, "claude:me", report(18, probeReset), NOW);
    const series = Object.values(store);
    expect(series).toHaveLength(1);
    expect(series[0]?.samples.map((sample) => sample.at)).toEqual([
      NOW - 20 * MINUTE,
      NOW - 10 * MINUTE,
      NOW,
    ]);
    // 8 points over 20 minutes with 82% left over 2h: 24%/h vs 41%/h.
    const burn = windowBurn(sessionWindow(18, 2 * HOUR), NOW, series[0]?.samples);
    expect(burn?.recentPace).toBeCloseTo(24 / 41, 1);
  });

  it("returns the same store when nothing moved", () => {
    const first = recordReadings({}, "claude:me", report(10, eventReset), NOW - 10 * MINUTE);
    expect(recordReadings(first, "claude:me", report(10, probeReset), NOW)).toBe(first);
  });

  it("starts over at a real reset and keeps other accounts", () => {
    let store = recordReadings({}, "codex:other", report(5, eventReset), NOW);
    store = recordReadings(store, "claude:me", report(80, eventReset), NOW - 10 * MINUTE);
    const nextWindow = new Date(reset.getTime() + 5 * HOUR).toISOString();
    store = recordReadings(store, "claude:me", report(2, nextWindow), NOW);
    expect(store["claude:me:five_hour"]?.samples.map((sample) => sample.usedPercent)).toEqual([2]);
    expect(store["codex:other:five_hour"]).toBeDefined();
  });

  it("ignores accounts without quota windows", () => {
    const store = {};
    expect(
      recordReadings(
        store,
        "claude:me",
        {
          checkedAt: new Date(NOW).toISOString(),
          windows: [],
          unavailable: { reason: "unsupported" },
        },
        NOW,
      ),
    ).toBe(store);
  });
});
