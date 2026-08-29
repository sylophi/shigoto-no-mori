// Lab boot: renderer/index.tsx minus the Electron-only concerns
// (orphan report, focus bridging), plus the memory-router handle on
// window.smLab so screenshot runs can deep-link.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ClerkProvider } from "@clerk/electron/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "sonner";
import { App } from "@/App";
import { ClerkGate } from "@/components/account/ClerkGate";
import { createAppQueryClient } from "@/lib/queryClientOptions";
import { startRemoteDeviceSync } from "@/lib/remote/remoteDeviceSync";
import { queryKeys } from "@/lib/queryKeys";
import { router } from "@/router";
import { scriptRuns } from "@/store/scriptRuns";
import "@/index.css";

scriptRuns.start();

const queryClient = createAppQueryClient();

void queryClient.prefetchQuery({
  queryKey: queryKeys.globalConfig(),
  queryFn: () => window.api.globalConfig.read(),
});

startRemoteDeviceSync(queryClient);

(window as any).smLab.navigate = (to: string) => router.navigate({ to });

// URL-posed initial route (see lab/main.tsx). Deferred a tick so the
// router mounts on "/" first, matching a real navigation.
const posedRoute = new URLSearchParams(location.search).get("to");
if (posedRoute !== null) {
  setTimeout(() => void router.navigate({ to: posedRoute }), 50);
}

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("#root element missing from lab/index.html");

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ClerkGate Provider={ClerkProvider}>
        <App />
      </ClerkGate>
      <Toaster position="bottom-right" closeButton />
    </QueryClientProvider>
  </StrictMode>,
);
