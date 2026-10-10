// The clients' network, as switches the harness throws. Each client
// reaches what lies off this machine through a proxy the harness owns,
// so going down stops every byte of every flow (the hub socket, the
// device link, Clerk) the way a dropped network does, which Chrome's
// own offline emulation does not do to a socket already open. Down,
// new connections are refused and open ones stall. Back up, the
// stalled flows either resume (a blip the network rode out) or are cut
// (a network that changed under them, as after a sleep).
//
// - NetworkSwitch: the browser's CONNECT proxy, for everything Chrome
//   reaches but this machine's own servers.
// - HubFront: a desktop app's hub, the dev hub behind a local http
//   address the app is given as SM_DEVICE_HUB_URL.
// - ListenerFront: the peer's direct listener, at the port it
//   advertises (SHIGOMORI_DIRECT_FRONT_PORT) for its LAN candidates and
//   its tunnel's ingress, so every client's device link to it rides
//   through here.
import {
  connect,
  createServer as createTcpServer,
  type Socket,
} from "node:net";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
} from "node:http";
import { request as httpsRequest } from "node:https";
import { connect as tlsConnect } from "node:tls";
import type { AddressInfo, Server as TcpServer } from "node:net";

type Flow = { client: Socket; upstream: Socket };

// The flows a switch carries, and the switch itself.
class Flows {
  private readonly open = new Set<Flow>();
  up = true;

  // Pipes the two ends both ways and tracks them until either closes.
  carry(client: Socket, upstream: Socket): void {
    const flow = { client, upstream };
    this.open.add(flow);
    const drop = () => {
      this.open.delete(flow);
      client.destroy();
      upstream.destroy();
    };
    for (const end of [client, upstream]) {
      end.on("error", drop);
      end.on("close", drop);
    }
    if (!this.up) this.stall(flow);
  }

  private stall({ client, upstream }: Flow): void {
    client.unpipe(upstream);
    upstream.unpipe(client);
    client.pause();
    upstream.pause();
  }

  down(): void {
    this.up = false;
    for (const flow of this.open) this.stall(flow);
  }

  restore({ cut }: { cut: boolean }): void {
    const stalled = !this.up;
    this.up = true;
    // Flows that never stalled are piped already.
    if (!stalled && !cut) return;
    for (const flow of this.open) {
      if (cut) {
        flow.client.destroy();
        flow.upstream.destroy();
        this.open.delete(flow);
        continue;
      }
      flow.client.pipe(flow.upstream);
      flow.upstream.pipe(flow.client);
      flow.client.resume();
      flow.upstream.resume();
    }
  }
}

export type Switch = {
  down(): void;
  restore(options: { cut: boolean }): void;
  stop(): Promise<void>;
};

function listening(server: Server | TcpServer, host: string, port = 0) {
  return new Promise<number>((done, fail) => {
    server.once("error", fail);
    server.listen(port, host, () =>
      done((server.address() as AddressInfo).port),
    );
  });
}

function closing(server: Server | TcpServer): Promise<void> {
  return new Promise((done) => server.close(() => done()));
}

export class NetworkSwitch implements Switch {
  private readonly flows = new Flows();
  private readonly server: Server;
  readonly port: number;

  private constructor(server: Server, port: number) {
    this.server = server;
    this.port = port;
  }

  static async start(): Promise<NetworkSwitch> {
    const server = createServer((_request, response) => {
      // Only https and wss reach the proxy, and both tunnel.
      response.writeHead(502).end();
    });
    const self = new NetworkSwitch(
      server,
      await listening(server, "127.0.0.1"),
    );
    server.on("connect", (request, client: Socket, head) =>
      self.tunnel(request.url ?? "", client, head),
    );
    return self;
  }

  private tunnel(target: string, client: Socket, head: Buffer): void {
    if (!this.flows.up) {
      client.destroy();
      return;
    }
    const [host = "", port = "443"] = target.split(":");
    const upstream = connect(Number(port), host);
    upstream.once("connect", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      this.flows.carry(client, upstream);
      if (this.flows.up) {
        client.pipe(upstream);
        upstream.pipe(client);
      }
    });
    upstream.once("error", () => client.destroy());
  }

  down(): void {
    this.flows.down();
  }

  restore(options: { cut: boolean }): void {
    this.flows.restore(options);
  }

  async stop(): Promise<void> {
    this.restore({ cut: true });
    await closing(this.server);
  }
}

// The dev hub at http://127.0.0.1:<port>: requests are forwarded over
// https with the hub's own Host, and a websocket upgrade becomes a TLS
// connection to the hub carrying the same bytes, so the hub sees what
// the app would have sent it.
export class HubFront implements Switch {
  private readonly flows = new Flows();
  private readonly server: Server;
  readonly port: number;
  readonly url: string;

