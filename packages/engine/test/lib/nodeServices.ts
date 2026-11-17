// The platform the engine's tests run on, as the app and the terminal
// take theirs (canonicalPlatform.ts).
import * as NodeServices from "@effect/platform-node/NodeServices";
import { canonicalPlatform } from "../../src/canonicalPlatform.ts";

export const layer = canonicalPlatform(NodeServices.layer);
