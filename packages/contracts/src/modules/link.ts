import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";
import { defineContract, Gated, invoke, Remote } from "../contract.ts";
import { CallFailureSchema } from "../errors.ts";
import { DeviceIdSchema } from "../hubProtocol.ts";
import { HexId32Schema } from "../schemas/hexId.ts";
import { VoidSchema } from "../schemas/void.ts";
import { strict } from "../schemas/strict.ts";

// The device link's own calls: the handshake every connection opens
// with, the liveness probe, and the byte channels that forwarded ports
// and mirror streams ride. Every other call on a link is a contract
// module's, served once the hello is accepted (app/host/socket/).
//
// The handshake proves the connect ticket without sending it: the
// ticket minted for one candidate address over the hub (modules/
// direct.ts) is answered by whoever holds that address on the dialer's
// network, so the dialer asks for the host's nonce (challenge), sends
// its own with an HMAC of both under the ticket (hello), and trusts
// the answer only once the host's HMAC of the same pair checks out
// (app/shared/remote/proof.ts). A challenge spends nothing, so a dialer
// asks every candidate at once and says hello on one at a time.
//
// The hello carries the protocol version (protocol.ts). A host on
// another version refuses it with ProtocolVersionMismatchError.

// A nonce: 16 random bytes as hex.
const NonceSchema = HexId32Schema;
// An HMAC-SHA-256, as hex.
const ProofSchema = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));
const AppVersionSchema = Schema.String.check(Schema.isMaxLength(64));

const ChallengeSchema = strict(Schema.Struct({ nonce: NonceSchema }));

const HelloSchema = strict(
  Schema.Struct({
    deviceId: DeviceIdSchema,
    appVersion: AppVersionSchema,
    protocolVersion: Schema.Int,
    nonce: NonceSchema,
    proof: ProofSchema,
  }),
);

const WelcomeSchema = strict(
  Schema.Struct({
    deviceId: DeviceIdSchema,
    appVersion: AppVersionSchema,
    proof: ProofSchema,
  }),
);

// A byte channel on the link, named by the id its opener minted before
// the call that attaches the far end (forward:open, mirror:openStream,
// sync:openSource, sync:receiveBundle).
const ChannelSchema = strict(Schema.Struct({ channelId: HexId32Schema }));

// The most one write carries. A writer splits larger pieces.
export const CHANNEL_MAX_WRITE_BYTES = 256 * 1024;

// A writer keeps several writes in flight, numbered from 0 per
// channel, and the far end takes them in that order.
const WriteSchema = strict(
  Schema.Struct({
    channelId: HexId32Schema,
    seq: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    data: Schema.Uint8ArrayFromBase64.check(
      Schema.makeFilter((bytes) => bytes.byteLength <= CHANNEL_MAX_WRITE_BYTES),
    ),
  }),
);

// The far end's bytes, pulled: the next piece goes out once the reader
// has taken the last, so a slow reader holds the far end back. Ends
// with the far end's direction.
const read = Rpc.make("read", {
  payload: ChannelSchema,
  success: Schema.Uint8ArrayFromBase64,
  error: CallFailureSchema,
  stream: true,
})
  .annotate(Remote, true)
  .annotate(Gated, false);

const link = { remote: true, gated: false } as const;

export const linkContract = defineContract(
  "link",
  "host",
  invoke("challenge", VoidSchema, ChallengeSchema, link),
  invoke("hello", HelloSchema, WelcomeSchema, link),
  // Answers at once: a probe of a link that may have died unseen.
  invoke("ping", VoidSchema, VoidSchema, link),
  read,
  // Bytes to the far end. Answers once the far end has taken them.
  invoke("write", WriteSchema, VoidSchema, link),
  // Ends this side's direction. The far end's may go on.
  invoke("end", ChannelSchema, VoidSchema, link),
  // Tears the channel down, both directions.
  invoke("reset", ChannelSchema, VoidSchema, link),
);
