// A client's runtime: one per window or tab, built from the flavour's
// links when the page boots and disposed when it goes, which ends every
// call, view and push still running on it.
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import type { RendererContractApi } from "@shared/ipc/client";
import * as Api from "./Api";
import type { ClientLinks } from "./ClientLinks";

export function startClient(
  links: Layer.Layer<ClientLinks>,
): Promise<RendererContractApi> {
  const runtime = ManagedRuntime.make(Api.layer.pipe(Layer.provide(links)));
  window.addEventListener("pagehide", () => {
    void runtime.dispose();
  });
  return runtime.runPromise(
    Effect.gen(function* () {
      return yield* Api.Api;
    }),
  );
}
