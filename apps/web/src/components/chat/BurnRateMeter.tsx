import type { ServerProvider } from "@t3tools/contracts";
import { formatDuration } from "@t3tools/shared/usageLimits";
import * as Schema from "effect/Schema";
import { FlameIcon } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";

import { getLocalStorageItem, setLocalStorageItem } from "~/hooks/useLocalStorage";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import {
  formatPace,
  headlineBurn,
  type PaceTone,
  paceTone,
  providerBurns,
  recordReadings,
  RECENT_LOOKBACK_MS,
  sampleKey,
  type SampleStore,
  type WindowBurn,
} from "./BurnRateMeter.logic";
import { composerFloatingLayerProps } from "./composerEventScope";

const SAMPLES_STORAGE_KEY = "t3code:burn-rate-samples:v2";
const TICK_MS = 30_000;

const SampleStoreSchema = Schema.Record(
  Schema.String,
  Schema.Struct({
    resetsAt: Schema.NullOr(Schema.Number),
    samples: Schema.Array(Schema.Struct({ at: Schema.Number, usedPercent: Schema.Number })),
  }),
);

function readSamples(): SampleStore {
  try {
    return getLocalStorageItem(SAMPLES_STORAGE_KEY, SampleStoreSchema) ?? {};
  } catch {
    return {};
  }
}

function writeSamples(store: SampleStore): void {
  try {
    setLocalStorageItem(SAMPLES_STORAGE_KEY, store, SampleStoreSchema);
  } catch {
    // Storage full or blocked: the recent rate just stays unknown.
  }
}

/**
 * Every usage reading any composer has seen, kept per window in localStorage
 * so the popover can say how fast the last half hour went, not only the
 * average since the window opened. Shared by every mounted meter.
 */
let sampleStore: SampleStore | null = null;
const sampleListeners = new Set<() => void>();

function getSampleStore(): SampleStore {
  sampleStore ??= readSamples();
  return sampleStore;
}

function subscribeSamples(listener: () => void): () => void {
  sampleListeners.add(listener);
  return () => sampleListeners.delete(listener);
}

function recordSamples(scope: string, limits: ServerProvider["usageLimits"]): void {
  const current = getSampleStore();
  const next = recordReadings(current, scope, limits, Date.now());
  if (next === current) return;
  sampleStore = next;
  writeSamples(next);
  for (const listener of sampleListeners) listener();
}

function useUsageSamples(scope: string, limits: ServerProvider["usageLimits"]): SampleStore {
  useEffect(() => recordSamples(scope, limits), [scope, limits]);
  return useSyncExternalStore(subscribeSamples, getSampleStore, getSampleStore);
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

const TONE_TEXT: Record<PaceTone, string> = {
  calm: "text-muted-foreground",
  warm: "text-warning",
  hot: "text-destructive",
};

const TONE_FILL: Record<PaceTone, string> = {
  calm: "bg-muted-foreground/60",
  warm: "bg-warning",
  hot: "bg-destructive",
};

function describeBurn(burn: WindowBurn): string {
  if (burn.exhausted) return `Limit reached · resets in ${formatDuration(burn.msUntilReset)}`;
  if (burn.msUntilExhausted !== null) {
    return `At this average you hit 100% in ${formatDuration(burn.msUntilExhausted)}, ${formatDuration(
      burn.msUntilReset - burn.msUntilExhausted,
    )} before the reset`;
  }
  return `Resets in ${formatDuration(burn.msUntilReset)} with room to spare`;
}

function BurnRow({ burn }: { readonly burn: WindowBurn }) {
  const averageTone = paceTone(burn.averagePace, burn.exhausted);
  const recentTone = paceTone(burn.recentPace);
  const used = Math.max(0, Math.min(100, burn.usedPercent));
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-medium text-xs">{burn.label}</span>
        <span className="flex items-baseline gap-2 tabular-nums">
          {burn.exhausted ? null : (
            <span className="text-2xs text-secondary-label">
              now{" "}
              <span className={cn("font-medium", TONE_TEXT[recentTone])}>
                {formatPace(burn.recentPace)}
              </span>
            </span>
          )}
          <span className={cn("font-semibold text-sm", TONE_TEXT[averageTone])}>
            {burn.exhausted ? "maxed" : formatPace(burn.averagePace)}
          </span>
        </span>
      </div>
      {/* Fill is quota spent; the hairline is the clock, where 1x would put the fill. */}
      <div
        className="relative h-1.5 w-full overflow-hidden rounded-full bg-muted/60"
        role="img"
        aria-label={`${Math.round(used)}% used, ${Math.round(burn.elapsed * 100)}% of the window elapsed`}
      >
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-500",
            TONE_FILL[averageTone],
          )}
          style={{ width: `${used}%` }}
        />
        <div
          className="absolute inset-y-0 w-px bg-foreground/70"
          style={{ left: `${Math.round(burn.elapsed * 100)}%` }}
        />
      </div>
      <div className="text-2xs text-secondary-label tabular-nums">
        {Math.round(used)}% used · {Math.round(burn.elapsed * 100)}% of the window elapsed
      </div>
      <div className="text-pretty text-2xs text-secondary-label">{describeBurn(burn)}</div>
    </div>
  );
}

/**
 * Footer button showing how fast the selected provider's quota is burning,
 * as a multiple of the pace that would land on exactly 100% at each window's
 * reset. The button shows the hottest window; the popover shows them all.
 */
export function BurnRateMeter({ provider }: { readonly provider: ServerProvider }) {
  const limits = provider.usageLimits;
  const scope = `${provider.instanceId}:${provider.auth.email ?? ""}`;
  const samples = useUsageSamples(scope, limits);
  const now = useNow(TICK_MS);

  const burns = providerBurns(limits, now, (window) => samples[sampleKey(scope, window)]?.samples);

  const headline = headlineBurn(burns);
  if (!headline) return null;
  const tone = paceTone(headline.averagePace, headline.exhausted);

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={150}
        render={
          <Button
            type="button"
            size="xs"
            variant="ghost-muted"
            onPointerDown={(event) => event.preventDefault()}
            aria-label={`Usage burn rate ${formatPace(headline.averagePace)} on ${headline.label}`}
          >
            <span className={cn("inline-flex items-center gap-1 tabular-nums", TONE_TEXT[tone])}>
              <FlameIcon aria-hidden="true" className="size-3.5" />
              <span className="text-xs font-medium">
                {headline.exhausted ? "max" : formatPace(headline.averagePace)}
              </span>
            </span>
          </Button>
        }
      />
      <PopoverPopup
        {...composerFloatingLayerProps}
        tooltipStyle
        side="top"
        align="end"
        padding="none"
        width="md"
        className="text-left whitespace-normal"
      >
        <div className="flex flex-col gap-3 p-(--floating-content-inset)">
          <div className="flex items-center justify-between gap-3">
            <div className="font-medium text-muted-foreground text-xs">Burn rate</div>
            <div className="text-2xs text-secondary-label">1x lands on 100% at the reset</div>
          </div>
          {burns.map((burn) => (
            <BurnRow key={burn.id} burn={burn} />
          ))}
          <div className="text-pretty text-2xs text-secondary-label">
            Big number: average since the window opened. Now: the last {RECENT_LOOKBACK_MS / 60_000}{" "}
            minutes against what is left.
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
