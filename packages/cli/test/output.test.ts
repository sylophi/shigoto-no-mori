// The terminal's output against its reader (src/output.ts), driven in a
// process of its own under Bun (fixtures/flood.ts): a reader that holds off
// holds the command back, where its output piled up unread in memory,
// and one that closes early (`| head`) ends it quietly.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { it } from "vitest";

const cli = join(import.meta.dirname, "..");

const flood = (count: number, ...flags: string[]) =>
  spawn(
    "bun",
    [join("test", "fixtures", "flood.ts"), String(count), ...flags],
    {
      cwd: cli,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

it("a reader that holds off holds the output back, and reading on takes every document in order", async () => {
  const child = flood(256);
  child.stdout.pause();
  let done = 0;
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk;
    const counts = stderr.trim().split("\n").map(Number);
    done = Math.max(done, ...counts.filter(Number.isFinite));
  });
  await sleep(1_000);
  assert.ok(done < 256, `${done} of 256 writes were done with nothing read`);
  let stdout = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk));
  child.stdout.resume();
  const [code] = (await once(child, "close")) as [number | null];
  assert.equal(code, 0);
  const docs = stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { i: number });
  assert.deepEqual(
    docs.map((doc) => doc.i),
    Array.from({ length: 256 }, (_, i) => i),
  );
}, 60_000);

it("a reader that closes after the first line ends the command quietly, with nothing said", async () => {
  const child = flood(2_000, "quiet");
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk));
  let first = "";
  await new Promise<void>((resolve) => {
    child.stdout.on("data", (chunk: Buffer) => {
      first += chunk;
      if (first.includes("\n")) {
        child.stdout.destroy();
        resolve();
      }
    });
  });
  const [code, signal] = (await once(child, "close")) as [
    number | null,
    NodeJS.Signals | null,
  ];
  assert.deepEqual(
    { code, signal, stderr },
    { code: 0, signal: null, stderr: "" },
  );
}, 60_000);
