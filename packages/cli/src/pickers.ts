// The pickers behind every command that runs without naming its
// target. Only a person at a terminal sees one (`interactive`), so
// agents, pipelines and --json keep the explicit-forms errors.
import * as Launchers from "@shigomori/engine/Launchers";
import * as Paths from "@shigomori/engine/Paths";
import type * as Registry from "@shigomori/engine/Registry";
import * as Worktrees from "@shigomori/engine/Worktrees";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  changesCell,
  flagsCell,
  syncCell,
  titleCell,
} from "./commands/cells.ts";
import { select } from "./menu.ts";
import { collapseHome, note, Output, styles } from "./output.ts";

// A menu with nothing to offer, in Go's words.
class NothingToPick extends Schema.TaggedError<NothingToPick>()(
  "NothingToPick",
  { problem: Schema.String },
) {
  override get message(): string {
    return this.problem;
  }
}

// A cwd in a repo that isn't a project is said before the project menu.
export const noteUnregistered = (at: Worktrees.Here) =>
  Effect.gen(function* () {
    if (at.unregisteredRepo === undefined || at.unregisteredRepo === "") {
      return;
    }
    const { stderrColor } = yield* Effect.service(Output);
    yield* note(
      styles(stderrColor).dim(
        `This repo (${at.unregisteredRepo}) isn't a registered project.`,
      ),
    );
  });

// `preferredId` is highlighted first, so enter alone keeps you there.
export const pickProject = (at: Worktrees.Here, preferredId = "") =>
  Effect.gen(function* () {
    const projects = at.projects;
    if (projects.length === 0) {
      return yield* new NothingToPick({
        problem: "No projects are registered yet.",
      });
    }
    const { stderrColor } = yield* Effect.service(Output);
    const { home } = yield* Paths.Paths;
    const { dim } = styles(stderrColor);
    const index = yield* select({
      title: "Select a project:",
      header: ["PROJECT", "PATH"],
      cells: projects.map((project) => [
        project.name,
        dim(collapseHome(home, project.path)),
      ]),
      names: projects.map((project) => project.name),
      initial: Math.max(
        0,
        projects.findIndex((project) => project.id === preferredId),
      ),
    });
    return projects[index] as Registry.ListedProject;
  });

export type PickOptions = {
  // Left off the menu: for `cd`, wherever you stand.
  readonly excludeId?: string;
  // Off for the commands that refuse the primary checkout anyway.
  readonly primaryOk: boolean;
  // The primary last, off the first highlight, for a menu shown from it.
  readonly primaryLast?: boolean;
};

export const pickWorktree = (
  at: Worktrees.Here,
  project: Registry.ListedProject,
  options: PickOptions,
) =>
  Effect.gen(function* () {
    const worktrees = yield* Worktrees.Worktrees;
    const { rows } = yield* worktrees.list([project]);
    const offered = rows.filter(
      (row) =>
        row.id !== options.excludeId && (options.primaryOk || !row.isPrimary),
    );
    const choices =
      options.primaryLast === true
        ? [
            ...offered.filter((row) => !row.isPrimary),
            ...offered.filter((row) => row.isPrimary),
          ]
        : offered;
    if (choices.length === 0) {
      const { binaryName } = yield* Effect.service(Output);
      return yield* new NothingToPick({
        problem: `${project.name} has no other worktrees. Create one with \`${binaryName} create\`.`,
      });
    }
    const { stderrColor } = yield* Effect.service(Output);
    const paint = styles(stderrColor);
    const index = yield* select({
      title: `Select a worktree in ${project.name}:`,
      header: ["NAME", "BRANCH", "SYNC", "CHANGES", "", "TITLE"],
      cells: choices.map((row) => [
        row.name,
        row.branch,
        syncCell(paint, row),
        changesCell(paint, row),
        flagsCell(paint, row),
        titleCell(row.title),
      ]),
      names: choices.map((row) => row.name),
    });
    const chosen = choices[index];
    return yield* worktrees.resolve(at, {
      projectId: project.id,
      worktreeId: chosen?.id,
    });
  });

// The launchers `sm open` offers, hidden ones left out, most used first.
export const pickLauncher = (
  project: Registry.ListedProject,
  worktreeName: string,
) =>
  Effect.gen(function* () {
    const { entries } = yield* (yield* Launchers.Launchers).row(project);
    if (entries.length === 0) {
      return yield* new NothingToPick({ problem: "No launchers available." });
    }
    const { stderrColor } = yield* Effect.service(Output);
    const { dim } = styles(stderrColor);
    const index = yield* select({
      title: `Open ${worktreeName} in:`,
      cells: entries.map((entry) => [
        entry.label,
        dim(
          entry.kind === "custom"
            ? "(custom)"
            : entry.kind === "web"
              ? "(web)"
              : "",
        ),
      ]),
      names: entries.map((entry) => entry.label),
    });
    return entries[index] as Launchers.RowEntry;
  });
