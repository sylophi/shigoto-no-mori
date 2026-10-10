// The services the host's handlers answer on (host/process/services.ts),
// for a proof that serves them on a wire of its own (directBoot.mts) or
// runs one directly.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Layer from "effect/Layer";
import * as Ports from "../../host/lib/ports.ts";
import * as Terrier from "../../host/lib/terrier.ts";

export const hostServices = Layer.mergeAll(Ports.layer, Terrier.layer).pipe(
  Layer.provideMerge(NodeServices.layer),
);
