// Lab boot: the shared renderer boot on the fixture bridge, plus the
// memory-router handle on window.smLab so screenshot runs can
// deep-link.
import { ClerkProvider } from "@clerk/electron/react";
import { createMemoryHistory } from "@tanstack/react-router";
import { bootApp } from "@/boot";

const router = bootApp({
  ClerkProvider,
  history: createMemoryHistory({ initialEntries: ["/"] }),
});

(window as any).smLab.navigate = (to: string) => router.navigate({ to });

// URL-posed initial route (see lab/main.tsx). Deferred a tick so the
// router mounts on "/" first, matching a real navigation.
const posedRoute = new URLSearchParams(location.search).get("to");
if (posedRoute !== null) {
  setTimeout(() => void router.navigate({ to: posedRoute }), 50);
}
