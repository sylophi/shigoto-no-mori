// What the dialog of a host that could not start says: a store the
// doctor can repair sends you to it with what it found, one a newer
// version of the app made only to an update, which the doctor's
// findings would only restate.
import type { Flavor } from "@shigomori/engine/flavor";
import { storeWords } from "@shigomori/engine/storeErrors";
import { cliBinaryName } from "@shared/packaging/cliDist.mts";
import type { HostFailure } from "./hostProcess";

export function hostFailureWords(
  failure: HostFailure,
  flavor: Flavor,
): { title: string; body: string } {
  if (failure.storeReport === null) {
    return {
      title: "Shigoto no Mori can't start",
      body: `${failure.message}\n\nQuit and relaunch the app. If it keeps happening, restart your machine or reinstall.`,
    };
  }
  const title = "Shigoto no Mori can't open its data";
  if (failure.storeReport.includes(storeWords.newer)) {
    return { title, body: failure.message };
  }
  return {
    title,
    body: `${failure.storeReport}\n\nRun \`${cliBinaryName(flavor)} doctor\` in a terminal for the repairs it offers.`,
  };
}
