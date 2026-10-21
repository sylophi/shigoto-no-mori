// The port the device link listened on last, kept beside the app's
// state, so a host that restarts or relaunches listens on it again: a
// peer's LAN address for it and its tunnel's ingress stay right. The
// tunnel's ingress is written when the tunnel is provisioned, and a
// later provision on another port can leave the connector on the
// first.
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type * as DeviceLink from "@host/socket/DeviceLink";

// The port remembered at `path`, or 0 (any) when there is none.
export const rememberedPort = (path: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(path)).pipe(
    Effect.map((text) => {
      const port = Number(text.trim());
      return Number.isInteger(port) && port > 0 && port < 65_536 ? port : 0;
    }),
    Effect.orElseSucceed(() => 0),
  );

// Written whole or not at all, so a host killed mid-write leaves the
// port before.
const rememberPort = (path: string, port: number) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    fs
      .writeFileString(`${path}.next`, `${port}\n`)
      .pipe(Effect.andThen(fs.rename(`${path}.next`, path))),
  ).pipe(Effect.ignore);

// The listener reconciled on the port remembered at `path`, and the port
// it listens on remembered when that moved (the first start, or one the
// remembered port was taken from).
export const reconcileOnLastPort = Effect.fnUntraced(function* (
  link: Pick<DeviceLink.DeviceLink["Service"], "reconcile" | "status">,
  path: string,
  wanted: Effect.Effect<Omit<DeviceLink.WsServerStartOpts, "port"> | null>,
) {
  const last = yield* rememberedPort(path);
  yield* link.reconcile(
    Effect.map(wanted, (opts) =>
      opts === null ? null : { ...opts, port: last },
    ),
  );
  const now = yield* link.status;
  if (now.listening && now.port !== null && now.port !== last) {
    yield* rememberPort(path, now.port);
  }
});
