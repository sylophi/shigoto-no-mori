// The systemd user unit a Linux install runs its host under
// (linuxInstall.ts): its state, and it written, started, stopped and
// taken out, through the user's own service manager.
import { userInfo } from "node:os";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type { Flavor } from "./flavor.ts";
import { type LinuxInstall, unitText } from "./linuxInstall.ts";
import { captureWithin } from "./processes.ts";

// The service manager refused, in its own words.
class UnitFailed extends Schema.TaggedError<UnitFailed>()("UnitFailed", {
  command: Schema.String,
  output: Schema.String,
}) {
  override get message(): string {
    const said = this.output.trim();
    return said === ""
      ? `\`${this.command}\` failed.`
      : `\`${this.command}\` failed: ${said}`;
  }
}

const run = (command: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const { output, code } = yield* captureWithin(
      spawner,
      command,
      args,
      "1 minute",
      { from: "all" },
    );
    if (code !== 0) {
      return yield* new UnitFailed({
        command: [command, ...args].join(" "),
        output,
      });
    }
    return output;
  });

const systemctl = (...args: ReadonlyArray<string>) =>
  run("systemctl", ["--user", ...args]);

type UnitState = {
  // Its file is written.
  readonly installed: boolean;
  // It starts with the user's service manager.
  readonly enabled: boolean;
  readonly running: boolean;
  // The host's pid, 0 when it isn't running.
  readonly pid: number;
};

export const unitState = (install: LinuxInstall) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const shown = yield* systemctl(
      "show",
      install.unitName,
      "-p",
      "UnitFileState,ActiveState,MainPID",
    );
    const field = (name: string) =>
      new RegExp(`^${name}=(.*)$`, "m").exec(shown)?.[1] ?? "";
    return {
      installed: yield* fs.exists(install.unit),
      enabled: field("UnitFileState") === "enabled",
      running: field("ActiveState") === "active",
      pid: Number(field("MainPID")) || 0,
    } satisfies UnitState;
  });

// Whether the user's service manager runs from boot rather than from
// their first login to their last logout. A user logind doesn't know
// yet (no session, as under `su`) isn't lingering.
export const lingering = Effect.suspend(() =>
  run("loginctl", [
    "show-user",
    String(userInfo().uid),
    "-p",
    "Linger",
    "--value",
  ]),
).pipe(
  Effect.map((said) => said.trim() === "yes"),
  Effect.orElseSucceed(() => false),
);

// The unit written as this build writes it and (re)started, so a host
// already running moves to the version `current` now names, and
// lingering asked for, which a user may turn on for themselves where
// polkit lets them. Its answer is whether lingering is on.
export const installUnit = (flavor: Flavor, install: LinuxInstall) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(path.dirname(install.unit), { recursive: true });
    yield* fs.writeFileString(install.unit, unitText(flavor, install));
    yield* systemctl("daemon-reload");
    yield* systemctl("enable", install.unitName);
    yield* systemctl("restart", install.unitName);
    if (yield* lingering) return true;
    yield* run("loginctl", ["enable-linger"]).pipe(Effect.ignore);
    return yield* lingering;
  });

// Stopped, and its file gone. None is no failure.
export const uninstallUnit = (install: LinuxInstall) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (!(yield* fs.exists(install.unit))) return;
    yield* systemctl("disable", "--now", install.unitName);
    yield* fs.remove(install.unit);
    yield* systemctl("daemon-reload");
  });

export const startUnit = (install: LinuxInstall) =>
  systemctl("start", install.unitName).pipe(Effect.asVoid);

export const stopUnit = (install: LinuxInstall) =>
  systemctl("stop", install.unitName).pipe(Effect.asVoid);

export const restartUnit = (install: LinuxInstall) =>
  systemctl("restart", install.unitName).pipe(Effect.asVoid);
