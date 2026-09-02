// Bindings and vars the Worker and the Durable Object see. Kept in
// its own module so worker.ts and hubObject.ts can share it without
// importing each other.
export interface Env {
  DB: D1Database;
  DEVICE_HUB: DurableObjectNamespace;
  // Wrangler secret, only read by the real Clerk verifier in index.ts.
  CLERK_SECRET_KEY: string;
  // Ticket TTL override in milliseconds, a test seam. Production
  // leaves it unset and gets TICKET_TTL_MS from hub/src/ticket.ts.
  TICKET_TTL_MS?: string;
  // Per-device tunnel provisioning (v2 step 10, slice B). All four
  // must be set for POST /tunnel to work. Any unset means the tunnel
  // routes answer the typed "not configured" and everything else works
  // as before. All four are wrangler secrets (dashboard-set plain
  // vars do not survive a deploy); the API token needs Cloudflare
  // Tunnel edit and DNS edit on the tunnel zone. See README.md.
  CLOUDFLARE_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  TUNNEL_ZONE_ID?: string;
  // The tunnel zone apex, e.g. example.link: each device gets
  // `<name>.<TUNNEL_DOMAIN>`, one label deep so Universal SSL covers
  // it.
  TUNNEL_DOMAIN?: string;
}
