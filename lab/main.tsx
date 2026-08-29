// Lab entry. Same rule as web/main.tsx: the bridge must own window.api
// before any renderer module evaluates (queryKeys and the remote
// registry read it at module scope), so the app boots via dynamic
// import.
import { installLabBridge } from "./bridge";

// Diagnostics for driving the lab headlessly: every console.error/warn,
// page error and unhandled rejection lands in window.smLabLog.
const labLog: string[] = [];
(window as any).smLabLog = labLog;
const record = (kind: string, parts: unknown[]) => {
  labLog.push(
    `${kind}: ${parts.map((p) => (p instanceof Error ? p.stack : String(p))).join(" ")}`.slice(
      0,
      500,
    ),
  );
  if (labLog.length > 200) labLog.shift();
};
for (const kind of ["error", "warn"] as const) {
  const original = console[kind].bind(console);
  console[kind] = (...args: unknown[]) => {
    record(kind, args);
    original(...args);
  };
}
window.addEventListener("error", (event) =>
  record("pageerror", [event.message]),
);
window.addEventListener("unhandledrejection", (event) =>
  record("rejection", [event.reason]),
);

// URL posing for one-shot headless screenshots:
//   ?theme=light|dark        (default light)
//   ?doubutsu=0|1            (default 1, matching the product default)
//   ?peers=tp:connected,mini:offline,pc:offline
//   ?to=/devices             (memory-router route after mount)
// Theme must be seeded BEFORE index.css/providers evaluate, mirroring
// what boot-theme.js does for the persisted keys.
const pose = new URLSearchParams(location.search);
const theme = pose.get("theme") === "dark" ? "dark" : "light";
const doubutsu = pose.get("doubutsu") !== "0";
localStorage.setItem("shigomori.theme", theme);
localStorage.setItem("shigomori.doubutsu", String(doubutsu));
localStorage.setItem(
  "sm.lab.clientConfig",
  JSON.stringify({ theme, doubutsu }),
);
document.documentElement.classList.toggle("dark", theme === "dark");
document.documentElement.style.colorScheme = theme;
document.documentElement.classList.toggle("doubutsu", doubutsu);

installLabBridge();

void import("./boot");
