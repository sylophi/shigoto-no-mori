// sm config <list|get|read|set|unset|write>: the device's settings.
import * as Config from "@shigomori/engine/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import { UsageError } from "../errors.ts";
import {
  emit,
  emitOrOut,
  out,
  Output,
  renderTable,
  styles,
} from "../output.ts";

const device = { kind: "device" } as const;

// What each setting is for, in the listing.
const DESCRIPTIONS: Readonly<Record<string, string>> = {
  launchScripts: "Show package scripts in the Launch section",
  deleteBranchOnRemove: "Delete the branch when removing its worktree",
  autoPopulateInstall: "Seed new projects' setup script with `<pm> install`",
  autoPullNew:
    "Start new worktrees (and added projects' primaries) with auto-pull on",
  autoPullPrimaryOnly: "autoPullNew applies to added projects' primaries only",
  doubutsuNames:
    "Name new worktrees after Animal Crossing characters (on for new installs)",
  codexWorktreeNames:
    "Name Codex-style <name>/<repo> worktrees by their parent folder",
  managedOnProjectDrive:
    "Keep managed worktrees on the project's drive when it is an external one",
  portPool: "Provision/release port-pool ports with worktrees",
  terrier: "List terrier-registered repos as projects",
  githubCli: "GitHub CLI integration",
  launchers: "Global custom launchers (`config launcher`)",
  hiddenLaunchers: "Hidden launcher ids (via edit or the app)",
};

// A value as a person reads it: text as it is, anything else as JSON.
const rendered = (value: unknown) =>
  value === null || value === undefined
    ? ""
    : typeof value === "string"
      ? value
      : JSON.stringify(value);

const list = Command.make("list", {}, () =>
  Effect.gen(function* () {
    const config = yield* Config.Config;
    const settings = yield* config.list(device);
    const { json, stdoutColor } = yield* Effect.service(Output);
    if (json) return yield* emit({ ok: true, settings });
    const { dim } = styles(stdoutColor);
    const rows = settings.map(({ key, value, set }) => {
      const cell = rendered(value);
      const marker = value === null ? "(unset)" : "(default)";
      return [
        key,
        set ? cell : cell === "" ? dim(marker) : `${cell} ${dim(marker)}`,
        dim(DESCRIPTIONS[key] ?? ""),
      ];
    });
    yield* out(renderTable(["KEY", "VALUE", "DESCRIPTION"], rows, stdoutColor));
  }),
).pipe(Command.withDescription("Show every setting"));

const get = Command.make("get", { key: Argument.String("key") }, ({ key }) =>
  Effect.gen(function* () {
    const config = yield* Config.Config;
    const setting = yield* config.get(device, key);
    const { json } = yield* Effect.service(Output);
    if (json) return yield* emit({ ok: true, ...setting });
    // Nothing for an unset key, so command substitution stays clean.
    if (setting.value !== null) yield* out(rendered(setting.value));
  }),
).pipe(Command.withDescription("Print one setting's effective value"));

const read = Command.make("read", {}, () =>
  Effect.gen(function* () {
    const { json, binaryName } = yield* Effect.service(Output);
    if (!json) {
      return yield* new UsageError({
        problem: `read is plumbing for --json. For people: ${binaryName} config list.`,
      });
    }
    const config = yield* Config.Config;
    yield* emit({ ok: true, config: (yield* config.read(device)) ?? {} });
  }),
).pipe(Command.withDescription("Print the settings as stored (--json)"));

const set = Command.make(
  "set",
  { key: Argument.String("key"), value: Argument.String("value") },
  ({ key, value }) =>
    Effect.gen(function* () {
      const config = yield* Config.Config;
      const stored = yield* config.set(device, key, value);
      const { stdoutColor } = yield* Effect.service(Output);
      yield* stored === undefined
        ? emitOrOut(
            { ok: true, key },
            styles(stdoutColor).green(`unset ${key}`),
          )
        : emitOrOut(
            { ok: true, key, value: stored },
            styles(stdoutColor).green(`set ${key} = ${rendered(stored)}`),
          );
    }),
).pipe(Command.withDescription("Change a setting"));

const unset = Command.make(
  "unset",
  { key: Argument.String("key") },
  ({ key }) =>
    Effect.gen(function* () {
      const config = yield* Config.Config;
      yield* config.unset(device, key);
      const { json, stdoutColor } = yield* Effect.service(Output);
      if (json) return yield* emit({ ok: true, key });
      const { value } = yield* config.get(device, key);
      const fallback = value === null ? "" : ` (default: ${rendered(value)})`;
      yield* out(styles(stdoutColor).green(`unset ${key}${fallback}`));
    }),
).pipe(Command.withDescription("Reset a setting to its default"));

const write = Command.make(
  "write",
  { data: Flag.String("data").pipe(Flag.optional) },
  ({ data }) =>
    Effect.gen(function* () {
      if (Option.isNone(data) || data.value === "") {
        return yield* new UsageError({
          problem: "write requires --data '<json>'.",
        });
      }
      const payload = yield* Schema.decodeEffect(
        Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
      )(data.value).pipe(
        Effect.mapError(
          () => new UsageError({ problem: "--data must be a JSON object." }),
        ),
      );
      const config = yield* Config.Config;
      yield* config.write(device, payload);
      yield* emit({ ok: true });
    }),
).pipe(Command.withDescription("Write the whole document (app plumbing)"));

export const configCommand = Command.make("config").pipe(
  Command.withDescription("Global settings"),
  Command.withSubcommands([list, get, read, set, unset, write]),
);
