// The store's open as a run of events, counted: each SQLite statement and
// each file removal. With SHIGOMORI_KILL_AT=n the process SIGKILLs itself
// just before the nth, so a kill lands where it means to under any load;
// SHIGOMORI_COUNT_EVENTS prints how many a whole run made. Called before
// the platform is imported, which binds `fs.rm` as it loads.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { DatabaseSync, StatementSync } from "node:sqlite";

export function countEvents(): void {
  const killAt = Number(process.env["SHIGOMORI_KILL_AT"] ?? 0);
  let events = 0;
  const event = () => {
    events += 1;
    if (events === killAt) process.kill(process.pid, "SIGKILL");
  };
  const counted = <T extends object, K extends keyof T>(owner: T, key: K) => {
    const original = owner[key] as (...args: unknown[]) => unknown;
    Object.assign(owner, {
      [key]: function (this: unknown, ...args: unknown[]) {
        event();
        return original.apply(this, args);
      },
    });
  };
  counted(StatementSync.prototype, "all");
  counted(StatementSync.prototype, "run");
  counted(DatabaseSync.prototype, "exec");
  counted(fs, "rm");
  syncBuiltinESMExports();
  if (process.env["SHIGOMORI_COUNT_EVENTS"] !== undefined) {
    process.once("beforeExit", () => {
      process.stdout.write(`events ${events}\n`);
    });
  }
}
