// The idle shelf: which rows it takes (synthetic rows), and the listing
// that shelves an untouched managed worktree with its snapshot, counts
// an unshelve by hand or by work as a touch, leaves an unshelve made
// while it ran alone, and does nothing while the setting is off (real
// git on a sandbox data dir).
import assert from "node:assert/strict";
import { existsSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { afterEach, describe, it, vi } from "vitest";
import * as Config from "../src/Config.ts";
import * as Registry from "../src/Registry.ts";
import {
  idleShelfAfter,
  idleShelfCandidate,
  idleShelfTakes,
  lastTouchedAt,
  type TouchedRow,
} from "../src/shelf.ts";
import * as Worktrees from "../src/Worktrees.ts";
import { type Engine, type Sandbox, sandbox } from "./lib/sandbox.ts";

const DAY = 24 * 60 * 60 * 1000;

// A managed row created at `touched`, with nothing else known.
const row = (touched: number, more: Partial<TouchedRow> = {}): TouchedRow => ({
  isPrimary: false,
  isExternal: false,
  createdAt: touched,
  autoPull: false,
  unpushedCount: 0,
  recentCommits: [],
  ...more,
});

describe("which rows the idle shelf takes", () => {
  const now = 100 * DAY;
  const old = now - 8 * DAY;
  const after = idleShelfAfter(7);
  const takes = (r: TouchedRow, headMovedAt = 0, unshelvedAt = 0) =>
    idleShelfCandidate(r) &&
    idleShelfTakes(lastTouchedAt(r, headMovedAt, unshelvedAt), now, after);
  const committed = [
    { date: new Date(now - DAY).toISOString().replace(/\.\d+Z$/, "Z") },
  ];

  it("takes an untouched managed worktree", () => {
    assert.equal(takes(row(old)), true);
    // A pull it only follows isn't a touch.
    assert.equal(
      takes(row(old, { autoPull: true, recentCommits: committed }), now - DAY),
      true,
    );
  });

  it("leaves a touched, unknown, active or unmanaged one", () => {
    const cases: Record<string, boolean> = {
      fresh: takes(row(now - 6 * DAY)),
      unknown: takes(row(0)),
      committed: takes(row(old, { recentCommits: committed })),
      headMoved: takes(row(old), now - DAY),
      unshelved: takes(row(old), 0, now - DAY),
      edited: takes(row(old, { lastChangeAt: now - DAY })),
      agent: takes(
        row(old, {
          agentSessions: [
            { harness: "claude", session: "s", state: "idle", at: now - DAY },
          ],
        }),
      ),
      waiting: takes(
        row(old, {
          agentSessions: [
            { harness: "claude", session: "s", state: "waiting", at: old },
          ],
        }),
      ),
      primary: takes(row(old, { isPrimary: true })),
      external: takes(row(old, { isExternal: true })),
    };
    for (const [name, taken] of Object.entries(cases)) {
      assert.equal(taken, false, name);
    }
  });

  it("is off without a positive count, and caps it at a century", () => {
    for (const days of [undefined, null, 0, -1, 1.5]) {
      assert.equal(idleShelfAfter(days), 0);
    }
    assert.equal(idleShelfAfter(10 ** 9), 36500 * DAY);
  });
});

describe("the listing's idle shelf", () => {
  let box: Sandbox | undefined;
  afterEach(async () => {
    await box?.remove();
    box = undefined;
  });

  async function engine<A, E>(run: Effect.Effect<A, E, Engine>): Promise<A> {
    const result = await box?.engine(run);
    if (
      typeof result === "object" &&
      result !== null &&
      "ok" in result &&
      result.ok === false
    ) {
      throw new Error(JSON.stringify(result));
    }
    return result as A;
  }

  const worktrees = Effect.service(Worktrees.Worktrees);
  const device = { kind: "device" } as const;

  // A project with one managed worktree whose creation, newest commit
  // and HEAD's last move are two days back.
  async function idleWorktree() {
    box = sandbox();
    const repo = box.repo("proj", { "README.md": "hi\n" });
    const project = await engine(
      Effect.flatMap(Effect.service(Registry.Registry), (registry) =>
        registry.register({ name: "proj", path: repo }),
      ),
    );
    const worktree = await engine(
      Effect.flatMap(worktrees, (service) =>
        service.create(
          project,
          { name: "fox", skipSetup: true },
          { report: () => Effect.void, color: false },
        ),
      ),
    ).then((created) => created.worktree);
    const then = new Date(Date.now() - 2 * DAY);
    box.git(
      worktree.path,
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "old",
      `--date=${then.toISOString()}`,
    );
    const admin = box
      .git(worktree.path, "rev-parse", "--absolute-git-dir")
      .trim();
    utimesSync(join(admin, "commondir"), then, then);
    utimesSync(join(admin, "logs", "HEAD"), then, then);
    const listed = async () => {
      const listing = await engine(
        Effect.flatMap(worktrees, (service) => service.list([project])),
      );
      return listing.rows.find(({ id }) => id === worktree.id)?.shelved;
    };
    const setShelved = (on: boolean) =>
      engine(
        Effect.gen(function* () {
          const service = yield* worktrees;
          const found = yield* service.identities(project);
          const identity = found.find(({ id }) => id === worktree.id);
          if (identity !== undefined) yield* service.setShelved(identity, on);
        }),
      );
    const setDays = (days: string | null) =>
      engine(
        Effect.flatMap(Effect.service(Config.Config), (config) =>
          days === null
            ? config.unset(device, "autoShelveDays")
            : config.set(device, "autoShelveDays", days),
        ),
      );
    const snapshotted = () =>
      engine(Effect.flatMap(worktrees, (service) => service.snapshotted));
    return { repo, worktree, listed, setShelved, setDays, snapshotted };
  }

  it("does nothing while the setting is off", async () => {
    const idle = await idleWorktree();
    assert.equal(await idle.listed(), false);
  });

  it("shelves an untouched worktree with its snapshot, and counts an unshelve or work as a touch", async () => {
    const idle = await idleWorktree();
    await idle.setDays("1");
    assert.equal(await idle.listed(), true, "idle goes on the shelf");
    assert.ok((await idle.snapshotted()).has(idle.worktree.id));

    await idle.setShelved(false);
    assert.equal(await idle.listed(), false, "the unshelve is a touch");

    await idle.setShelved(true);
    assert.equal(await idle.listed(), true, "a shelve by hand stays");
    writeFileSync(join(idle.worktree.path, "README.md"), "edited\n");
    assert.equal(await idle.listed(), false, "work unshelves it");
    box?.git(idle.worktree.path, "checkout", "-q", "--", "README.md");
    assert.equal(await idle.listed(), false, "and counts as a touch");
  });

  it("leaves an unshelve made while it ran alone", async () => {
    const idle = await idleWorktree();
    await idle.setDays("1");
    // Holds the first `git status` that starts while `pause` exists
    // until `resume` does: a listing that has read the store and not
    // yet written it. git runs the fsmonitor hook on every status, and
    // a failing one only means a full scan.
    const home = box?.home ?? "";
    const pause = join(home, "pause");
    const paused = join(home, "paused");
    const resume = join(home, "resume");
    const hook = join(home, "fsmonitor.sh");
    writeFileSync(
      hook,
      `#!/bin/sh\nif rm "${pause}" 2>/dev/null; then\n  : > "${paused}"\n` +
        `  while [ ! -e "${resume}" ]; do sleep 0.02; done\nfi\nexit 1\n`,
      { mode: 0o755 },
    );
    box?.git(idle.repo, "config", "core.fsmonitor", hook);
    writeFileSync(pause, "");
    const stale = idle.listed();
    await vi.waitFor(() => assert.ok(existsSync(paused)), { timeout: 10_000 });
    // Shelved and unshelved by hand while the listing holds the store as
    // it was: the unshelve is newer than what it read.
    await idle.setShelved(true);
    await idle.setShelved(false);
    writeFileSync(resume, "");
    assert.equal(await stale, false, "the stale listing left it off");
    assert.equal(await idle.listed(), false, "and the unshelve is a touch");
  });
});
