// The port the device link listened on last, kept beside the app's
// state, so a host that restarts or relaunches listens on it again: a
// peer's LAN address for it and its tunnel's ingress stay right. The
// tunnel's ingress is written when the tunnel is provisioned, and a
// later provision on another port has been seen to leave the connector
// on the first (V3.md, step 7, the reliability pass).
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

// The port remembered at `path`, or 0 (any) when there is none.
export const rememberedPort = (path: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(path)).pipe(
    Effect.map((text) => {
      const port = Number(text.trim());
      return Number.isInteger(port) && port > 0 && port < 65_536 ? port : 0;
    }),
    Effect.orElseSucceed(() => 0),
  );

export const rememberPort = (path: string, port: number) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    fs.writeFileString(path, `${port}\n`),
  ).pipe(Effect.ignore);
