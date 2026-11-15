// ?windows=sm poses this window's own machine as a Windows PC
// (bridge.ts), so the window runs on Windows too: its keys and its file
// manager are Windows'. Imported ahead of the app, whose modules read
// the platform as they load.
const posed = new URLSearchParams(location.search).get("windows") ?? "";
if (posed.split(",").includes("sm")) {
  Object.defineProperty(navigator, "platform", { value: "Win32" });
}
