// Bindings and vars the Worker and the Durable Object see. Kept in
// its own module so worker.ts and relayObject.ts can share it without
// importing each other.
export interface Env {
  DB: D1Database;
  ACCOUNT_RELAY: DurableObjectNamespace;
  // Wrangler secret, only read by the real Clerk verifier in index.ts.
  CLERK_SECRET_KEY: string;
  // Exact origin of the future web client. Unset means only
  // Origin-less clients (the desktop app) are allowed.
  ALLOWED_WEB_ORIGIN?: string;
  // Ticket TTL override in milliseconds, a test seam. Production
  // leaves it unset and gets TICKET_TTL_MS from relay/src/ticket.ts.
  TICKET_TTL_MS?: string;
}
