// Bindings and vars the Worker and the Durable Object see. Kept in
// its own module so worker.ts and hubObject.ts can share it without
// importing each other.
export interface Env {
  DB: D1Database;
  ACCOUNT_HUB: DurableObjectNamespace;
  // Wrangler secret, only read by the real Clerk verifier in index.ts.
  CLERK_SECRET_KEY: string;
  // Ticket TTL override in milliseconds, a test seam. Production
  // leaves it unset and gets TICKET_TTL_MS from hub/src/ticket.ts.
  TICKET_TTL_MS?: string;
  // Per-device tunnel provisioning (v2 step 10, slice B). All four
  // must be set for POST /tunnel to work. Any unset means the tunnel
  // routes answer the typed "not configured" and everything else works
  // as before. CLOUDFLARE_API_TOKEN is a wrangler secret (needs
  // Cloudflare Tunnel edit and DNS edit permissions), the rest are
  // plain vars. Placeholders only in wrangler.jsonc, never real
  // values.
  CLOUDFLARE_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  TUNNEL_ZONE_ID?: string;
  // The DNS zone's tunnel parent domain, e.g. sm.example.com: each
  // device gets `<name>.<TUNNEL_DOMAIN>`.
  TUNNEL_DOMAIN?: string;
}
