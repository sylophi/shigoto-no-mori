// The two links a client's calls ride: to the side that serves the
// client modules (the window's shell, or the tab itself), and to this
// machine's host (the loopback). Each flavour of client provides it,
// the desktop window in desktop.ts.
import * as Context from "effect/Context";
import type { Link } from "@shared/ipc/transport";

export class ClientLinks extends Context.Service<
  ClientLinks,
  {
    readonly shell: Link;
    readonly host: Link;
  }
>()("sm/renderer/ClientLinks") {}
