import {
  annotation,
  callOf,
  type ContractModule,
  channelOf,
  isPush,
  nameOf,
  payloadOf,
  Remote,
} from "@shigomori/contracts/contract";
import type { PushKeys, PushProducerPayload } from "@shigomori/contracts/types";
import * as Schema from "effect/Schema";

// A push as it goes out: its channel, whether a peer may hear it, and
// its payload decoded at the source, so a producer bug surfaces here
// rather than as a shape the far end can't read.
export function resolvePush<M extends ContractModule, K extends PushKeys<M>>(
  module: M,
  key: K,
  payload: PushProducerPayload<M, K>,
): { channel: string; payload: unknown; remote: boolean } {
  const call = callOf(module, key);
  if (!isPush(call)) {
    throw new Error(`${nameOf(module)}:${key} is not a push`);
  }
  return {
    channel: channelOf(call),
    payload: Schema.decodeUnknownSync(payloadOf(call))(payload),
    remote: annotation(call, Remote) === true,
  };
}
