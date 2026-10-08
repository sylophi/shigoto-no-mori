// sm [worktrees] status [<worktree>] [--no-pr]: one worktree's card,
// its git state, ports, scripts and pull request.
import * as Paths from "@shigomori/engine/Paths";
import * as Worktrees from "@shigomori/engine/Worktrees";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import { resolveWorktree, worktreeFlags } from "../here.ts";
import {
  alignRows,
  collapseHome,
  emit,
  out,
  Output,
  styles,
  type Styles,
} from "../output.ts";
import { divergenceCell, flagNames, truncate } from "./cells.ts";

type Card = Worktrees.StatusCard;

// The label column with its gutter, and the room the rows that append
// something after their value need for it: the divergence on branch,
// the age on commit, the checks on pr.
const LABEL_WIDTH = 12;
const SYNC_SUFFIX = 12;
const AGE_SUFFIX = 20;
const CHECKS_SUFFIX = 24;

// How long before `now` an ISO time was, in the coarsest unit that fits.
const relativeAge = (iso: string, now: number) => {
  const stamp = Date.parse(iso);
  if (Number.isNaN(stamp)) return "";
  const since = now - stamp;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (since < minute) return "just now";
  if (since < hour) return `${Math.floor(since / minute)}m ago`;
  if (since < day) return `${Math.floor(since / hour)}h ago`;
  if (since < 14 * day) return `${Math.floor(since / day)}d ago`;
  if (since < 60 * day) return `${Math.floor(since / (7 * day))}w ago`;
  if (since < 365 * day) return `${Math.floor(since / (30 * day))}mo ago`;
  return `${Math.floor(since / (365 * day))}y ago`;
};

// Whether the branch is the base branch: "main" against "main" or
// "origin/main".
const onBaseBranch = (branch: string, ref: string) =>
  branch !== "" && (ref === branch || ref.endsWith(`/${branch}`));

const changesLine = (paint: Styles, git: Card["git"]) => {
  const parts = [
    git.staged > 0 ? paint.green(`${git.staged} staged`) : "",
    git.unstaged > 0 ? paint.yellow(`${git.unstaged} unstaged`) : "",
    git.untracked > 0 ? paint.dim(`${git.untracked} untracked`) : "",
    git.conflicted > 0 ? paint.yellow(`${git.conflicted} conflicted`) : "",
  ].filter((part) => part !== "");
  return parts.length === 0 ? paint.dim("clean") : parts.join(", ");
};

const prLine = (paint: Styles, pr: NonNullable<Card["pr"]>, width: number) => {
  const state = pr.state.toLowerCase();
  const label =
    state === "open"
      ? (pr.isDraft ? paint.dim("draft") : paint.green(state)) +
        (pr.autoMergeRequest === undefined ? "" : ` ${paint.dim("auto-merge")}`)
      : state === "merged"
        ? paint.cyan(state)
        : paint.dim(state);
  const checks =
    pr.checks === undefined
      ? ""
      : `  ${[
          pr.checks.failing > 0
            ? paint.yellow(`${pr.checks.failing} failing`)
            : "",
          pr.checks.pending > 0
            ? paint.dim(`${pr.checks.pending} pending`)
            : "",
          pr.checks.passing > 0
            ? paint.green(`${pr.checks.passing} passing`)
            : "",
        ]
          .filter((part) => part !== "")
          .join(", ")}`;
  return `${paint.cyan(`#${pr.number}`)} ${label}  ${truncate(pr.title, width)}${checks}`;
};

// The header, then an aligned block of label and value, each value
// painted once its width is fixed.
const card = (
  paint: Styles,
  status: Card,
  place: {
    readonly home: string;
    readonly width: number;
    readonly now: number;
  },
) => {
  const { home, now } = place;
  const width = place.width - LABEL_WIDTH;
  const flags = flagNames(status);
  if (status.detached) flags.push("detached HEAD");
  const header =
    status.projectName +
    paint.dim("/") +
    paint.bold(status.name) +
    (flags.length > 0 ? `  ${paint.dim(`(${flags.join(", ")})`)}` : "");
  const rows: string[][] = [];
  const row = (label: string, value: string) => {
    if (value !== "") rows.push([paint.dim(label), value]);
  };
  // The worktree's own title, until an open pull request takes it over.
  if (status.pr === null || status.pr.state !== "OPEN") {
    row("title", truncate(status.title ?? "", width));
  }
  row("path", paint.dim(truncate(collapseHome(home, status.path), width)));
  const upstream = status.git.upstream;
  row(
    "branch",
    paint.cyan(truncate(status.branch, width - SYNC_SUFFIX)) +
      (upstream !== null
        ? `  ${divergenceCell(paint, upstream.ahead, upstream.behind, "synced")}`
        : status.detached
          ? ""
          : `  ${paint.dim("local")}`),
  );
  // On the base branch the base row only restates the upstream one.
  const base = status.git.base;
  if (base !== null && !onBaseBranch(status.branch, base.ref)) {
    row(
      "base",
      `${paint.dim(base.ref)}  ${divergenceCell(paint, base.ahead, base.behind, "even")}`,
    );
  }
  row("changes", changesLine(paint, status.git));
  if (status.git.stashCount > 0) {
    row("stash", `${status.git.stashCount}${paint.dim(" (repo-wide)")}`);
  }
  const commit = status.git.lastCommit;
  if (commit !== null) {
    const age = relativeAge(commit.date, now);
    row(
      "commit",
      `${paint.yellow(commit.hash)}  ${truncate(commit.subject, width - AGE_SUFFIX)}${age === "" ? "" : paint.dim(`  (${age})`)}`,
    );
  }
  if (status.ports.length > 0) {
    row(
      "ports",
      status.ports
        .map(({ name, port }) => `${paint.dim(`${name} `)}${port}`)
        .join("  "),
    );
  } else if (status.portPool.configured) {
    row("ports", paint.dim("none provisioned"));
  }
  row("setup", paint.dim(truncate(status.scripts.setup ?? "", width)));
  row("teardown", paint.dim(truncate(status.scripts.teardown ?? "", width)));
  if (status.prSkipped !== true) {
    row(
      "pr",
      status.pr !== null
        ? prLine(paint, status.pr, width - CHECKS_SUFFIX)
        : status.prUnavailable !== undefined && status.prUnavailable !== ""
          ? paint.dim(`unavailable (${status.prUnavailable})`)
          : paint.dim("none"),
    );
  }
  return [header, ...alignRows(rows).map((line) => `  ${line}`)].join("\n");
};

export const status = Command.make(
  "status",
  {
    ...worktreeFlags,
    ref: Argument.String("worktree").pipe(Argument.optional),
    // Go reads the first and lets the rest be.
    rest: Argument.String("args").pipe(Argument.variadic()),
    noPr: Flag.Boolean("no-pr").pipe(
      Flag.withDescription("Skip the pull request lookup"),
      Flag.withDefault(false),
    ),
  },
  (input) =>
    Effect.gen(function* () {
      const { located } = yield* resolveWorktree(input);
      const found = yield* (yield* Worktrees.Worktrees).status(located, {
        pullRequest: !input.noPr,
      });
      const { json, stdoutColor, width } = yield* Effect.service(Output);
      if (json) return yield* emit(found);
      const { home } = yield* Paths.Paths;
      const now = yield* Clock.currentTimeMillis;
      yield* out(card(styles(stdoutColor), found, { home, width, now }));
    }),
).pipe(
  Command.withDescription("One worktree's git state, ports and pull request"),
);
