// How much work an execution did inside one provider run. Turn count is the lever behind cost: a
// single Builder execution on issue #6 moved 4.88M cached tokens against 110 uncached input
// tokens, which only happens when the conversation is replayed over many turns.
//
// Codex (--json) and Claude (stream-json) write one JSON event per line, so their activity is real
// and countable here. Cursor still returns a single result envelope, so only what that envelope
// states is available. The histogram is keyed by whatever type each provider emits rather than by a fixed
// vocabulary, so a provider renaming or adding an event shows up instead of being dropped.
export interface ProviderActivity {
  events: number;
  eventTypes: Record<string, number>;
  turns: number | null;
  apiDurationMs: number | null;
  durationMs: number | null;
  // Reported by the provider, not computed here. It is an estimate and can differ from the bill.
  costUsd: number | null;
}

const count = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;

function eventType(value: Record<string, unknown>): string | undefined {
  for (const candidate of [value.type, (value.msg as Record<string, unknown> | undefined)?.type, (value.item as Record<string, unknown> | undefined)?.type]) {
    if (typeof candidate === "string" && candidate) return candidate;
  }
  return undefined;
}

/** Folds a provider's events, one at a time, into the activity they show. */
export function providerActivityReducer() {
  let events = 0;
  const eventTypes: Record<string, number> = {};
  // A provider that states its own turn count, durations or cost is believed; the last statement wins.
  let turns: number | null = null, apiDurationMs: number | null = null, durationMs: number | null = null, costUsd: number | null = null;
  return {
    add(value: Record<string, unknown>) {
      events++;
      const type = eventType(value) ?? "untyped";
      eventTypes[type] = (eventTypes[type] ?? 0) + 1;
      turns = count(value.num_turns ?? (value as {numTurns?: unknown}).numTurns) ?? turns;
      apiDurationMs = count(value.duration_api_ms ?? (value as {durationApiMs?: unknown}).durationApiMs) ?? apiDurationMs;
      durationMs = count(value.duration_ms ?? (value as {durationMs?: unknown}).durationMs) ?? durationMs;
      const reportedCost = value.total_cost_usd ?? (value as {totalCostUsd?: unknown}).totalCostUsd;
      if (typeof reportedCost === "number" && Number.isFinite(reportedCost) && reportedCost >= 0) costUsd = reportedCost;
    },
    result(): ProviderActivity | null {
      return events ? { events, eventTypes, turns, apiDurationMs, durationMs, costUsd } : null;
    },
  };
}
