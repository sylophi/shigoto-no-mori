// ?windows=sm poses this window's own machine as a Windows PC
// (bridge.ts), so the window runs on Windows too: its keys and its file
// manager are Windows', and its sidebar is on the right (main.tsx).
// Imported ahead of the app, whose modules read the platform as they
// load.
export const posedOnWindows = (
  new URLSearchParams(location.search).get("windows") ?? ""
)
  .split(",")
  .includes("sm");
if (posedOnWindows) {
  Object.defineProperty(navigator, "platform", { value: "Win32" });
}
