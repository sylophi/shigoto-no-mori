// Drive a running dev window from the shell, for a tester or an agent
// poking at the app by hand (the library form is cdp.mts):
//
//   node scripts/e2e/drive.mts <port> eval '<expression>'
//   node scripts/e2e/drive.mts <port> wait '<expression>' [timeoutMs]
//   node scripts/e2e/drive.mts <port> shot <file.png>
//
// <port> is the SHIGOMORI_DEBUG_PORT the window was launched with.
// eval prints the awaited result as JSON, wait polls until the
// expression is truthy. The renderer bridge is in scope, so
// `window.api.hub.status()` and friends are the things to ask.
import { writeFileSync } from "node:fs";
import { attachWindow } from "./cdp.mts";

const [portArg, command, arg, extra] = process.argv.slice(2);
const port = Number(portArg);
if (!Number.isInteger(port) || !command) {
  console.error(
    "usage: drive.mts <port> eval '<expr>' | wait '<expr>' [ms] | shot <file.png>",
  );
  process.exit(2);
}

const timeoutMs = extra === undefined ? undefined : Number(extra);
if (timeoutMs !== undefined && !Number.isFinite(timeoutMs)) {
  console.error(`timeout must be a number of milliseconds, got ${extra}`);
  process.exit(2);
}

const window = await attachWindow(port, 10_000);
try {
  switch (command) {
    case "eval": {
      console.log(JSON.stringify(await window.evaluate(arg ?? ""), null, 2));
      break;
    }
    case "wait": {
      const value = await window.waitFor(arg ?? "", arg ?? "", timeoutMs);
      console.log(JSON.stringify(value, null, 2));
      break;
    }
    case "shot": {
      if (!arg) throw new Error("shot needs an output file");
      writeFileSync(arg, await window.screenshot());
      console.log(`wrote ${arg}`);
      break;
    }
    default:
      throw new Error(`unknown command ${command}`);
  }
} finally {
  window.close();
}
