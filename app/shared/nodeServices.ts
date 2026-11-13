// The platform services the app's processes run on, the one place each
// takes them from: the shell, the host (host/process/nodeServices.ts
// adds its removes to them), and what runs before their layer graphs.
import * as NodeServices from "@effect/platform-node/NodeServices";

export const layer = NodeServices.layer;
