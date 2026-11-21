// The platform the engine's tests run on, as the app and the terminal
// take theirs (canonicalPlatform.ts).
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Layer from "effect/Layer";
import { canonicalPlatform } from "../../src/canonicalPlatform.ts";

export const layer = canonicalPlatform(
  Layer.mergeAll(
    NodeServices.layer,
    NodeCrypto.layerSecureRandom,
    NodeCrypto.layerDigest,
  ),
);
