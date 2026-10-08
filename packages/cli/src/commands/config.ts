// The settings verbs: `sm config` over the device's settings, and the
// same verbs under `sm projects config` over a project's.
import * as Config from "@shigomori/engine/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import { UsageError } from "../errors.ts";
import { emit, out, Output, renderTable, styles } from "../output.ts";

// Where a verb reads and writes, and how its output names that.
export type Settings = {
  readonly scope: Config.ConfigScope;
  // The project's name, which its documents and lines carry.
  readonly project?: string;
  // The command people list the settings with.
  readonly listCommand: string;
  // What each setting is for, in the listing.
  readonly descriptions: Readonly<Record<string, string>>;
};

// A value as a person reads it: text as it is, anything else as JSON.
const rendered = (value: unknown) =>
  value === null || value === undefined
    ? ""
    : typeof value === "string"
      ? value
      : JSON.stringify(value);

// A verb's document under --json, carrying a project's name.
const document = (settings: Settings, doc: object) =>
  emit(
    settings.project === undefined
      ? { ok: true, ...doc }
      : { ok: true, project: settings.project, ...doc },
  );

// A project's lines end with its name.
const suffix = (settings: Settings) =>
  settings.project === undefined ? "" : ` for ${settings.project}`;

// A key back at its default, and the default a person now gets.
const reportUnset = (settings: Settings, key: string) =>
  Effect.gen(function* () {
    const { json, stdoutColor } = yield* Effect.service(Output);
    if (json) return yield* document(settings, { key });
    const { value } = yield* (yield* Config.Config).get(settings.scope, key);
    const fallback = value === null ? "" : ` (default: ${rendered(value)})`;
    yield* out(
      styles(stdoutColor).green(`unset ${key}${fallback}${suffix(settings)}`),
    );
  });

// The verbs over the settings `resolve` names.
export function configVerbs<E, R>(resolve: Effect.Effect<Settings, E, R>) {
  const list = Command.make("list", {}, () =>
    Effect.gen(function* () {
      const settings = yield* resolve;
      const config = yield* Config.Config;
      const listed = yield* config.list(settings.scope);
      const { json, stdoutColor } = yield* Effect.service(Output);
      if (json) return yield* document(settings, { settings: listed });
      const { dim } = styles(stdoutColor);
      const rows = listed.map(({ key, value, set }) => {
        const cell = rendered(value);
        const marker = value === null ? "(unset)" : "(default)";
        return [
          key,
          set ? cell : cell === "" ? dim(marker) : `${cell} ${dim(marker)}`,
          dim(settings.descriptions[key] ?? ""),
        ];
      });
      yield* out(
        renderTable(["KEY", "VALUE", "DESCRIPTION"], rows, stdoutColor),
      );
    }),
  ).pipe(Command.withDescription("Show every setting"));

  const get = Command.make("get", { key: Argument.String("key") }, ({ key }) =>
    Effect.gen(function* () {
      const settings = yield* resolve;
      const config = yield* Config.Config;
      const setting = yield* config.get(settings.scope, key);
      const { json } = yield* Effect.service(Output);
      if (json) return yield* document(settings, setting);
      // Nothing for an unset key, so command substitution stays clean.
      if (setting.value !== null) yield* out(rendered(setting.value));
    }),
  ).pipe(Command.withDescription("Print one setting's effective value"));

  const read = Command.make("read", {}, () =>
    Effect.gen(function* () {
      const settings = yield* resolve;
      const { json, binaryName } = yield* Effect.service(Output);
      if (!json) {
        return yield* new UsageError({
          problem: `read is plumbing for --json. For people: ${binaryName} ${settings.listCommand}.`,
        });
      }
      const config = yield* Config.Config;
      const stored = yield* config.read(settings.scope);
      // A device with no settings reads as an empty document, a project
      // as null.
      yield* document(settings, {
        config: settings.scope.kind === "device" ? (stored ?? {}) : stored,
      });
    }),
  ).pipe(Command.withDescription("Print the settings as stored (--json)"));

  const set = Command.make(
    "set",
    { key: Argument.String("key"), value: Argument.String("value") },
    ({ key, value }) =>
      Effect.gen(function* () {
        const settings = yield* resolve;
        const config = yield* Config.Config;
        const stored = yield* config.set(settings.scope, key, value);
        // Empty text clears a text key, which reports as unset does.
        if (stored === undefined) return yield* reportUnset(settings, key);
        const { json, stdoutColor } = yield* Effect.service(Output);
        if (json) return yield* document(settings, { key, value: stored });
        yield* out(
          styles(stdoutColor).green(
            `set ${key} = ${rendered(stored)}${suffix(settings)}`,
          ),
        );
      }),
  ).pipe(Command.withDescription("Change a setting"));

  const unset = Command.make(
    "unset",
    { key: Argument.String("key") },
    ({ key }) =>
      Effect.gen(function* () {
        const settings = yield* resolve;
        const config = yield* Config.Config;
        yield* config.unset(settings.scope, key);
        yield* reportUnset(settings, key);
      }),
  ).pipe(Command.withDescription("Reset a setting to its default"));

  const write = Command.make(
    "write",
    { data: Flag.String("data").pipe(Flag.optional) },
    ({ data }) =>
      Effect.gen(function* () {
        const settings = yield* resolve;
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
        yield* config.write(settings.scope, payload);
        yield* emit({ ok: true });
      }),
  ).pipe(Command.withDescription("Write the whole document (app plumbing)"));

  return [list, get, read, set, unset, write] as const;
}

const device: Settings = {
  scope: { kind: "device" },
  listCommand: "config list",
  descriptions: {
    launchScripts: "Show package scripts in the Launch section",
    deleteBranchOnRemove: "Delete the branch when removing its worktree",
    autoPopulateInstall: "Seed new projects' setup script with `<pm> install`",
    autoPullNew:
      "Start new worktrees (and added projects' primaries) with auto-pull on",
    autoPullPrimaryOnly:
      "autoPullNew applies to added projects' primaries only",
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
    terminal: "Terminal that terminal tools (Claude Code, Neovim, …) open in",
  },
};

export const configCommand = Command.make("config").pipe(
  Command.withDescription("Global settings"),
  Command.withSubcommands(configVerbs(Effect.succeed(device))),
);
