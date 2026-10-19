// The relay the hub delivers against the one a device sent: a sender
// measures what the hub will by deliveredRelayGrowth, so for any ids
// and frame, ids JSON must escape included, the sent envelope plus that
// growth is the delivered one's size exactly (hubObject.ts measures
// deliveredRelay, link.ts predicts).
import { expect, it } from "vitest";
import {
  deliveredRelay,
  deliveredRelayGrowth,
  encodeEnvelope,
  utf8ByteLength,
} from "../src/hubProtocol.ts";

const cases: ReadonlyArray<readonly [string, string, string]> = [
  ["dev-a", "dev-b", "ask:1:x"],
  ["a-much-longer-sender-id", "b", "x".repeat(4000)],
  ["dév-ü", "dev-ñ", 'frame with "quotes" and ünïcode 🌲'],
  ['dev"quoted', "dev\\back", "x"],
];

it("predicts the delivered relay's size from the sent one", () => {
  for (const [from, to, frame] of cases) {
    const sent = encodeEnvelope({ t: "relay", to, frame });
    expect(utf8ByteLength(sent) + deliveredRelayGrowth(from, to)).toBe(
      utf8ByteLength(deliveredRelay(from, frame)),
    );
  }
});
