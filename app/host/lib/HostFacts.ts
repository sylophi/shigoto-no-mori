// What the host knows of the app it serves: handed over once, as it
// starts, by the shell that started it (main/hostProcess.ts). The host
// asks Electron nothing, so its version, where its binaries are and the
// page origin its loopback admits all come from here.
import * as Context from "effect/Context";
import type { HostFacts as Facts } from "@shared/hostFacts";

export class HostFacts extends Context.Service<HostFacts, Facts>()(
  "sm/host/HostFacts",
) {}
