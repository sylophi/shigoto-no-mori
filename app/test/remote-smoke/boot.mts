// One device of the remote smoke, as the command weblab starts for it
// (test/README.md, "The remote smoke"):
//
//   node test/remote-smoke/boot.mts a|b
//
// a seeds the fixture (fixture.mts) and starts first, as the primary
// window. b starts once a's window is up, as the peer on a's build.
// Each is `pnpm device e2e-<side>` (scripts/dev-device.mts) on the
// debugging port weblab passes in PORT.
//
// When weblab stops a device (a SIGTERM, once the last session on it
// ends), the window goes and the side's local halves are cleared, so a
// finished run leaves nothing behind on this machine. A device killed
// outright (the liveness scenarios' SIGKILL to the whole tree) leaves
// its profile for the relaunch, which boots it as it was.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { appRoot } from "../lib/checkKit.mts";
import {
  bootPidFile,
  clearSide,
  fixture,
  seedFixture,
  type Side,
} from "./fixture.mts";

const side = process.argv[2];
if (side !== "a" && side !== "b") {
  console.error("usage: node test/remote-smoke/boot.mts a|b");
  process.exit(2);
}
const me: Side = side;

if (me === "a") seedFixture();
writeFileSync(bootPidFile(me), String(process.pid));

const child = spawn(
  process.execPath,
  [
    "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
    join(appRoot, "scripts", "dev-device.mts"),
    fixture[me].name,
  ],
  { cwd: appRoot, stdio: "inherit" },
);

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stopping = true;
    child.kill(signal);
  });
}
child.on("exit", async (code) => {
  if (stopping) await clearSide(me);
  process.exit(stopping ? 0 : (code ?? 1));
});
