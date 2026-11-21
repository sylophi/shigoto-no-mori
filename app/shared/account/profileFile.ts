// The profile (profile.ts) in a file only its owner reads: the
// desktop's and the headless host's.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type ProfileStore, profileStore } from "./profile";

export const profileFile = (path: string): ProfileStore =>
  profileStore({
    readRaw: () => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    },
    // Whole or not at all.
    writeRaw: (text) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(`${path}.tmp`, text, { mode: 0o600 });
      renameSync(`${path}.tmp`, path);
    },
  });
