// The settings kept as lists, each with its element verbs: launchers,
// in the device's settings and a project's, and a project's carry-over
// entries. An entry stays as stored, so fields this build doesn't model
// survive an edit.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import * as Config from "@shigomori/engine/Config";
import type { ConfigDoc } from "@shigomori/engine/configDoc";
import type * as Registry from "@shigomori/engine/Registry";
import * as Worktrees from "@shigomori/engine/Worktrees";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import { UsageError } from "../errors.ts";
import { note, out, Output, renderTable, styles } from "../output.ts";
import { document, type Settings, suffix, usage } from "./config.ts";

type Entry = Readonly<Record<string, unknown>>;

// A refusal of an entry the list doesn't hold, or holds twice.
class NoSuchEntry extends Schema.TaggedError<NoSuchEntry>()("NoSuchEntry", {
  problem: Schema.String,
}) {
  override get message(): string {
    return this.problem;
  }
}

const text = (value: unknown) => (typeof value === "string" ? value : "");

const entries = (doc: ConfigDoc | null, key: string) => {
  const list = doc?.[key];
  return Array.isArray(list) ? (list as ReadonlyArray<unknown>) : [];
};

const isEntry = (value: unknown): value is Entry =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// The list `key` changed by `change`, written back with the rest of the
// settings as they were. An emptied list goes.
const rewrite = (
  settings: Settings,
  key: string,
  change: (list: ReadonlyArray<unknown>) => ReadonlyArray<unknown>,
) =>
  Effect.flatMap(Config.Config, (config) =>
    config.change(settings.scope, (doc) => {
      const next = change(entries(doc, key));
      const { [key]: _, ...rest } = doc;
      return next.length === 0 ? rest : { ...rest, [key]: next };
    }),
  );

// A verb's result: its document under --json, its line otherwise.
const report = (settings: Settings, fields: object, line: string) =>
  Effect.flatMap(Effect.service(Output), ({ json, stdoutColor }) =>
    json ? document(settings, fields) : out(styles(stdoutColor).green(line)),
  );

// --- launchers ---

// The entries a reference names: its id (or custom:<id>) alone, else
// every entry with that label, letter case aside.
const launcherMatches = (list: ReadonlyArray<unknown>, ref: string) => {
  const wanted = ref.toLowerCase();
  const byLabel: number[] = [];
  for (const [index, entry] of list.entries()) {
    if (!isEntry(entry)) continue;
    const id = text(entry["id"]).toLowerCase();
    if (id !== "" && (id === wanted || `custom:${id}` === wanted)) {
      return [index];
    }
    if (text(entry["label"]).toLowerCase() === wanted) byLabel.push(index);
  }
  return byLabel;
};

export const launcherVerb = <E, R>(resolve: Effect.Effect<Settings, E, R>) =>
  Command.make(
    "launcher",
    { args: Argument.String("args").pipe(Argument.variadic()) },
    ({ args }) =>
      Effect.gen(function* () {
        const settings = yield* resolve;
        const config = yield* Config.Config;
        const [verb = "list", ...rest] = args;
        switch (verb) {
          case "list": {
            const list = entries(
              yield* config.read(settings.scope),
              "launchers",
            );
            const { json, stdoutColor } = yield* Effect.service(Output);
            if (json) return yield* document(settings, { launchers: list });
            if (list.length === 0) {
              return yield* note("No custom launchers configured.");
            }
            const { dim } = styles(stdoutColor);
            return yield* out(
              renderTable(
                ["LABEL", "COMMAND", "ID"],
                list
                  .filter(isEntry)
                  .map((entry) => [
                    text(entry["label"]),
                    text(entry["command"]),
                    dim(text(entry["id"])),
                  ]),
                stdoutColor,
              ),
            );
          }
          case "add": {
            const [label, command] = rest;
            if (
              rest.length !== 2 ||
              label === undefined ||
              command === undefined
            ) {
              return yield* usage(settings, "launcher add <label> <command>");
            }
            if (label.trim() === "" || command.trim() === "") {
              return yield* new UsageError({
                problem: "Label and command can't be empty.",
              });
            }
            const launcher = { id: randomUUID(), label, command };
            yield* rewrite(settings, "launchers", (list) => [
              ...list,
              launcher,
            ]);
            return yield* report(
              settings,
              { launcher },
              `added launcher ${label}${suffix(settings)}`,
            );
          }
          case "rm":
          case "remove": {
            const [ref] = rest;
            if (rest.length !== 1 || ref === undefined) {
              return yield* usage(settings, "launcher rm <label-or-id>");
            }
            const list = entries(
              yield* config.read(settings.scope),
              "launchers",
            );
            const matches = launcherMatches(list, ref);
            const [index] = matches;
            if (index === undefined) {
              return yield* new NoSuchEntry({
                problem: `No launcher matches ${JSON.stringify(ref)}.${suffix(settings)}`,
              });
            }
            if (matches.length > 1) {
              const ids = matches.map((at) => {
                const entry = list[at];
                const id = isEntry(entry) ? text(entry["id"]) : "";
                return id === "" ? "(no id, use `edit`)" : id;
              });
              return yield* new NoSuchEntry({
                problem: `${matches.length} launchers are labeled ${JSON.stringify(ref)}. Remove by id: ${ids.join(", ")}.`,
              });
            }
            const removed = list[index];
            yield* rewrite(settings, "launchers", (all) =>
              all.filter((_, at) => at !== index),
            );
            return yield* report(
              settings,
              { removed },
              `removed launcher ${isEntry(removed) ? text(removed["label"]) : ""}${suffix(settings)}`,
            );
          }
          default:
            return yield* usage(
              settings,
              "launcher [add <label> <command> | rm <label-or-id>]",
            );
        }
      }),
  ).pipe(
    Command.withAlias("launchers"),
    Command.withDescription("The custom launchers: list, add, rm"),
  );