  private constructor(server: Server, port: number) {
    this.server = server;
    this.port = port;
    this.url = `http://127.0.0.1:${port}`;
  }

  static async start(hubUrl: string): Promise<HubFront> {
    const hub = new URL(hubUrl);
    const secure = hub.protocol === "https:";
    const hubPort = Number(hub.port || (secure ? 443 : 80));
    const server = createServer();
    const self = new HubFront(server, await listening(server, "127.0.0.1"));
    server.on("request", (request, response) => {
      if (!self.flows.up) {
        request.socket.destroy();
        return;
      }
      const forward = (secure ? httpsRequest : httpRequest)(
        {
          host: hub.hostname,
          port: hubPort,
          method: request.method,
          path: request.url,
          headers: { ...request.headers, host: hub.host },
          agent: false,
        },
        (answer) => {
          response.writeHead(answer.statusCode ?? 502, answer.headers);
          answer.pipe(response);
        },
      );
      forward.on("socket", (upstream) =>
        self.flows.carry(request.socket, upstream),
      );
      forward.on("error", () => request.socket.destroy());
      request.pipe(forward);
    });
    server.on("upgrade", (request: IncomingMessage, client: Socket, head) => {
      if (!self.flows.up) {
        client.destroy();
        return;
      }
      const upstream = secure
        ? tlsConnect({
            host: hub.hostname,
            port: hubPort,
            servername: hub.hostname,
          })
        : connect(hubPort, hub.hostname);
      upstream.once(secure ? "secureConnect" : "connect", () => {
        const headers = Object.entries({ ...request.headers, host: hub.host })
          .flatMap(([name, value]) =>
            (Array.isArray(value) ? value : [value ?? ""]).map(
              (each) => `${name}: ${each}`,
            ),
          )
          .join("\r\n");
        upstream.write(
          `${request.method} ${request.url} HTTP/1.1\r\n${headers}\r\n\r\n`,
        );
        if (head.length > 0) upstream.write(head);
        self.flows.carry(client, upstream);
        if (self.flows.up) {
          client.pipe(upstream);
          upstream.pipe(client);
        }
      });
      upstream.once("error", () => client.destroy());
    });
    return self;
  }

  down(): void {
    this.flows.down();
  }

  restore(options: { cut: boolean }): void {
    this.flows.restore(options);
  }

  async stop(): Promise<void> {
    this.restore({ cut: true });
    this.server.closeAllConnections();
    await closing(this.server);
  }
}

// A TCP front on every interface at a fixed port, for the peer's direct
// listener. A connection is carried on to the listener at the address
// it arrived on, so a LAN candidate still reaches the listener from a
// LAN address and the tunnel's connector from loopback, which is how
// the listener tells the two apart.
export class ListenerFront implements Switch {
  private readonly flows = new Flows();
  private readonly server: TcpServer;
  readonly port: number;

  private constructor(server: TcpServer, port: number) {
    this.server = server;
    this.port = port;
  }

  // `listenerPort` answers where the listener is now, null while it is
  // not (a connection then is refused, as the listener would).
  static async start(
    port: number,
    listenerPort: () => Promise<number | null>,
  ): Promise<ListenerFront> {
    const server = createTcpServer({ pauseOnConnect: true });
    const self = new ListenerFront(server, await listening(server, "::", port));
    server.on("connection", (client) => {
      if (!self.flows.up) {
        client.destroy();
        return;
      }
      const local = (client.localAddress ?? "127.0.0.1").replace(
        /^::ffff:/,
        "",
      );
      void listenerPort().then(
        (target) => {
          if (target === null || !self.flows.up) {
            client.destroy();
            return;
          }
          const upstream = connect(target, local);
          upstream.once("connect", () => {
            self.flows.carry(client, upstream);
            if (self.flows.up) {
              client.pipe(upstream);
              upstream.pipe(client);
              client.resume();
            }
          });
          upstream.once("error", () => client.destroy());
        },
        () => client.destroy(),
      );
    });
    return self;
  }

  down(): void {
    this.flows.down();
  }

  restore(options: { cut: boolean }): void {
    this.flows.restore(options);
  }

  async stop(): Promise<void> {
    this.restore({ cut: true });
    await closing(this.server);
  }
}

// Several switches thrown as one: the clients' whole network.
export class Network implements Switch {
  private readonly switches: Switch[] = [];

  add<T extends Switch>(each: T): T {
    this.switches.push(each);
    return each;
  }

  down(): void {
    for (const each of this.switches) each.down();
  }

  restore(options: { cut: boolean }): void {
    for (const each of this.switches) each.restore(options);
  }

  async stop(): Promise<void> {
    await Promise.all(this.switches.map((each) => each.stop()));
  }
}
