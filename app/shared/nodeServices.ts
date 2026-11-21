// The platform services the app's processes run on: the shell's and the
// host's layer graphs, and the runs made before them.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { canonicalPlatform } from "@shigomori/engine/canonicalPlatform";
import * as Layer from "effect/Layer";

export const layer = canonicalPlatform(
  Layer.mergeAll(
    NodeServices.layer,
    NodeCrypto.layerSecureRandom,
    NodeCrypto.layerDigest,
  ),
);
