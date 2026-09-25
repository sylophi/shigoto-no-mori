// The villager data in the lab: the villagers:* channels
// (host/lib/villagers.ts), served from lab/villager-data, a real
// download made with the app's own downloader by `pnpm villagers:fetch`
// (scripts/fetch-villager-data.mts). That folder is gitignored and
// never committed. Without it every device reads as not downloaded, and
// a posed download ends with no faces to show.
//
// ?villagers=absent|downloading|ready|failed poses every device's
// status (default: ready with the folder, absent without). Download,
// cancel and remove play out on the posed device.
import type { VillagerDataStatus, VillagerProfiles } from "@shared/schemas";
import { villagerManifest } from "@shared/villagers/manifest";

const faces = import.meta.glob<string>("./villager-data/ready/faces/*.png", {
  query: "?inline",
  import: "default",
});
const [meta] = Object.values(
  import.meta.glob<{ downloadedAt: string }>(
    "./villager-data/ready/meta.json",
    { eager: true, import: "default" },
  ),
);
const [loadProfiles] = Object.values(
  import.meta.glob<VillagerProfiles>("./villager-data/ready/profiles.json", {
    import: "default",
  }),
);

const villagers = Object.keys(villagerManifest.villagers).length;

// Whether this checkout holds a lab download.
export const labHasVillagerData = meta !== undefined;

const ABSENT: VillagerDataStatus = { kind: "absent", villagers };
const READY: Extract<VillagerDataStatus, { kind: "ready" }> = {
  kind: "ready",
  downloadedAt: meta?.downloadedAt ?? new Date().toISOString(),
  villagers,
};
// Frozen partway, for a still shot.
const POSES: Record<string, VillagerDataStatus> = {
  absent: ABSENT,
  ready: READY,
  downloading: { kind: "downloading", done: 212, villagers },
  failed: {
    kind: "failed",
    done: 212,
    villagers,
    message: "Couldn't reach Nookipedia.",
  },
};

function posedStatus(): VillagerDataStatus {
  const posed = new URLSearchParams(location.search).get("villagers");
  return (
    (posed === null ? undefined : POSES[posed]) ??
    (labHasVillagerData ? READY : ABSENT)
  );
}

// One device's villager data channels, each device with its own status.
export function villagerHandlersFor(): Record<string, (input: any) => unknown> {
  let status = posedStatus();
  let timer: ReturnType<typeof setInterval> | undefined;
  const stop = () => {
    clearInterval(timer);
    timer = undefined;
  };
  const clear = () => {
    stop();
    status = ABSENT;
    return status;
  };
  const shown = () => status.kind === "ready" && labHasVillagerData;
  return {
    "villagers:status": () => status,
    // A download that takes a few seconds, from wherever it stopped.
    "villagers:download": () => {
      if (status.kind === "ready" || timer !== undefined) return status;
      let done = status.kind === "failed" ? status.done : 0;
      status = { kind: "downloading", done, villagers };
      timer = setInterval(() => {
        done = Math.min(villagers, done + 23);
        status = { kind: "downloading", done, villagers };
        if (done === villagers) {
          stop();
          status = { ...READY, downloadedAt: new Date().toISOString() };
        }
      }, 150);
      return status;
    },
    "villagers:cancel": clear,
    "villagers:remove": clear,
    "villagers:face": async ({ slug }: { slug: string }) => {
      const load = faces[`./villager-data/ready/faces/${slug}.png`];
      if (!shown() || load === undefined) return null;
      return (await load()).replace(/^data:image\/png;base64,/, "");
    },
    "villagers:profiles": async () =>
      shown() && loadProfiles !== undefined ? loadProfiles() : null,
  };
}
