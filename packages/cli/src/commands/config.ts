// The settings verbs: `sm config` over the device's settings, and the
// same verbs under `sm projects config` over a project's.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DeviceConfigKeysSchema,
  keyDescriptions,
} from "@shigomori/contracts/schemas/config";
import * as Config from "@shigomori/engine/Config";
import { byPlatform } from "@shigomori/engine/platform";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import { UsageError } from "../errors.ts";
import { rest } from "../here.ts";
import { interactive, runEditor, terminalEditor } from "../prompt.ts";
import { launcherVerb } from "./configLists.ts";
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

// The command a verb's usage names: `config`, or `projects config`
// with its -p.
export const usage = (settings: Settings, verb: string) =>
  Effect.flatMap(
    Effect.service(Output),
    ({ binaryName }) =>
      new UsageError({
        problem:
          settings.project === undefined
            ? `Usage: ${binaryName} config ${verb}`
            : `Usage: ${binaryName} projects config ${verb} [-p <project>]`,
      }),
  );

// The editor, or what it left, wouldn't do.
class EditFailed extends Schema.TaggedError<EditFailed>()("EditFailed", {
  problem: Schema.String,
}) {
  override get message(): string {
    return this.problem;
  }
}

// A value as a person reads it: text as it is, anything else as JSON.
const rendered = (value: unknown) =>
  value === null || value === undefined
    ? ""
    : typeof value === "string"
      ? value
      : JSON.stringify(value);

// A verb's document under --json, carrying a project's name.
export const document = (settings: Settings, doc: object) =>
  emit(
    settings.project === undefined
      ? { ok: true, ...doc }
      : { ok: true, project: settings.project, ...doc },
  );

// A project's lines end with its name.
export const suffix = (settings: Settings) =>
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
  const list = Command.make("list", { rest }, () =>
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
  );

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
  );

  const read = Command.make("read", { rest }, () =>
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
  );

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
  );

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
  );

  // The whole document in $VISUAL or $EDITOR, written back as one save
  // once the editor quits. The store holds the settings, so the editor
  // gets a copy in a file of its own.
  const edit = Command.make("edit", { rest }, () =>
    Effect.gen(function* () {
      const settings = yield* resolve;
      const { json, binaryName } = yield* Effect.service(Output);
      const editor = terminalEditor();
      if (json || editor === "" || !(yield* interactive)) {
        const verbs = settings.listCommand.replace(/ list$/, "");
        return yield* new UsageError({
          problem: `edit opens the settings in $VISUAL or $EDITOR at a terminal. Use \`${binaryName} ${verbs} set\` instead${byPlatform({ darwin: ", or the app", linux: "" })}.`,
        });
      }
      const config = yield* Config.Config;
      // A project with none is seeded first, its default branch filled in.
      if ((yield* config.read(settings.scope)) === null) {
        yield* config.change(settings.scope, (doc) => doc);
      }
      const stored = (yield* config.read(settings.scope)) ?? {};
      const dir = mkdtempSync(join(tmpdir(), "sm-settings-"));
      const file = join(dir, "settings.json");
      writeFileSync(file, `${JSON.stringify(stored, null, 2)}\n`, {
        mode: 0o600,
      });
      const failed = runEditor(editor, file);
      if (failed !== undefined) {
        rmSync(dir, { recursive: true, force: true });
        return yield* new EditFailed({ problem: failed });
      }
      // A bad edit stays where it was made, for another try.
      const kept = ` The edit is kept at ${file}.`;
      const payload = yield* Schema.decodeEffect(
        Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
      )(readFileSync(file, "utf8")).pipe(
        Effect.mapError(
          () =>
            new EditFailed({
              problem: `The edit isn't a JSON object, so nothing changed.${kept}`,
            }),
        ),
      );
      // An edit that changed nothing writes nothing. A save made while
      // the editor was open (the app's, another command's) isn't written
      // away by a document read before it.
      if (Config.sameConfigDoc(payload, stored)) {
        rmSync(dir, { recursive: true, force: true });
        return;
      }
      yield* config.write(settings.scope, payload, stored).pipe(
        Effect.catchTag("ConfigChangedMeanwhile", () =>
          Effect.fail(
            new EditFailed({
              problem: `The settings changed while you edited them, so nothing changed.${kept}`,
            }),
          ),
        ),
        Effect.mapError((error) =>
          error instanceof EditFailed
            ? error
            : new EditFailed({
                problem: `${error.message} Nothing changed.${kept}`,
              }),
        ),
      );
      rmSync(dir, { recursive: true, force: true });
    }),
  );

  return [list, get, read, set, unset, edit, launcherVerb(resolve)] as const;
}

const device: Settings = {
  scope: { kind: "device" },
  listCommand: "config list",
  descriptions: keyDescriptions(DeviceConfigKeysSchema),
};

export const configCommand = Command.make("config").pipe(
  Command.withSubcommands(configVerbs(Effect.succeed(device))),
);
