// Downloads the villager data, every villager's face and profile from
// Nookipedia, with the app's own downloader (host/lib/villagers.ts)
// into a folder: by default lab/villager-data, which the UI lab serves
// (lab/villagerData.ts). The folder is gitignored: the data never
// enters the repo. Run again, it resumes a stopped download and leaves
// a finished one alone. Also the way to try the real download by hand,
// into a scratch folder.
//
// Run: pnpm villagers:fetch [folder]
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createVillagerData } from "../host/lib/villagers.ts";
import { appRoot } from "./lib/appRoot.mts";

const folder = resolve(
  process.argv[2] ?? join(appRoot, "lab", "villager-data"),
);
const data = createVillagerData({ dir: () => folder });
const began = Date.now();

let status = await data.start();
while (status.kind === "downloading") {
  process.stderr.write(`\r  ${status.done} of ${status.villagers}`);
  // oxlint-disable-next-line no-await-in-loop -- polling the download's progress
  await sleep(500);
  // oxlint-disable-next-line no-await-in-loop -- polling the download's progress
  status = await data.status();
}
process.stderr.write("\n");

const seconds = ((Date.now() - began) / 1000).toFixed(1);
if (status.kind === "ready") {
  process.stderr.write(
    `${status.villagers} villagers in ${folder}, ${seconds}s\n`,
  );
} else {
  process.stderr.write(`${JSON.stringify(status)}\n`);
  process.exitCode = 1;
}
