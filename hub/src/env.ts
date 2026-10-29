// Bindings and vars the Worker and the Durable Object see, and the
// services that hand them to the Effect side. Kept in its own module so
// the Worker and the object can share it without importing each other.
import * as Context from "effect/Context";
import type { DeviceHub } from "./hubObject.ts";

// What each secret holds and how it is set is README.md's (Deploy, Per-
// device tunnels).
export interface Env {
  DB: D1Database;
  DEVICE_HUB: DurableObjectNamespace<DeviceHub>;
  CLERK_SECRET_KEY: string;
  // The device grant's OAuth application. Without it, an OAuth access
  // token enrolls nothing.
  CLERK_OAUTH_CLIENT_ID?: string;
  // Optional because a deploy can miss it: minting then answers
  // HubTicketSigningUnconfiguredError instead of an unsigned ticket.
  TICKET_SIGNING_KEY?: string;
  // RATE_LIMIT_OPEN is the tighter budget, for enroll and connect.
  RATE_LIMIT: RateLimit;
  RATE_LIMIT_OPEN: RateLimit;
  // All four, or POST /tunnel answers HubTunnelUnconfiguredError.
  CLOUDFLARE_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  TUNNEL_ZONE_ID?: string;
  TUNNEL_DOMAIN?: string;
}

export class WorkerEnv extends Context.Service<WorkerEnv, Env>()(
  "sm/hub/WorkerEnv",
) {}

// The request's execution context: work that may finish after the
// response (a best-effort tunnel teardown) is handed to waitUntil.
export class WaitUntil extends Context.Service<
  WaitUntil,
  (promise: Promise<unknown>) => void
>()("sm/hub/WaitUntil") {}
