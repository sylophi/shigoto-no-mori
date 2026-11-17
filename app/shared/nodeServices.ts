// The platform services the app's processes run on: the shell's and the
// host's layer graphs, and the runs made before them.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { canonicalPlatform } from "@shigomori/engine/canonicalPlatform";

export const layer = canonicalPlatform(NodeServices.layer);
