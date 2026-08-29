// Lab entry. Same rule as web/main.tsx: the bridge must own window.api
// before any renderer module evaluates (queryKeys and the remote
// registry read it at module scope), so the app boots via dynamic
// import.
import { installLabBridge } from "./bridge";
import { applyPose } from "./pose";

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

// The shared theme pose (lab/pose.ts). This entry also answers
// ?peers (lab/bridge.ts) and ?to=/devices, the memory-router route
// applied after mount.
applyPose();

installLabBridge();

void import("./boot");
