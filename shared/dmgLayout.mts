// Single source of truth for the dmg installer window: its geometry,
// and which background art a given version ships with. The artwork
// (scripts/dmg-background.html, rendered by
// scripts/build-dmg-background.cjs) and the Finder icon placement
// (forge.config.ts -> maker-dmg) both read this, so the painted tiles
// and the icons Finder drops on top can't drift apart, and the file
// names can't disagree between the renderer and the maker.
//
// Coordinates are points with the origin at the top-left of the
// window's content area -- the space the background image is painted
// in, and the space appdmg writes icon positions in.
//
// .mts with no imports, so plain `node` and forge.config.ts can both
// load it directly.

// Content size of the mounted volume's Finder window. The background
// image is rendered at exactly this size (plus an @2x twin).
export const DMG_WINDOW = { width: 700, height: 460 } as const;

// Finder's icon size inside the window. 128 keeps the app icon big
// enough to read as the hero of the panel.
export const DMG_ICON_SIZE = 128;

// The two icons sit on one baseline with the arrow between them, each
// on a painted tile.
export const DMG_ICON_Y = 260;
export const DMG_APP_ICON = { x: 196, y: DMG_ICON_Y } as const;
export const DMG_APPS_ICON = { x: 504, y: DMG_ICON_Y } as const;

// Where the rendered art lives, repo-relative.
export const DMG_ART_DIR = "assets/dmg";

// Both flavors of the art are committed, which keeps `make` free of a
// render step. appdmg finds the @2x twin itself, by name, so only the
// 1x path is ever handed to the maker.
export function dmgBackgroundName(prerelease: boolean, scale: 1 | 2): string {
  return `background${prerelease ? "-prerelease" : ""}${scale === 2 ? "@2x" : ""}.png`;
}

// A semver prerelease is anything carrying a tag (0.4.0-beta.1). Those
// ship the flavor with the app's dev-build tell -- leaf-green wordmark
// and a sticker on the card -- so a beta window never looks like the
// real thing sitting in someone's Downloads.
export function dmgBackgroundFor(version: string): string {
  return `${DMG_ART_DIR}/${dmgBackgroundName(version.includes("-"), 1)}`;
}
