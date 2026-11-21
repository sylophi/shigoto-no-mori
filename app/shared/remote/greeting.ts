// A peer link's greeting (contracts' modules/link.ts) as the bytes
// Colibrii carries: the dialer's hello, the host's welcome, and its
// refusal of a dialer on another core.
import {
  type PeerHello,
  PeerHelloSchema,
  type PeerWelcome,
  PeerWelcomeSchema,
  PeerRefusalSchema,
} from "@shigomori/contracts/modules/link";
import type { OutdatedSide } from "@shigomori/contracts/errors";
import { CORE_VERSION } from "@shigomori/contracts/protocol";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const codec = <A, I>(schema: Schema.Codec<A, I>) => {
  const json = Schema.fromJsonString(schema);
  return {
    encode: (value: A): Uint8Array =>
      encoder.encode(Schema.encodeSync(json)(value)),
    decode: (bytes: Uint8Array): A | null =>
      Option.getOrNull(Schema.decodeUnknownOption(json)(decoder.decode(bytes))),
  };
};

const hello = codec(PeerHelloSchema);
const welcome = codec(PeerWelcomeSchema);
const refusal = codec(PeerRefusalSchema);

export const encodeHello = (appVersion: string): Uint8Array =>
  hello.encode({ appVersion, coreVersion: CORE_VERSION });
export const decodeHello = (bytes: Uint8Array): PeerHello | null =>
  hello.decode(bytes);

export const encodeWelcome = (value: PeerWelcome): Uint8Array =>
  welcome.encode(value);
export const decodeWelcome = (bytes: Uint8Array): PeerWelcome | null =>
  welcome.decode(bytes);

export const encodeRefusal = (clientVersion: number): Uint8Array =>
  refusal.encode({ hostVersion: CORE_VERSION, clientVersion });

// The end on the older core, from a host's refusal.
export const coreOutdatedOf = (bytes: Uint8Array): OutdatedSide | null => {
  const decoded = refusal.decode(bytes);
  if (decoded === null) return null;
  return decoded.hostVersion < decoded.clientVersion ? "peer" : "this";
};