// --- carry-over ---

const outsideRoot = () =>
  new UsageError({
    problem: "Carry-over paths must stay within the project root.",
  });

// A path as stored: project-relative with forward slashes, its `.`
// segments, doubled and trailing slashes gone, so one entry has one
// spelling. An absolute path inside the project is made relative.
const carryOverPath = (project: Registry.ListedProject, raw: string) =>
  Effect.gen(function* () {
    let path = raw.trim();
    if (isAbsolute(path)) {
      const inside = relative(project.path, path);
      if (inside === ".." || inside.startsWith(`..${sep}`)) {
        return yield* new UsageError({
          problem: `${path} is outside the project (${project.path}).`,
        });
      }
      path = inside;
    }
    if (path.startsWith("/") || path.includes("\0")) {
      return yield* outsideRoot();
    }
    const parts = path.split(/[/\\]/);
    if (parts.includes("..")) return yield* outsideRoot();
    const kept = parts.filter((part) => part !== "" && part !== ".");
    if (kept.length === 0) return yield* outsideRoot();
    return kept.join("/");
  });

export const carryOverVerb = <E, R>(
  resolve: Effect.Effect<
    { readonly settings: Settings; readonly project: Registry.ListedProject },
    E,
    R
  >,
) =>
  Command.make(
    "carryover",
    {
      args: Argument.String("args").pipe(Argument.variadic()),
      copy: Flag.Boolean("copy").pipe(
        Flag.withDescription("Copy the file into new worktrees"),
        Flag.withDefault(false),
      ),
      symlink: Flag.Boolean("symlink").pipe(
        Flag.withDescription("Link the file into new worktrees (the default)"),
        Flag.withDefault(false),
      ),
    },
    (input) =>
      Effect.gen(function* () {
        const { settings, project } = yield* resolve;
        const config = yield* Config.Config;
        const [verb = "list", ...rest] = input.args;
        const same = (path: string) => (entry: unknown) =>
          isEntry(entry) && entry["path"] === path;
        switch (verb) {
          case "list": {
            const list = entries(
              yield* config.read(settings.scope),
              "carryOver",
            );
            const { json, stdoutColor } = yield* Effect.service(Output);
            if (json) return yield* document(settings, { carryOver: list });
            if (list.length === 0) {
              return yield* note(`No carry-over entries for ${project.name}.`);
            }
            return yield* out(
              renderTable(
                ["PATH", "MODE"],
                list
                  .filter(isEntry)
                  .map((entry) => [text(entry["path"]), text(entry["mode"])]),
                stdoutColor,
              ),
            );
          }
          case "add": {
            const [raw] = rest;
            if (rest.length !== 1 || raw === undefined) {
              return yield* usage(
                settings,
                "carryover add <path> [--copy|--symlink]",
              );
            }
            if (input.copy && input.symlink) {
              return yield* new UsageError({
                problem: "Pick one of --copy and --symlink.",
              });
            }
            // Linked by default: carry-over mostly shares gitignored
            // state (env files, node_modules) across worktrees.
            const mode = input.copy ? "copy" : "symlink";
            const path = yield* carryOverPath(project, raw);
            // Any checkout can be the source, so only none having it is
            // worth a word. The entry acts only as a worktree is made.
            const { rows } = yield* (yield* Worktrees.Worktrees).list([
              project,
            ]);
            const sources = [project.path, ...rows.map((row) => row.path)];
            if (!sources.some((source) => existsSync(`${source}/${path}`))) {
              yield* note(
                `warning: ${path} doesn't currently exist in the primary checkout or any worktree`,
              );
            }
            const list = entries(
              yield* config.read(settings.scope),
              "carryOver",
            );
            const updated = list.some(same(path));
            yield* rewrite(settings, "carryOver", (all) =>
              updated
                ? all.map((entry) =>
                    same(path)(entry) ? { ...(entry as Entry), mode } : entry,
                  )
                : [...all, { path, mode }],
            );
            return yield* report(
              settings,
              { entry: { path, mode } },
              `${updated ? "updated" : "added"} carry-over ${path} (${mode})${suffix(settings)}`,
            );
          }
          case "rm":
          case "remove": {
            const [raw] = rest;
            if (rest.length !== 1 || raw === undefined) {
              return yield* usage(settings, "carryover rm <path>");
            }
            const path = yield* carryOverPath(project, raw);
            const list = entries(
              yield* config.read(settings.scope),
              "carryOver",
            );
            if (!list.some(same(path))) {
              return yield* new NoSuchEntry({
                problem: `No carry-over entry for ${JSON.stringify(path)}.${suffix(settings)}`,
              });
            }
            yield* rewrite(settings, "carryOver", (all) =>
              all.filter((entry) => !same(path)(entry)),
            );
            return yield* report(
              settings,
              { removed: path },
              `removed carry-over ${path}${suffix(settings)}`,
            );
          }
          default:
            return yield* usage(
              settings,
              "carryover [add <path> [--copy|--symlink] | rm <path>]",
            );
        }
      }),
  ).pipe(
    Command.withAlias("carry-over"),
    Command.withDescription("The files carried into new worktrees"),
  );
