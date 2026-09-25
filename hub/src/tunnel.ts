// Per-device Cloudflare named tunnels. The
// Worker PROVISIONS tunnels through the Cloudflare API but never
// carries their traffic: data rides Cloudflare's tunnel edge directly
// between the dialing client and the host's cloudflared connector,
// which fronts the host's loopback direct listener only.
//
// One tunnel per device, under a DETERMINISTIC name derived from the
// account and device ids, so provisioning is create-or-reuse with no
// new D1 state: the name is the lookup key, re-provisioning with a new
// port only rewrites the remotely managed ingress config, and revoke
// can find the tunnel to tear down from the ids alone.
//
// Every Cloudflare API call goes through the injected fetch
// (HubDeps.cfFetch), following the createWorker(deps) Clerk seam, so
// the vitest suite stubs the CF API inside workerd with no network.
import type { Env } from "./env.ts";
import { sha256Hex } from "./crypto.ts";

// The tunnel env, present only when the owner configured all four
// values. Anything missing means the tunnel routes answer the typed
// "not configured" while the rest of the Worker works as before.
export interface TunnelEnv {
  apiToken: string;
  accountId: string;
  zoneId: string;
  domain: string;
}

export function tunnelEnvOf(env: Env): TunnelEnv | null {
  const apiToken = env.CLOUDFLARE_API_TOKEN ?? "";
  const accountId = env.CF_ACCOUNT_ID ?? "";
  const zoneId = env.TUNNEL_ZONE_ID ?? "";
  const domain = env.TUNNEL_DOMAIN ?? "";
  if (apiToken === "" || accountId === "" || zoneId === "" || domain === "") {
    return null;
  }
  return { apiToken, accountId, zoneId, domain };
}

// Deterministic per-device tunnel name: `sm-` plus leading hex of
// SHA-256(accountId + ":" + deviceId). Stable across calls, so the
// name is the create-or-reuse key and nothing new persists in D1. The
// hash keeps account and device ids out of public DNS labels.
//
// The width is a security bound. A name hit is reused, connector token
// and all, so the name IS the ownership check, and a device picks its
// own deviceId: at 128 bits nobody can search for one that lands on
// another device's name, where the old 48 made that an offline search.
const NAME_HEX = 32;
// The old width, for teardown only: a device provisioned before the
// widening still has a tunnel under it. Delete once none remain.
const LEGACY_NAME_HEX = 12;

export async function tunnelNameFor(
  accountId: string,
  deviceId: string,
  hexWidth = NAME_HEX,
): Promise<string> {
  const digest = await sha256Hex(`${accountId}:${deviceId}`);
  return `sm-${digest.slice(0, hexWidth)}`;
}

const CF_API_BASE = "https://api.cloudflare.com/client/v4";

// The slice of the CF response envelope we read. `result` shapes vary
// per endpoint, so callers cast the slice they need.
interface CfEnvelope {
  success: boolean;
  result: unknown;
}

// The CF API bound to one tunnel env and fetch, so provisioning and
// teardown do not thread both through every call.
function cfApi(cf: TunnelEnv, cfFetch: typeof fetch) {
  // One CF API round trip: bearer auth, JSON in and out, throws on a
  // non-2xx status or success:false so a CF failure can never be read as
  // a valid result. The type parameter names the `result` slice the
  // caller reads; CF envelopes are not schema-validated here, so it is
  // an assertion, kept in this one place.
  async function call<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const response = await cfFetch(`${CF_API_BASE}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${cf.apiToken}`,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let envelope: CfEnvelope | null = null;
    try {
      envelope = (await response.json()) as CfEnvelope;
    } catch {
      // Non-JSON body, the status check below reports it.
    }
    if (!response.ok || envelope === null || envelope.success !== true) {
      throw new Error(
        `cloudflare api ${method} ${path} failed with status ${response.status}`,
      );
    }
    return envelope.result as T;
  }

  // GET a CF list endpoint and take the first entry, the shape both
  // finders share (the query narrows to at most one match).
  async function findFirst<T>(path: string): Promise<T | null> {
    const result = await call<T[] | null>("GET", path);
    if (!Array.isArray(result) || result.length === 0) return null;
    return result[0];
  }

  return {
    call,
    // Finds this device's tunnel by its deterministic name, excluding
    // deleted tunnels (CF keeps them listed as tombstones).
    findTunnel: (name: string): Promise<CfTunnel | null> =>
      findFirst<CfTunnel>(
        `/accounts/${cf.accountId}/cfd_tunnel?name=${encodeURIComponent(name)}&is_deleted=false`,
      ),
    findDnsRecord: (fqdn: string): Promise<CfDnsRecord | null> =>
      findFirst<CfDnsRecord>(
        `/zones/${cf.zoneId}/dns_records?type=CNAME&name=${encodeURIComponent(fqdn)}`,
      ),
  };
}

