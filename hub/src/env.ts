// Bindings and vars the Worker and the Durable Object see. Kept in
// its own module so worker.ts and hubObject.ts can share it without
// importing each other.
export interface Env {
  DB: D1Database;
  DEVICE_HUB: DurableObjectNamespace;
  // Wrangler secret, only read by the real Clerk verifier in index.ts.
  CLERK_SECRET_KEY: string;
  // Wrangler secret keying the HMAC over connection tickets (see
  // src/ticket.ts), any high-entropy string. Optional in the type
  // because a deploy can miss it: minting then answers a 500 that
  // names the missing secret instead of issuing unsigned tickets.
  TICKET_SIGNING_KEY?: string;
  // Per-IP rate limiters (wrangler.jsonc `ratelimits`). RATE_LIMIT
  // covers the routes that do nothing without a device credential.
  // RATE_LIMIT_OPEN is the tighter one for the two routes where a
  // caller with no credential still makes the Worker do real work:
  // enroll (Clerk verification) and connect (a Durable Object).
  RATE_LIMIT: RateLimit;
  RATE_LIMIT_OPEN: RateLimit;
  // Ticket TTL override in milliseconds, a test seam. Production
  // leaves it unset and gets TICKET_TTL_MS from hub/src/ticket.ts.
  TICKET_TTL_MS?: string;
  // Per-device tunnel provisioning. All four
  // must be set for POST /tunnel to work. Any unset means the tunnel
  // routes answer the typed "not configured" and everything else works
  // as before. All four are wrangler secrets (dashboard-set plain
  // vars do not survive a deploy). The API token needs Cloudflare
  // Tunnel edit and DNS edit on the tunnel zone. See README.md.
  CLOUDFLARE_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  TUNNEL_ZONE_ID?: string;
  // The tunnel zone apex, e.g. example.link: each device gets
  // `<name>.<TUNNEL_DOMAIN>`, one label deep so Universal SSL covers
  // it.
  TUNNEL_DOMAIN?: string;
}
