import fs from "node:fs";

// Codex (--json) and Claude (stream-json) write one JSON event per line for the whole run, so a long
// run's transcript can be far larger than anything worth holding in memory: tool results carry
// file contents and command output. The file is read once, in chunks, and every complete line is
// handed over as it is parsed. A line cut short by a killed process, or one too large to be an
// event, is counted as skipped instead of failing the read.
export const maxEventBytes = 10_000_000;
export type JsonEvent = Record<string, unknown>;
export interface LineScan { events: number; skipped: number; }

function parse(line: Buffer): JsonEvent | undefined {
  const text = line.toString("utf8").trim();
  if (!text) return undefined;
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value as JsonEvent : undefined;
  } catch { return undefined; }
}

export function eachJsonLine(file: string, visit: (event: JsonEvent) => void, chunkBytes = 1 << 20): LineScan {
  const scan: LineScan = { events: 0, skipped: 0 };
  let handle: number;
  try { handle = fs.openSync(file, "r"); } catch { return scan; }
  const chunk = Buffer.alloc(chunkBytes);
  let pending: Buffer[] = [], pendingBytes = 0, oversized = false;
  const finish = (tail: Buffer) => {
    if (oversized || pendingBytes + tail.length > maxEventBytes) scan.skipped++;
    else {
      const line = pending.length ? Buffer.concat([...pending, tail]) : tail;
      if (line.toString("utf8").trim()) {
        const event = parse(line);
        if (event) { scan.events++; visit(event); } else scan.skipped++;
      }
    }
    pending = []; pendingBytes = 0; oversized = false;
  };
  try {
    for (let read = fs.readSync(handle, chunk, 0, chunkBytes, null); read > 0; read = fs.readSync(handle, chunk, 0, chunkBytes, null)) {
      let start = 0;
      for (let newline = chunk.indexOf(10, start); newline !== -1 && newline < read; newline = chunk.indexOf(10, start)) {
        finish(chunk.subarray(start, newline));
        start = newline + 1;
      }
      if (start < read && !oversized) {
        const rest = Buffer.from(chunk.subarray(start, read));
        if (pendingBytes + rest.length > maxEventBytes) { oversized = true; pending = []; pendingBytes = 0; }
        else { pending.push(rest); pendingBytes += rest.length; }
      }
    }
    if (pendingBytes || oversized) finish(Buffer.alloc(0));
  } finally { fs.closeSync(handle); }
  return scan;
}

/** The same reading over text already in memory. */
export function jsonLines(text: string): JsonEvent[] {
  const events: JsonEvent[] = [];
  for (const line of text.split(/\r?\n/)) { const event = parse(Buffer.from(line)); if (event) events.push(event); }
  return events;
}
