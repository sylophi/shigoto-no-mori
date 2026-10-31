// What the shell registers to serve (shared/ipc/served.ts), and the
// pushes it fans out to every window, for its link (ShellLink.ts).
// Registration comes first, at boot, and the server reads it once each
// port is attached.
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import { createServed } from "@shared/ipc/served";
import type { HandlerContext } from "@shared/ipc/transport";
import type { Push, ShellRegistrar } from "./ShellLink";

export function createShellRegistrar(): ShellRegistrar {
  return {
    ...createServed<HandlerContext>(),
    pushes: Effect.runSync(PubSub.unbounded<Push>()),
  };
}
