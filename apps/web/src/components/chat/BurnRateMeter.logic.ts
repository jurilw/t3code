import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import { elapsedShare } from "@t3tools/shared/usageLimits";

/**
 * Burn rate as a multiple of the even pace. 1x spends the window's quota at
 * exactly the rate that reaches 100% at the reset; 2x runs dry halfway there.
 */

const MINUTE = 60_000;
/** Below this share of a window the average is mostly noise from the first turn. */
const MIN_ELAPSED_SHARE = 0.01;
/** The "now" rate looks back this far, and needs at least the minimum span to say anything. */
export const RECENT_LOOKBACK_MS = 30 * MINUTE;
const RECENT_MIN_SPAN_MS = 5 * MINUTE;
const MAX_SAMPLES_PER_WINDOW = 120;

export interface UsageSample {
  readonly at: number;
  readonly usedPercent: number;
}

export interface WindowBurn {
  readonly id: string;
  readonly kind: ServerProviderUsageWindow["kind"];
  readonly label: string;
  readonly usedPercent: number;
  /** Share of the window that has passed, 0..1. */
  readonly elapsed: number;
  readonly msUntilReset: number;
  /** Used share over elapsed share since the window opened; null too early to tell. */
  readonly averagePace: number | null;
  /** Recent spend rate over the rate that lands exactly on 100% at reset. */
  readonly recentPace: number | null;
  /** At the average rate, how long until 100%; null when it would not run out first. */
  readonly msUntilExhausted: number | null;
  readonly exhausted: boolean;
}

/** One window's readings since it last reset. */
export interface SampleSeries {
  /** The reset this series belongs to, epoch ms; null when the provider did not say. */
  readonly resetsAt: number | null;
  readonly samples: readonly UsageSample[];
}

export type SampleStore = Readonly<Record<string, SampleSeries>>;

/**
 * Providers report the same reset with different precision depending on the
 * source (Claude's usage probe has fractional seconds, its streamed events do
 * not), so a reset only counts as new once it moves by more than this.
 */
const RESET_TOLERANCE_MS = 30 * MINUTE;

