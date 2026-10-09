// GitHub repo the update feed serves releases from. The engine owns the
// whole update pipeline (Updater.ts): build-cli.mts injects this so
// the feed can never point at a different repo than the app came from,
// forge.config.ts publishes there, and the in-app changelog
// (shared/releases.ts) reads the same repo's releases.
//
// No imports at all, so the renderer can take it as well as plain
// `node scripts/*.mts` (cliDist.mts re-exports it for those).
export const UPDATE_FEED_OWNER = "sylophi";
export const UPDATE_FEED_NAME = "shigoto-no-mori";
export const UPDATE_FEED_REPO = `${UPDATE_FEED_OWNER}/${UPDATE_FEED_NAME}`;