type CfApi = ReturnType<typeof cfApi>;

interface CfTunnel {
  id: string;
}

interface CfDnsRecord {
  id: string;
  content?: string;
  proxied?: boolean;
}

// Ensures the proxied CNAME `<hostname>` points at the tunnel edge:
// created when absent, corrected in place when stale (a re-created
// tunnel has a new id that would otherwise be shadowed).
// Resolves true when the record was created (absent before), so the
// caller can tell a brand-new hostname from one that resolved before.
async function ensureDnsRecord(
  cf: TunnelEnv,
  api: CfApi,
  hostname: string,
  tunnelId: string,
): Promise<boolean> {
  const target = `${tunnelId}.cfargotunnel.com`;
  const body = {
    type: "CNAME",
    name: hostname,
    content: target,
    proxied: true,
  };
  const record = await api.findDnsRecord(hostname);
  if (record === null) {
    await api.call("POST", `/zones/${cf.zoneId}/dns_records`, body);
    return true;
  }
  if (record.content !== target || record.proxied !== true) {
    await api.call("PUT", `/zones/${cf.zoneId}/dns_records/${record.id}`, body);
  }
  return false;
}

// Create-or-reuse provisioning, idempotent by the deterministic name:
//   1. reuse the named tunnel or create it (remotely managed config),
//   2. PUT the ingress config routing the hostname to the device's
//      loopback listener port (plus the catch-all 404),
//   3. ensure the proxied CNAME `<name>.<domain>` to
//      `<tunnelId>.cfargotunnel.com`, on every provision: a device
//      re-provisions when its tunnel stopped routing, and a deleted or
//      stale record is exactly what that repairs,
//   4. fetch and return the connector run token.
// Steps 2 to 4 need only the tunnel id and are independent of each
// other, so they run concurrently. The loopback-only shape is pinned
// here: the ingress service the Worker writes is always
// http://127.0.0.1:<port>, so a tunnel can never front anything but
// the host's own loopback listener.
export async function provisionTunnel(
  cf: TunnelEnv,
  cfFetch: typeof fetch,
  accountId: string,
  deviceId: string,
  port: number,
): Promise<{ hostname: string; connectorToken: string; dnsCreated: boolean }> {
  const api = cfApi(cf, cfFetch);
  const name = await tunnelNameFor(accountId, deviceId);
  const hostname = `${name}.${cf.domain}`;

  let tunnel = await api.findTunnel(name);
  if (tunnel === null) {
    tunnel = await api.call<CfTunnel>(
      "POST",
      `/accounts/${cf.accountId}/cfd_tunnel`,
      // config_src cloudflare = remotely managed: the ingress lives in
      // the CF config the PUT below writes, so the connector needs
      // only the run token, no local config file.
      { name, config_src: "cloudflare" },
    );
  }

  const [, dnsCreated, connectorToken] = await Promise.all([
    api.call(
      "PUT",
      `/accounts/${cf.accountId}/cfd_tunnel/${tunnel.id}/configurations`,
      {
        config: {
          ingress: [
            { hostname, service: `http://127.0.0.1:${port}` },
            { service: "http_status:404" },
          ],
        },
      },
    ),
    ensureDnsRecord(cf, api, hostname, tunnel.id),
    api.call<string>(
      "GET",
      `/accounts/${cf.accountId}/cfd_tunnel/${tunnel.id}/token`,
    ),
  ]);
  return { hostname, connectorToken, dnsCreated };
}

// Best-effort teardown for device revoke: delete the tunnel (cascade
// drops its live connections) and its DNS record. The two halves are
// independent and each individually swallowed, so they run
// concurrently and revoke succeeds whether or not the CF cleanup does.
// An orphaned tunnel is idle configuration, not a capability (its
// connector token died with the revoked device's provisioning access).
export async function teardownTunnel(
  cf: TunnelEnv,
  cfFetch: typeof fetch,
  accountId: string,
  deviceId: string,
): Promise<void> {
  const api = cfApi(cf, cfFetch);
  const names = await Promise.all([
    tunnelNameFor(accountId, deviceId),
    tunnelNameFor(accountId, deviceId, LEGACY_NAME_HEX),
  ]);
  // Deletes what a finder found, if anything.
  const deleteFound = async (
    find: Promise<{ id: string } | null>,
    path: (id: string) => string,
  ): Promise<void> => {
    try {
      const found = await find;
      if (found !== null) await api.call("DELETE", path(found.id));
    } catch {
      // Best-effort, see above.
    }
  };
  await Promise.all(
    names.flatMap((name) => [
      deleteFound(
        api.findTunnel(name),
        (id) => `/accounts/${cf.accountId}/cfd_tunnel/${id}?cascade=true`,
      ),
      deleteFound(
        api.findDnsRecord(`${name}.${cf.domain}`),
        (id) => `/zones/${cf.zoneId}/dns_records/${id}`,
      ),
    ]),
  );
}
