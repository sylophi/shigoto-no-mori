// What a worktree's lifecycle slot runs, for the engine that runs it
// and the window that shows it: a project's setup or teardown script,
// and port-pool's provision and release.
import * as Predicate from "effect/Predicate";
import type { LifecycleSlot } from "./schemas/scripts.ts";

// A single-quoted shell word.
export const shellQuote = (text: string) =>
  `'${text.replaceAll("'", `'\\''`)}'`;

// A project's setup or teardown script, empty when it has none.
export const scriptOf = (
  settings: Readonly<Record<string, unknown>> | null | undefined,
  key: "setup" | "teardown",
) => {
  const scripts = settings?.["scripts"];
  const value = Predicate.isObject(scripts) ? scripts[key] : undefined;
  return typeof value === "string" ? value.trim() : "";
};

// The command a lifecycle slot runs in the worktree at `path`, empty
// when the project has no such script: the lifecycle's own runs and a
// run asked for by hand both start this.
export const lifecycleCommand = (
  slot: LifecycleSlot,
  settings: Readonly<Record<string, unknown>> | null | undefined,
  path: string,
) =>
  slot.kind === "portPool"
    ? `port-pool ${slot.phase} ${shellQuote(path)}`
    : scriptOf(settings, slot.kind);
