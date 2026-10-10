// What the page's frames draw: @shigomori/ui's scenes, the app's own
// views over the fixture world, rendered to HTML at build time. A live
// frame's scene is what the app shows first on its route
// (Frame.astro's `live`), so the swap to the live window keeps the
// picture.
export { WorktreePageScene as HeroScene } from "@shigomori/ui/scenes/worktreePage.tsx";
export { PhoneInboxScene as PhoneScene } from "@shigomori/ui/scenes/shell.tsx";
export { NewWorktreeScene as CreateScene } from "@shigomori/ui/scenes/newCheckouts.tsx";
export { PullRequestPartsScene as StackScene } from "@shigomori/ui/scenes/pullRequests.tsx";
export { DevicesPageScene as DevicesScene } from "@shigomori/ui/scenes/devices.tsx";
export { TransplantReviewScene as TransplantScene } from "@shigomori/ui/scenes/flows.tsx";
