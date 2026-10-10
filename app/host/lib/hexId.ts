// The host-minted opaque id whose wire shape HexId32Schema
// (packages/contracts/src/schemas/hexId.ts) pins: 16 random bytes, hex.
// Lives here rather than beside the schema because contracts must stay
// free of node builtins.
import { randomBytes } from "node:crypto";

export function mintHexId(): string {
  return randomBytes(16).toString("hex");
}
