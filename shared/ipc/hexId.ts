import { z } from "zod";

// The wire shape of every host-minted opaque id (sync transferIds,
// byte channel ids, port-forward forwardIds): 16 random bytes as 32 hex
// chars. Pinning the exact shape means a caller can only replay an id
// it was given, never probe with crafted ones. The minting half lives
// host-side (mintHexId in host/lib/idleRegistry.ts), which is where
// node:crypto is allowed. Shared code that has to mint in a browser too
// reaches for Web Crypto instead (newHandshakeNonce in
// shared/ipc/socket/proof.ts).
export const HexId32Schema = z.string().regex(/^[0-9a-f]{32}$/);
