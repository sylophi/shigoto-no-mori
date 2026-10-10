// A client's runtime: one per window or tab, built from the flavour's
// links when the page boots and disposed when it goes, which ends every
// call, view and push still running on it.
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Api from "./Api";
import type { ClientLinks } from "./ClientLinks";

export type Client = {
  readonly api: Api.ClientApi;
  readonly dispose: () => Promise<void>;
};

const runtimeOf = (links: Layer.Layer<ClientLinks>) =>
  ManagedRuntime.make(Api.layer.pipe(Layer.provide(links)));

const api = Effect.gen(function* () {
  return yield* Api.Api;
});

export async function startClient(
  links: Layer.Layer<ClientLinks>,
): Promise<Client> {
  const runtime = runtimeOf(links);
  return {
    api: await runtime.runPromise(api),
    dispose: () => runtime.dispose(),
  };
}

// For links built without waiting: the web client's tab, which serves
// itself, and the lab's fixtures.
export function startClientNow(links: Layer.Layer<ClientLinks>): Client {
  const runtime = runtimeOf(links);
  return { api: runtime.runSync(api), dispose: () => runtime.dispose() };
}

// The page going ends its client. One the browser keeps to come back
// to (the back-forward cache) is left as it is.
export function disposeWithPage(client: Pick<Client, "dispose">): void {
  window.addEventListener("pagehide", (event) => {
    if (!event.persisted) void client.dispose();
  });
}