function parseReset(window: ServerProviderUsageWindow): number | null {
  const parsed = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function isNewWindow(series: SampleSeries, resetsAt: number | null, usedPercent: number): boolean {
  if (resetsAt !== null && series.resetsAt !== null) {
    if (Math.abs(resetsAt - series.resetsAt) > RESET_TOLERANCE_MS) return true;
  }
  // A large drop with no reset time to compare means the window rolled over.
  const last = series.samples.at(-1);
  return last !== undefined && usedPercent < last.usedPercent - 5;
}

/**
 * Fold one usage report into the stored series. Readings are stamped with
 * when this client saw them (`now`), not the report's `checkedAt`: streamed
 * updates merge into a snapshot whose `checkedAt` can be much older. Returns
 * the same object when nothing changed. Other scopes keep their series; this
 * scope's windows that are no longer reported are dropped.
 */
export function recordReadings(
  store: SampleStore,
  scope: string,
  limits: ServerProviderUsageLimits | undefined,
  now: number,
): SampleStore {
  if (!limits || limits.unavailable) return store;
  let changed = false;
  const next: Record<string, SampleSeries> = {};
  const live = new Set<string>();
  for (const window of limits.windows) {
    const key = sampleKey(scope, window);
    live.add(key);
    const resetsAt = parseReset(window);
    const current = store[key];
    const sample = { at: now, usedPercent: window.usedPercent };
    if (!current || isNewWindow(current, resetsAt, window.usedPercent)) {
      next[key] = { resetsAt, samples: [sample] };
      changed = true;
      continue;
    }
    const samples = appendSample(current.samples, sample);
    if (samples === current.samples) {
      next[key] = current;
      continue;
    }
    next[key] = { resetsAt: resetsAt ?? current.resetsAt, samples };
    changed = true;
  }
  for (const [key, series] of Object.entries(store)) {
    if (live.has(key)) continue;
    if (key.startsWith(`${scope}:`)) {
      changed = true;
      continue;
    }
    next[key] = series;
  }
  return changed ? next : store;
}

/** One series per account window; resets are detected from the data, not the key. */
export function sampleKey(scope: string, window: ServerProviderUsageWindow): string {
  return `${scope}:${window.id}`;
}

/** Append one observation, dropping repeats and anything outside the lookback. */
export function appendSample(
  samples: readonly UsageSample[],
  sample: UsageSample,
): readonly UsageSample[] {
  const last = samples.at(-1);
  // Same reading again only moves the clock; keep the first so the span is honest.
  if (last && last.usedPercent === sample.usedPercent) return samples;
  // Usage never goes down inside one window; a drop means a stale reading arrived late.
  if (last && sample.usedPercent < last.usedPercent) return samples;
  const cutoff = sample.at - RECENT_LOOKBACK_MS * 2;
  return [...samples.filter((entry) => entry.at >= cutoff), sample].slice(-MAX_SAMPLES_PER_WINDOW);
}

/**
 * Percent per millisecond over the lookback. The span runs from the oldest
 * reading in the lookback to now, so a quiet stretch since the last turn
 * pulls the rate down instead of freezing it at its last value.
 */
export function recentRate(samples: readonly UsageSample[], now: number): number | null {
  const inWindow = samples.filter((entry) => entry.at >= now - RECENT_LOOKBACK_MS);
  // The reading just before the lookback anchors the start, so a single
  // jump inside it still counts.
  const before = samples.findLast((entry) => entry.at < now - RECENT_LOOKBACK_MS);
  const first = before ?? inWindow[0];
  const last = inWindow.at(-1) ?? before;
  if (!first || !last) return null;
  const start = Math.max(first.at, now - RECENT_LOOKBACK_MS);
  const span = now - start;
  if (span < RECENT_MIN_SPAN_MS) return null;
  return Math.max(0, last.usedPercent - first.usedPercent) / span;
}

export function windowBurn(
  window: ServerProviderUsageWindow,
  now: number,
  samples: readonly UsageSample[] = [],
): WindowBurn | null {
  const elapsed = elapsedShare(window, now);
  const resetsAt = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
  if (elapsed === null || !Number.isFinite(resetsAt)) return null;
  const msUntilReset = Math.max(0, resetsAt - now);
  const used = window.usedPercent;
  const exhausted = used >= 100;
  const averagePace = elapsed >= MIN_ELAPSED_SHARE ? used / (elapsed * 100) : null;

  const rate = recentRate(samples, now);
  const evenRate = msUntilReset > 0 ? (100 - used) / msUntilReset : null;
  const recentPace =
    exhausted || rate === null || evenRate === null || evenRate <= 0 ? null : rate / evenRate;

  let msUntilExhausted: number | null = null;
  const elapsedMs = elapsed * (window.windowDurationMins ?? 0) * MINUTE;
  if (!exhausted && used > 0 && elapsedMs > 0) {
    const eta = ((100 - used) / used) * elapsedMs;
    if (eta < msUntilReset) msUntilExhausted = eta;
  }

  return {
    id: window.id,
    kind: window.kind,
    label: window.label,
    usedPercent: used,
    elapsed,
    msUntilReset,
    averagePace,
    recentPace,
    msUntilExhausted: exhausted ? 0 : msUntilExhausted,
    exhausted,
  };
}

const KIND_ORDER: Record<ServerProviderUsageWindow["kind"], number> = {
  session: 0,
  weekly: 1,
  monthly: 2,
  other: 3,
};

export function sortBurns(burns: readonly WindowBurn[]): WindowBurn[] {
  return [...burns].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
}

/**
 * Every window that can be paced, hottest first by kind. Empty for API-key and
 * metered accounts (no quota windows), which hides the meter entirely.
 */
export function providerBurns(
  limits: ServerProviderUsageLimits | undefined,
  now: number,
  samplesFor: (window: ServerProviderUsageWindow) => readonly UsageSample[] | undefined = () =>
    undefined,
): WindowBurn[] {
  if (!limits || limits.unavailable) return [];
  return sortBurns(
    limits.windows.flatMap((window) => {
      const burn = windowBurn(window, now, samplesFor(window));
      return burn ? [burn] : [];
    }),
  );
}

/** The window to show on the button: whichever is burning hottest against its clock. */
export function headlineBurn(burns: readonly WindowBurn[]): WindowBurn | null {
  let best: WindowBurn | null = null;
  for (const burn of burns) {
    if (burn.exhausted) return burn;
    if (burn.averagePace === null) continue;
    if (!best || (best.averagePace ?? 0) < burn.averagePace) best = burn;
  }
  return best ?? burns[0] ?? null;
}

/** `0.8x`, `1.4x`, `12x`. */
export function formatPace(pace: number | null): string {
  if (pace === null || !Number.isFinite(pace)) return "–";
  if (pace >= 10) return `${Math.round(pace)}x`;
  return `${pace.toFixed(1)}x`;
}

export type PaceTone = "calm" | "warm" | "hot";

/** Within 10% of even is fine; past 1.5x the window will clearly run out early. */
export function paceTone(pace: number | null, exhausted = false): PaceTone {
  if (exhausted) return "hot";
  if (pace === null || pace <= 1.1) return "calm";
  return pace <= 1.5 ? "warm" : "hot";
}
