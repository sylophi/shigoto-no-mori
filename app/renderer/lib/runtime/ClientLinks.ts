// The links a client's calls ride, by contract module: in a desktop
// window the host's modules over the loopback and the rest over the
// shell's port, in the web client the tab itself for all of them. Each
// flavour of client provides it (desktop.ts, web/ipc/register.ts, the
// lab's fake host).
import type { ContractModule } from "@shigomori/contracts/contract";
import * as Context from "effect/Context";
import type { Link } from "@shared/ipc/transport";

export class ClientLinks extends Context.Service<
  ClientLinks,
  {
    readonly linkOf: (module: ContractModule) => Link;
  }
>()("sm/renderer/ClientLinks") {}
