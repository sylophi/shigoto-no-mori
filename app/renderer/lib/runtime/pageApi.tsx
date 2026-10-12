// The page's api: the shell's facts about the window (its build, its
// account service, whether a machine of its own stands behind it), the
// device id, and the client's Api service (Api.ts). Each entry builds
// it (renderer/index.tsx, web/preload.ts, the lab's fake host) and hands
// it to the boot, which puts it in this context for React and passes it
// to what it starts outside React. Nothing reads it off a global.
import { createContext, type ReactNode, use } from "react";
import type { ElectronBridge } from "../../../main/preload";
import type { ClientApi } from "./Api";

export type RendererApi = Omit<
  ElectronBridge,
  "requestShellPort" | "route" | "isLab"
> & {
  readonly deviceId: string;
} & ClientApi;

const ApiContext = createContext<RendererApi | null>(null);

export function ApiProvider({
  api,
  children,
}: {
  api: RendererApi;
  children?: ReactNode;
}) {
  return <ApiContext value={api}>{children}</ApiContext>;
}

export function useApi(): RendererApi {
  const api = use(ApiContext);
  if (api === null) throw new Error("useApi outside the page's ApiProvider");
  return api;
}
