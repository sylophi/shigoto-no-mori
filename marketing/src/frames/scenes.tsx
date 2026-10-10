// What the page's frames draw: the app's views over the fixture world
// (@shigomori/ui's scenes, and the few compositions only the page shows),
// rendered to HTML at build time. Each live window's matches what the
// live app shows first on its route (Frame.astro's `live`).
export { WorktreePageScene as HeroScene } from "@shigomori/ui/scenes/worktreePage.tsx";
export { PhoneInboxScene as PhoneScene } from "@shigomori/ui/scenes/shell.tsx";
export { DevicesPageScene as DevicesScene } from "@shigomori/ui/scenes/devices.tsx";
export { TransplantReviewScene as TransplantScene } from "@shigomori/ui/scenes/flows.tsx";
