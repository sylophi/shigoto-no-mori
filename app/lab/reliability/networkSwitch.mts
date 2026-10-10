// The browser's network, as a switch the harness throws: Chrome reaches
// everything but this machine's own servers through this CONNECT proxy,
// so going down stops every byte of every flow (the hub socket, the
// tunnel link, Clerk) the way a dropped network does, which Chrome's own
// offline emulation does not do to a socket already open. Down, new
// connections are refused and open ones stall. Back up, the stalled
// flows either resume (a blip the network rode out) or are cut (a
// network that changed under them, as after a sleep).
import { connect, type Socket } from "node:net";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

type Flow = { client: Socket; upstream: Socket };

export class NetworkSwitch {
  private readonly flows = new Set<Flow>();
  private up = true;

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
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const self = new NetworkSwitch(
      server,
      (server.address() as AddressInfo).port,
    );
    server.on("connect", (request, client: Socket, head) =>
      self.tunnel(request.url ?? "", client, head),
    );
    return self;
  }

  private tunnel(target: string, client: Socket, head: Buffer): void {
    if (!this.up) {
      client.destroy();
      return;
    }
    const [host = "", port = "443"] = target.split(":");
    const upstream = connect(Number(port), host);
    const flow = { client, upstream };
    this.flows.add(flow);
    const drop = () => {
      this.flows.delete(flow);
      client.destroy();
      upstream.destroy();
    };
    upstream.on("error", drop);
    client.on("error", drop);
    upstream.on("close", drop);
    client.on("close", drop);
    upstream.on("connect", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      client.pipe(upstream);
      upstream.pipe(client);
    });
  }

  // Every byte stops, and new connections are refused.
  down(): void {
    this.up = false;
    for (const { client, upstream } of this.flows) {
      client.unpipe(upstream);
      upstream.unpipe(client);
      client.pause();
      upstream.pause();
    }
  }

  // Connections are taken again, and the stalled flows resume or, with
  // `cut`, are closed.
  restore({ cut }: { cut: boolean }): void {
    this.up = true;
    for (const flow of this.flows) {
      if (cut) {
        flow.client.destroy();
        flow.upstream.destroy();
        this.flows.delete(flow);
        continue;
      }
      flow.client.pipe(flow.upstream);
      flow.upstream.pipe(flow.client);
      flow.client.resume();
      flow.upstream.resume();
    }
  }

  async stop(): Promise<void> {
    this.restore({ cut: true });
    await new Promise<void>((done) => this.server.close(() => done()));
  }
}
