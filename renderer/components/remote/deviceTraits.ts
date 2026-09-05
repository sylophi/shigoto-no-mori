// What a device on the account can do and how it addresses itself,
// read off the platform it enrolled under: "web" for a browser
// (web/ipc/register.ts), an os.platform() value for the
// desktop app. A browser is a device of its own, but it hosts no
// projects and serves no peer calls, so its rows carry neither a
// project strip nor the switches that expose a machine to the others.
// One place, so a row never branches on the platform string, or on
// the shell it happens to render in, by itself.
import { WEB_PLATFORM } from "@shared/account/enroll";
import { platformLabel } from "@/lib/platformLabel";

export type DeviceTraits = {
  // How the device's own row names itself.
  selfLabel: string;
  // Registers projects, so its row shows the project strip.
  hostsProjects: boolean;
  // Can be driven by, and kept reachable to, the account's other
  // devices, so its own row carries those two switches.
  exposable: boolean;
  // What the machine runs, as one phrase: the app version on the OS.
  // "" for an unknown version (a peer only confirms one once its direct
  // session's welcome lands).
  spec: (appVersion: string) => string;
};

export function deviceTraits(platform: string): DeviceTraits {
  if (platform === WEB_PLATFORM) {
    return {
      selfLabel: "This browser",
      hostsProjects: false,
      exposable: false,
      // A browser has no OS worth naming beside its own name ("Chrome
      // on macOS" already says it), so it reads as the web client.
      spec: (appVersion) =>
        appVersion === "" ? "Web client" : `Web client ${appVersion}`,
    };
  }
  const os = platformLabel(platform);
  return {
    selfLabel: "This device",
    hostsProjects: true,
    exposable: true,
    spec: (appVersion) => (appVersion === "" ? os : `v${appVersion} on ${os}`),
  };
}
