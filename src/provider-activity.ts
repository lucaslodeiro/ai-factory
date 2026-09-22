// How much work an execution did inside one provider run. Turn count is the lever behind cost: a
// single Builder execution on issue #6 moved 4.88M cached tokens against 110 uncached input
// tokens, which only happens when the conversation is replayed over many turns.
//
// Codex streams one JSON object per line on stdout, so its activity is real and countable here.
// Claude and Cursor return a single result envelope, so only what that envelope states is
// available. The histogram is keyed by whatever type each provider emits rather than by a fixed
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

export function extractProviderActivity(stdout: string): ProviderActivity | null {
  const objects: Record<string, unknown>[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      if (value && typeof value === "object" && !Array.isArray(value)) objects.push(value as Record<string, unknown>);
    } catch {}
  }
  if (!objects.length) return null;
  const eventTypes: Record<string, number> = {};
  for (const value of objects) {
    const type = eventType(value) ?? "untyped";
    eventTypes[type] = (eventTypes[type] ?? 0) + 1;
  }
  // A provider that states its own turn count is believed over any count derived from the stream.
  const reported = objects.map(value => count(value.num_turns ?? (value as {numTurns?: unknown}).numTurns)).filter(value => value !== null);
  const api = objects.map(value => count(value.duration_api_ms ?? (value as {durationApiMs?: unknown}).durationApiMs)).filter(value => value !== null);
  const wall = objects.map(value => count(value.duration_ms ?? (value as {durationMs?: unknown}).durationMs)).filter(value => value !== null);
  const cost = objects.map(value => {
    const reportedCost = value.total_cost_usd ?? (value as {totalCostUsd?: unknown}).totalCostUsd;
    return typeof reportedCost === "number" && Number.isFinite(reportedCost) && reportedCost >= 0 ? reportedCost : null;
  }).filter(value => value !== null);
  return { events: objects.length, eventTypes, turns: reported.at(-1) ?? null, apiDurationMs: api.at(-1) ?? null,
    durationMs: wall.at(-1) ?? null, costUsd: cost.at(-1) ?? null };
}
