// Tunnel provisioning: POST /tunnel and the
// revoke-time teardown, driven through a worker whose Cloudflare API
// fetch is the in-memory stub below (the createWorker(deps) seam, like
// the Clerk stub), so everything runs inside workerd with no network.
// Enrollment rides the shared helpers (D1 is shared across worker
// instances), the tunnel calls ride a helper-made worker with the CF
// stub injected.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  TUNNEL_UNCONFIGURED_STATUS,
  TunnelProvisionResponseSchema,
} from "../../shared/hub/protocol.ts";
import type { Env } from "../src/env.ts";
import {
  call,
  enroll,
  makeTestWorker,
  provisionRequest,
  revokeRequest,
} from "./helpers.ts";

// The tunnel env every configured-case test runs under. Obviously fake
// test values, never real ids.
function tunnelEnv(): Env {
  return {
    ...env,
    CLOUDFLARE_API_TOKEN: "cf-test-api-token",
    CF_ACCOUNT_ID: "cf-test-account",
    TUNNEL_ZONE_ID: "cf-test-zone",
    TUNNEL_DOMAIN: "sm.example.test",
  };
}

interface StubTunnel {
  id: string;
  name: string;
  deleted: boolean;
}

interface StubDnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied: boolean;
}

function ok(result: unknown): Response {
  return Response.json({ success: true, result });
}

// In-memory Cloudflare API: exactly the endpoints hub/src/tunnel.ts
// calls, answering the CF `{ success, result }` envelope. Everything
// the worker did is observable on the returned state.
function createCfStub(opts: { failDeletes?: boolean } = {}) {
  const tunnels: StubTunnel[] = [];
  const dnsRecords: StubDnsRecord[] = [];
  // tunnelId to its last-PUT ingress config.
  const configs = new Map<string, unknown>();
  const calls: string[] = [];
  let nextId = 1;

  const cfFetch: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string" ? input : (input as Request).url,
    );
    const method = init?.method ?? "GET";
    const body =
      init?.body === undefined ? null : JSON.parse(init.body as string);
    calls.push(`${method} ${url.pathname}${url.search}`);
    expect(url.origin).toBe("https://api.cloudflare.com");
    const auth = new Headers(init?.headers).get("authorization");
    expect(auth).toBe("Bearer cf-test-api-token");
    const path = url.pathname.replace("/client/v4", "");

    const tunnelList = path === "/accounts/cf-test-account/cfd_tunnel";
    if (method === "GET" && tunnelList) {
      const name = url.searchParams.get("name");
      return ok(
        tunnels.filter((tunnel) => tunnel.name === name && !tunnel.deleted),
      );
    }
    if (method === "POST" && tunnelList) {
      const tunnel: StubTunnel = {
        id: `tun-${nextId++}`,
        name: (body as { name: string }).name,
        deleted: false,
      };
      expect((body as { config_src: string }).config_src).toBe("cloudflare");
      tunnels.push(tunnel);
      return ok({ id: tunnel.id });
    }
    const tunnelMatch =
      /^\/accounts\/cf-test-account\/cfd_tunnel\/([^/]+)(\/.*)?$/.exec(path);
    if (tunnelMatch !== null) {
      const [, id, rest] = tunnelMatch;
      if (method === "PUT" && rest === "/configurations") {
        configs.set(id, body);
        return ok(body);
      }
      if (method === "GET" && rest === "/token") {
        return ok(`connector-token-for-${id}`);
      }
      if (method === "DELETE" && (rest === undefined || rest === "")) {
        if (opts.failDeletes === true) {
          return Response.json(
            { success: false, result: null },
            {
              status: 500,
            },
          );
        }
        const tunnel = tunnels.find((entry) => entry.id === id);
        if (tunnel !== undefined) tunnel.deleted = true;
        return ok(null);
      }
    }
    const dnsList = path === "/zones/cf-test-zone/dns_records";
    if (method === "GET" && dnsList) {
      const name = url.searchParams.get("name");
      return ok(dnsRecords.filter((record) => record.name === name));
    }
    if (method === "POST" && dnsList) {
      const record = { id: `dns-${nextId++}`, ...(body as object) };
      dnsRecords.push(record as StubDnsRecord);
      return ok(record);
    }
    const dnsMatch = /^\/zones\/cf-test-zone\/dns_records\/([^/]+)$/.exec(path);
    if (dnsMatch !== null) {
      const index = dnsRecords.findIndex((record) => record.id === dnsMatch[1]);
      if (method === "PUT" && index >= 0) {
        dnsRecords[index] = {
          ...(body as StubDnsRecord),
          id: dnsMatch[1],
        };
        return ok(dnsRecords[index]);
      }
      if (method === "DELETE" && index >= 0) {
        if (opts.failDeletes === true) {
          return Response.json(
            { success: false, result: null },
            {
              status: 500,
            },
          );
        }
        dnsRecords.splice(index, 1);
        return ok(null);
      }
    }
    throw new Error(`cf stub: unexpected ${method} ${path}`);
  };

  return {
    cfFetch,
    tunnels,
    dnsRecords,
    configs,
    calls,
    liveTunnels: () => tunnels.filter((tunnel) => !tunnel.deleted),
  };
}

