// The root's facts, off the command line the shell started this
// process with. Everything below the root reads them as the HostFacts
// service (lib/HostFacts.ts), which the root provides from these.
import * as Schema from "effect/Schema";
import { bundledBinaryPath } from "@shared/packaging/bundledBinary.mts";
import {
  HOST_FACTS_FLAG,
  type HostFacts,
  HostFactsSchema,
} from "@host/lib/HostFacts";

let parsed: HostFacts["Service"] | undefined;

export function hostFacts(): HostFacts["Service"] {
  if (parsed !== undefined) return parsed;
  const arg = process.argv.find((value) => value.startsWith(HOST_FACTS_FLAG));
  if (arg === undefined) throw new Error("the host was started without facts");
  parsed = Schema.decodeUnknownSync(Schema.fromJsonString(HostFactsSchema))(
    arg.slice(HOST_FACTS_FLAG.length),
  );
  return parsed;
}

export const hostBinaryPath = (devDistDir: string, name: string): string =>
  bundledBinaryPath(hostFacts(), devDistDir, name);
