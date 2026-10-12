// Fake host entry: the fixture bridge, then the shared boot on its api.
import { bootFakeHost } from "./boot";
import { installFakeHostBridge } from "./bridge";
import { applyPose } from "./pose";

// The shared theme pose (pose.ts). This entry also answers
// ?peers (bridge.ts) and ?to=/account, the memory-router route
// applied after mount.
applyPose();

bootFakeHost(installFakeHostBridge());