describe("POST /tunnel", () => {
  it("provisions a named tunnel: created once, ingress at the loopback port, DNS ensured, connector token returned", async () => {
    const stub = createCfStub();
    const worker = makeTestWorker({ cfFetch: stub.cfFetch });
    const { credential } = await enroll("acct-tunnel-happy", "dev-th-1");
    const response = await call(
      provisionRequest(credential, 4321),
      tunnelEnv(),
      worker,
    );
    expect(response.status).toBe(200);
    const body = TunnelProvisionResponseSchema.parse(await response.json());
    // Deterministic name: sm- plus 12 hex under the configured domain.
    expect(body.hostname).toMatch(/^sm-[0-9a-f]{12}\.sm\.example\.test$/);
    expect(stub.liveTunnels()).toHaveLength(1);
    const tunnel = stub.liveTunnels()[0];
    expect(body.hostname).toBe(`${tunnel.name}.sm.example.test`);
    expect(body.connectorToken).toBe(`connector-token-for-${tunnel.id}`);
    // The remotely managed ingress fronts loopback ONLY, with the
    // catch-all 404 behind it.
    expect(stub.configs.get(tunnel.id)).toEqual({
      config: {
        ingress: [
          { hostname: body.hostname, service: "http://127.0.0.1:4321" },
          { service: "http_status:404" },
        ],
      },
    });
    // The proxied CNAME points the hostname at the tunnel edge.
    expect(stub.dnsRecords).toEqual([
      {
        id: expect.any(String),
        type: "CNAME",
        name: body.hostname,
        content: `${tunnel.id}.cfargotunnel.com`,
        proxied: true,
      },
    ]);
  });

  it("re-provisions idempotently: the tunnel and DNS record are reused, only the ingress port changes", async () => {
    const stub = createCfStub();
    const worker = makeTestWorker({ cfFetch: stub.cfFetch });
    const { credential } = await enroll("acct-tunnel-idem", "dev-ti-1");
    const first = await call(
      provisionRequest(credential, 4321),
      tunnelEnv(),
      worker,
    );
    expect(first.status).toBe(200);
    const firstBody = TunnelProvisionResponseSchema.parse(await first.json());
    const second = await call(
      provisionRequest(credential, 9999),
      tunnelEnv(),
      worker,
    );
    expect(second.status).toBe(200);
    const secondBody = TunnelProvisionResponseSchema.parse(await second.json());
    // Same tunnel, same hostname, same DNS record: nothing duplicated.
    // Only the first provision created the record.
    expect(secondBody.hostname).toBe(firstBody.hostname);
    expect(firstBody.dnsCreated).toBe(true);
    expect(secondBody.dnsCreated).toBe(false);
    expect(stub.liveTunnels()).toHaveLength(1);
    expect(stub.dnsRecords).toHaveLength(1);
    // The ingress now names the new port.
    const tunnel = stub.liveTunnels()[0];
    expect(stub.configs.get(tunnel.id)).toEqual({
      config: {
        ingress: [
          {
            hostname: secondBody.hostname,
            service: "http://127.0.0.1:9999",
          },
          { service: "http_status:404" },
        ],
      },
    });
  });

  it("answers the typed unconfigured status when the tunnel env is unset, and the CF API is never called", async () => {
    const stub = createCfStub();
    const worker = makeTestWorker({ cfFetch: stub.cfFetch });
    const { credential } = await enroll("acct-tunnel-off", "dev-to-1");
    // Plain env: no tunnel vars at all.
    const response = await call(
      provisionRequest(credential, 4321),
      env,
      worker,
    );
    expect(response.status).toBe(TUNNEL_UNCONFIGURED_STATUS);
    expect(await response.json()).toEqual({
      error: "tunnel provisioning is not configured",
    });
    expect(stub.calls).toEqual([]);
  });

  it("requires a device credential and a valid port", async () => {
    const stub = createCfStub();
    const worker = makeTestWorker({ cfFetch: stub.cfFetch });
    const unauthed = await call(
      provisionRequest("smdc_not-a-real-credential", 4321),
      tunnelEnv(),
      worker,
    );
    expect(unauthed.status).toBe(401);
    const { credential } = await enroll("acct-tunnel-auth", "dev-ta-1");
    const badPort = await call(
      provisionRequest(credential, 0),
      tunnelEnv(),
      worker,
    );
    expect(badPort.status).toBe(400);
    expect(stub.calls).toEqual([]);
  });
});

describe("tunnel teardown on revoke", () => {
  it("revoking a provisioned device deletes its tunnel and DNS record", async () => {
    const stub = createCfStub();
    const worker = makeTestWorker({ cfFetch: stub.cfFetch });
    const { credential } = await enroll("acct-tunnel-rev", "dev-tr-1");
    const provisioned = await call(
      provisionRequest(credential, 4321),
      tunnelEnv(),
      worker,
    );
    expect(provisioned.status).toBe(200);
    expect(stub.liveTunnels()).toHaveLength(1);
    const revoked = await call(
      revokeRequest(credential, "dev-tr-1"),
      tunnelEnv(),
      worker,
    );
    expect(revoked.status).toBe(204);
    expect(stub.liveTunnels()).toHaveLength(0);
    expect(stub.dnsRecords).toHaveLength(0);
  });

  it("a CF teardown failure never fails the revoke itself", async () => {
    const stub = createCfStub({ failDeletes: true });
    const worker = makeTestWorker({ cfFetch: stub.cfFetch });
    const { credential } = await enroll("acct-tunnel-revfail", "dev-trf-1");
    const provisioned = await call(
      provisionRequest(credential, 4321),
      tunnelEnv(),
      worker,
    );
    expect(provisioned.status).toBe(200);
    const revoked = await call(
      revokeRequest(credential, "dev-trf-1"),
      tunnelEnv(),
      worker,
    );
    // The credential and row are gone even though CF refused: teardown
    // is best-effort by design.
    expect(revoked.status).toBe(204);
  });
});
