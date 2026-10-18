// Devices of one account on this machine, for the cross-device walks:
// the packaged lab build several times, as profiles, each on a root of
// its own, enrolled with a hub the walk runs (labHub.mts), and linked to
// each other as a person's Macs on one network are.
import type { Page } from "playwright-core";
import { waitFor } from "../../../test/lib/checkKit.mts";
import {
  type Lab,
  type LabOptions,
  launchLab,
  refuseRunningLab,
} from "./labApp.mts";
import { startLabHub } from "./labHub.mts";

export interface Devices {
  // Another device on the account, enrolled and online with the rest,
  // named `walk-<name>` (its window's device name ends in "[walk-<name>]").
  add(name: string, seed: LabOptions["seed"]): Promise<Lab>;
  // Ends one device's app before the walk does.
  remove(lab: Lab): Promise<void>;
  close(): Promise<void>;
}

// A publishable key in Clerk's shape, so the build reads as configured.
// Its host answers nothing: the walks enroll through the page api, and
// Clerk only logs that its UI did not load.
const LAB_PUBLISHABLE_KEY = `pk_test_${Buffer.from("lab.clerk.invalid$").toString("base64")}`;

// An expression on the window's page api (`api`), its answer awaited:
// `api.run(api.hub.status())`.
const viaApi = <T,>(page: Page, expression: string): Promise<T> =>
  page.evaluate(`((api) => ${expression})(window.__smLab.api)`) as Promise<T>;

export async function startDevices(): Promise<Devices> {
  refuseRunningLab();
  const hub = await startLabHub();
  const env = {
    SM_DEVICE_HUB_URL: hub.url,
    SM_ACCOUNT_CLERK_PUBLISHABLE_KEY: LAB_PUBLISHABLE_KEY,
  };
  const running: { lab: Lab; id: string }[] = [];
  const online = (lab: Lab, id: string) =>
    waitFor(
      async () =>
        (
          await viaApi<{ onlineDeviceIds: string[] }>(
            lab.page,
            "api.run(api.hub.status())",
          )
        ).onlineDeviceIds.includes(id),
      "the other device online",
      60_000,
    );
  const add = async (name: string, seed: LabOptions["seed"]) => {
    const lab = await launchLab({ seed, profile: `walk-${name}`, env });
    try {
      // The account service reads as configured a moment after the
      // window draws; an enroll before then is refused.
      await waitFor(
        async () =>
          (
            await viaApi<{ configured: boolean }>(
              lab.page,
              "api.run(api.account.status())",
            )
          ).configured,
        "the build to read as configured",
        30_000,
      );
      await viaApi(
        lab.page,
        `api.run(api.account.enroll(${JSON.stringify(hub.login)}))`,
      );
      const id = await viaApi<string>(lab.page, "api.deviceId");
      for (const other of running) {
        await online(lab, other.id);
        await online(other.lab, id);
      }
      running.push({ lab, id });
      return lab;
    } catch (cause) {
      await lab.close();
      throw cause;
    }
  };
  const remove = async (lab: Lab) => {
    const at = running.findIndex((each) => each.lab === lab);
    if (at >= 0) running.splice(at, 1);
    await lab.close();
  };
  // Every device and the hub, whatever one of them throws on the way.
  const close = async () => {
    const closing = running.toReversed();
    running.length = 0;
    const results = [];
    for (const { lab } of closing)
      results.push(
        await lab.close().then(
          () => null,
          (error: unknown) => error,
        ),
      );
    await hub.stop();
    const failed = results.find((error) => error !== null);
    if (failed !== undefined) throw failed;
  };
  return { add, remove, close };
}
