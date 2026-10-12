import { useApi } from "@/lib/runtime/pageApi";

// Whether this client also serves a machine of its own. The desktop
// app does: its window runs on a device that hosts projects, so the
// Settings page has a section for that device and for the launch tools
// detected on it. The web client is a hostless controller (PRODUCT.md):
// every device it shows is a peer, and it has no local section to
// offer. A constant for the page's life, off the page's api.
export function useHasLocalHost(): boolean {
  return useApi().isElectron;
}
