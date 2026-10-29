// sm service <install|uninstall|start|stop|restart|status|logs>: the
// host of a Linux install, which the user's systemd runs as a unit
// (engine hostUnit.ts): from boot, and again whenever it exits but for
// a stop. On a Mac the app is the host, so there is none to manage.
import { basename, join } from "node:path";
import * as HostUnit from "@shigomori/engine/hostUnit";
import { HOST_BUNDLE, linuxInstall } from "@shigomori/engine/linuxInstall";
import * as Paths from "@shigomori/engine/Paths";
import { byPlatform } from "@shigomori/engine/platform";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import { flavor } from "../build.ts";
import { UsageError } from "../errors.ts";
import { handOver } from "../handOver.ts";
import { rest } from "../here.ts";
import { emit, note, out, Output, styles } from "../output.ts";

// `current` holds no host to run: nothing was installed, or only by hand.
class NotInstalled extends Schema.TaggedError<NotInstalled>()("NotInstalled", {
  current: Schema.String,
}) {
  override get message(): string {
    return `No install of this build is at ${this.current}, so there's no host for a service to run.`;
  }
}

class NoService extends Schema.TaggedError<NoService>()("NoService", {
  binaryName: Schema.String,
}) {
  override get message(): string {
    return `The host's service isn't installed. \`${this.binaryName} service install\` installs it.`;
  }
}

const place = Effect.gen(function* () {
  const paths = yield* Paths.Paths;
  return yield* byPlatform({
    darwin: Effect.fail(
      new UsageError({
        problem: "On a Mac the app runs the host, so there's no service.",
      }),
    ),
    linux: Effect.succeed(linuxInstall(flavor, paths)),
  });
});

// The install, refused when its unit isn't installed.
const installed = Effect.gen(function* () {
  const install = yield* place;
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(install.unit))) {
    const { binaryName } = yield* Effect.service(Output);
    return yield* new NoService({ binaryName });
  }
  return install;
});

const installCommand = Command.make("install", { rest }, () =>
  Effect.gen(function* () {
    const install = yield* place;
    const fs = yield* FileSystem.FileSystem;
    if (!(yield* fs.exists(join(install.current, HOST_BUNDLE)))) {
      return yield* new NotInstalled({ current: install.current });
    }
    const lingering = yield* HostUnit.installUnit(flavor, install);
    const { json } = yield* Effect.service(Output);
    if (json) return yield* emit({ ok: true, lingering });
    yield* out(`installed ${install.unitName}: the host is running`);
    if (!lingering) {
      yield* note(
        `Lingering is off, so the host runs only while you're logged in. \`sudo loginctl enable-linger ${process.env["USER"] ?? "$USER"}\` runs it from boot.`,
      );
    }
  }),
);

const uninstallCommand = Command.make("uninstall", { rest }, () =>
  Effect.gen(function* () {
    const install = yield* place;
    yield* HostUnit.uninstallUnit(install);
    const { json } = yield* Effect.service(Output);
    if (json) return yield* emit({ ok: true });
    yield* out(`uninstalled ${install.unitName}: the host is stopped`);
  }),
);

const startCommand = Command.make("start", { rest }, () =>
  Effect.gen(function* () {
    const install = yield* installed;
    yield* HostUnit.startUnit(install);
    const { json } = yield* Effect.service(Output);
    yield* json ? emit({ ok: true }) : out("started the host");
  }),
);

const stopCommand = Command.make("stop", { rest }, () =>
  Effect.gen(function* () {
    const install = yield* installed;
    yield* HostUnit.stopUnit(install);
    const { json } = yield* Effect.service(Output);
    yield* json
      ? emit({ ok: true })
      : out("stopped the host, until the next start or boot");
  }),
);

const restartCommand = Command.make("restart", { rest }, () =>
  Effect.gen(function* () {
    const install = yield* installed;
    yield* HostUnit.restartUnit(install);
    const { json } = yield* Effect.service(Output);
    yield* json ? emit({ ok: true }) : out("restarted the host");
  }),
);

const statusCommand = Command.make("status", { rest }, () =>
  Effect.gen(function* () {
    const install = yield* place;
    const fs = yield* FileSystem.FileSystem;
    const [state, lingering] = yield* Effect.all(
      [HostUnit.unitState(install), HostUnit.lingering],
      { concurrency: "unbounded" },
    );
    const version = yield* fs.readLink(install.current).pipe(
      Effect.map((target) => basename(target)),
      Effect.orElseSucceed(() => null),
    );
    const { json, stdoutColor, binaryName } = yield* Effect.service(Output);
    if (json) {
      return yield* emit({
        ok: true,
        unit: install.unitName,
        ...state,
        version,
        lingering,
      });
    }
    if (!state.installed)
      return yield* note(new NoService({ binaryName }).message);
    const { green, dim, yellow } = styles(stdoutColor);
    yield* out(
      state.running
        ? `${install.unitName}: ${green("running")} ${dim(`(pid ${state.pid})`)}`
        : `${install.unitName}: ${yellow("stopped")}`,
    );
    if (version !== null) yield* out(`version: ${version}`);
    yield* out(
      !state.enabled
        ? `starts: ${yellow("not on its own")} ${dim(`(${binaryName} service install)`)}`
        : lingering
          ? "starts: at boot"
          : `starts: at your login ${dim("(lingering is off)")}`,
    );
  }),
);

const logsCommand = Command.make(
  "logs",
  {
    rest,
    follow: Flag.Boolean("follow").pipe(
      Flag.withAlias("f"),
      Flag.withDefault(false),
    ),
  },
  ({ follow }) =>
    Effect.gen(function* () {
      const install = yield* installed;
      yield* handOver(
        "exec",
        "journalctl",
        [
          "--user",
          "--unit",
          install.unitName,
          "--no-pager",
          ...(follow ? ["--follow"] : ["--lines", "200"]),
        ],
        { cwd: process.cwd(), env: process.env },
      );
    }),
);

export const serviceCommand = Command.make("service").pipe(
  Command.withSubcommands([
    installCommand,
    uninstallCommand,
    startCommand,
    stopCommand,
    restartCommand,
    statusCommand,
    logsCommand,
  ]),
);
