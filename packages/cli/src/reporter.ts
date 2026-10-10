// How a verb that makes or removes a worktree reports as it goes: each
// engine event as its document under --json, or a person's line on
// stderr, a script's own output passed through as it comes.
import type * as Worktrees from "@shigomori/engine/Worktrees";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { emit, note, Output, styles } from "./output.ts";

const PHASES = {
  carryOver: "carry-over",
  setup: "setup",
  portPoolProvision: "port-pool provision",
} as const;

// The slot a lifecycle script runs in, as its start names it.
type Slot = Extract<
  Worktrees.WorktreeEvent,
  { readonly event: "script"; readonly kind: "started" }
>["slot"];

const slotLabel = (slot: Slot) =>
  slot.kind === "portPool" ? `port-pool ${slot.phase}` : slot.kind;

// `created` is the line for a new worktree, which create and adopt say
// their own way.
export const reporter = (
  created: (worktree: Worktrees.WorktreeRow) => string = () => "",
) =>
  Effect.gen(function* () {
    const output = yield* Effect.service(Output);
    const { dim } = styles(output.stderrColor);
    // A script's slot, from its start, for the lines after it.
    const slots = new Map<string, string>();
    const marker = (runId: string) => dim(`[${slots.get(runId) ?? ""}]`);

    // How the files were cloned. A failed clone is said on stderr
    // under --json too, as the Go sm did.
    const cloned = ({ from, outcome }: Worktrees.Cloned) =>
      Result.isFailure(outcome)
        ? note(
            `${dim("[checkout]")} cloning failed (${outcome.failure.message}), checking out with git`,
          )
        : output.json
          ? Effect.void
          : note(
              `${dim("[checkout]")} ${outcome.success.cloned} files cloned from ${from.isPrimary ? "the primary checkout" : from.name}${outcome.success.hashed > 0 ? ` (${outcome.success.hashed} read back to verify)` : ""}, ${outcome.success.written} written by git`,
            );

    const human = (event: Worktrees.WorktreeEvent) => {
      switch (event.event) {
        case "phase":
          return event.phase === "idle"
            ? Effect.void
            : note(`${dim(`[${PHASES[event.phase]}]`)} …`);
        case "created":
          return note(created(event.worktree));
        case "cloned":
          return cloned(event.cloned);
        case "carryOver": {
          const { report } = event;
          const tag = dim("[carry-over]");
          const lines = [
            `${tag} ${report.applied} applied${report.failures.length > 0 ? `, ${report.failures.length} failed` : ""}`,
            ...(report.sourced ?? []).map(
              ({ path, source, copiedInstead }) =>
                `${tag} ${path} from ${source}${copiedInstead === true ? " (copied: symlinks only target the primary)" : ""}`,
            ),
            ...[...report.failures, ...(report.includeFailures ?? [])].map(
              ({ path, source, reason }) =>
                `${tag} ${path}${source === undefined || source === "" ? "" : ` in ${source}`}: ${reason}`,
            ),
          ];
          return Effect.forEach(lines, note, { discard: true });
        }
        case "script":
          switch (event.kind) {
            case "started":
              slots.set(event.runId, slotLabel(event.slot));
              return note(`${marker(event.runId)} running`);
            case "data":
              return Effect.sync(() => process.stderr.write(event.data));
            case "error":
              return note(`${marker(event.runId)} ${event.data}`);
            case "exit":
              return note(
                `${marker(event.runId)} ${event.code === 0 ? "done" : event.code === null ? "failed to run" : `exited with code ${event.code}`}`,
              );
          }
      }
    };

    return {
      report: (event: Worktrees.WorktreeEvent) =>
        !output.json
          ? human(event)
          : event.event === "cloned"
            ? cloned(event.cloned)
            : emit(event),
      color: !output.json && output.stderrColor,
    } satisfies Worktrees.Reporter;
  });
