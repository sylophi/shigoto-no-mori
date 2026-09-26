import { z } from "zod";

// The wire shape of every minted opaque id (byte channel ids,
// port-forward forwardIds, connect tickets): 16 random bytes as 32 hex
// chars. Pinning the exact shape means a caller can only replay an id
// it was given, never probe with crafted ones. The minting half lives
// host-side (mintHexId in host/lib/hexId.ts) because shared/
// modules must stay free of node builtins.
export const HexId32Schema = z.string().regex(/^[0-9a-f]{32}$/);
