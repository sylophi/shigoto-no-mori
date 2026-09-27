// Lab boot: the shared renderer boot on the fixture bridge, plus the
// memory-router handle on window.smLab so screenshot runs can
// deep-link.
import { ClerkProvider } from "@clerk/electron/react";
import { createMemoryHistory } from "@tanstack/react-router";
import { bootApp } from "@/boot";
import { poseToday } from "@/hooks/ui/useToday";

// ?today=MM-DD (or YYYY-MM-DD): the calendar day the lab poses, for a
// villager's birthday without touching the clock.
const today = new URLSearchParams(location.search)
  .get("today")
  ?.match(/^(?:(\d{4})-)?(\d{2})-(\d{2})$/);
if (today) {
  const year = today[1] ? Number(today[1]) : new Date().getFullYear();
  poseToday(new Date(year, Number(today[2]) - 1, Number(today[3]), 12));
}

const router = bootApp({
  ClerkProvider,
  history: createMemoryHistory({ initialEntries: ["/"] }),
});

if (window.smLab === undefined) {
  throw new Error("[lab] boot.tsx ran before the bridge was installed");
}
window.smLab.navigate = (to: string) => router.navigate({ to });

// URL-posed initial route (see lab/main.tsx). Deferred a tick so the
// router mounts on "/" first, matching a real navigation.
const posedRoute = new URLSearchParams(location.search).get("to");
if (posedRoute !== null) {
  setTimeout(() => void router.navigate({ to: posedRoute }), 50);
}
