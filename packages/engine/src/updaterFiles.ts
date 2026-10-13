import type * as Path from "effect/Path";

// Where the updater's files live in a data dir, for the engine's
// Updater, the doctor and the app's shell alike.
export const updaterFiles = (
  path: Pick<Path.Path, "join">,
  dataDir: string,
) => {
  const updates = path.join(dataDir, "updates");
  const staged = path.join(updates, "staged");
  return {
    updates,
    staged,
    manifest: path.join(staged, "manifest.json"),
    stagingLock: path.join(updates, "staging.pid"),
    download: path.join(updates, "download.zip"),
    extract: path.join(updates, "extract"),
    releaseList: path.join(updates, "release-list.json"),
    installLog: path.join(updates, "install.log"),
    // What the app publishes, and what the terminal asks of it.
    status: path.join(dataDir, "updater.json"),
    request: path.join(dataDir, "updater-request.json"),
  };
};
