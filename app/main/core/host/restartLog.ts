// What main.log says as the shell starts its host again (main/
// hostProcess.ts): why, the spans the host had open at its last beat,
// and the last it finished, from the tail of host-trace.log
// (host/process/host.ts). A hang names its call there, which the
// watchdog's line alone never did.
import { open } from "node:fs/promises";
import { join } from "node:path";
import type { HostBeat } from "@shared/hostBeat";

const TAIL_BYTES = 64 * 1024;
const ENDED = 8;

type Ended = {
  readonly name?: unknown;
  readonly start?: unknown;
  readonly durationMs?: unknown;
  readonly outcome?: unknown;
  readonly error?: unknown;
};

const two = (n: number) => String(n).padStart(2, "0");

// An ISO time as main.log writes its own, local and to the millisecond.
function clockTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "?";
  return `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}.${String(date.getMilliseconds()).padStart(3, "0")}`;
}

// The last spans the host finished, oldest first, one line each.
export async function lastEndedSpans(logsPath: string): Promise<string[]> {
  let text: string;
  try {
    const file = await open(join(logsPath, "host-trace.log"), "r");
    try {
      const { size } = await file.stat();
      const length = Math.min(size, TAIL_BYTES);
      const buffer = Buffer.alloc(length);
      await file.read(buffer, 0, length, size - length);
      text = buffer.toString("utf8");
    } finally {
      await file.close();
    }
  } catch {
    return [];
  }
  const spans: string[] = [];
  // The first line may be cut by the tail, and fails to parse.
  for (const line of text.split("\n").toReversed()) {
    if (spans.length === ENDED) break;
    let span: Ended;
    try {
      span = JSON.parse(line) as Ended;
    } catch {
      continue;
    }
    if (typeof span.name !== "string") continue;
    const at = typeof span.start === "string" ? clockTime(span.start) : "?";
    const ms =
      typeof span.durationMs === "number" ? Math.round(span.durationMs) : "?";
    const failed =
      span.outcome === "failed" && typeof span.error === "string"
        ? `: ${span.error.slice(0, 160)}`
        : "";
    spans.push(`${at} ${span.name} ${ms} ms ${String(span.outcome)}${failed}`);
  }
  return spans.toReversed();
}

// The lines after the reason's: what the host was in at its last beat
// (when it had one), and what it last finished.
export function restartDetail(input: {
  readonly beat: { readonly at: number; readonly beat: HostBeat } | null;
  readonly now: number;
  readonly ended: readonly string[];
}): string[] {
  const lines: string[] = [];
  const { beat } = input;
  if (beat !== null) {
    const ago = ((input.now - beat.at) / 1000).toFixed(1);
    const spans = beat.beat.open
      .map(({ name, ms }) => `${name} (${(ms / 1000).toFixed(1)} s)`)
      .join(", ");
    lines.push(
      `[host]   at its last beat, ${ago} s before: ${spans === "" ? "nothing open" : `in ${spans}`}`,
    );
  }
  if (input.ended.length > 0) {
    lines.push("[host]   the last spans it finished:");
    for (const span of input.ended) lines.push(`[host]     ${span}`);
  }
  return lines;
}
