// The villager data in the lab: the villagers:* channels
// (host/lib/villagers.ts), served from lab/villager-data, a real
// download made with the app's own downloader by `pnpm villagers:fetch`
// (scripts/fetch-villager-data.mts). That folder is gitignored and
// never committed. Without it the data reads as not downloaded, and a
// posed download ends with no faces to show.
//
// ?villagers=absent|downloading|ready|failed poses the status (default:
// ready with the folder, absent without). Download, cancel and remove
// play out on it.
//
// Each device has its own visitor tally (villagers:visits, the Visitors
// section in Settings), and ?visits=none empties every one.
import type {
  VillagerDataStatus,
  VillagerProfiles,
  VisitorTally,
} from "@shared/schemas";
import { villagerManifest } from "@shared/villagers/manifest";
import type { AllChannelHandlers } from "@shared/ipc/client";
import { LOCAL_DEVICE_ID, MINI_ID, THINKPAD_ID } from "./fixtures";

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

const DAY = 24 * 60 * 60_000;
// The friendship's half-life in days, as cli/visitors.go cools it.
const HALF_LIFE_DAYS = 60;

// Who has visited each device: slug, times, and the days ago of the
// first and the last visit.
const VISITS: Record<string, [string, number, number, number][]> = {
  [LOCAL_DEVICE_ID]: [
    ["raymond", 14, 200, 1],
    ["marshal", 6, 150, 9],
    ["judy", 4, 120, 30],
    ["sherb", 3, 90, 12],
    ["ankha", 2, 80, 40],
    ["bob", 1, 2, 2],
    ["audie", 1, 60, 60],
    ["zucker", 2, 75, 5],
    ["lolly", 1, 4, 4],
    ["maple", 1, 200, 200],
    ["stitches", 3, 140, 22],
    ["sheldon", 5, 170, 3],
    ["tom-nook", 2, 180, 20],
    ["isabelle", 3, 160, 7],
    ["katrina", 1, 45, 45],
    ["pascal", 1, 6, 6],
    ["leif", 2, 100, 14],
  ],
  [THINKPAD_ID]: [
    ["raymond", 3, 110, 8],
    ["fauna", 2, 64, 21],
    ["ketchup", 1, 11, 11],
    ["molly", 1, 25, 25],
    ["kk-slider", 1, 3, 3],
    ["celeste", 1, 50, 50],
    ["daisy-mae", 2, 70, 16],
  ],
  [MINI_ID]: [
    ["ace", 1, 1, 1],
    ["dom", 2, 90, 30],
  ],
};

function visitsOf(deviceId: string): VisitorTally {
  if (new URLSearchParams(location.search).get("visits") === "none") {
    return {};
  }
  const now = Date.now();
  return Object.fromEntries(
    (VISITS[deviceId] ?? []).map(([slug, count, firstAgo, lastAgo]) => {
      const first = now - firstAgo * DAY;
      const last = now - lastAgo * DAY;
      // The visits spread evenly between the first and the last, each
      // as warm as it still is now, the way `sm visitors` reports them.
      const step = count > 1 ? (firstAgo - lastAgo) / (count - 1) : 0;
      let warmth = 0;
      for (let i = 0; i < count; i++) {
        warmth += 0.5 ** ((lastAgo + i * step) / HALF_LIFE_DAYS);
      }
      return [slug, { count, first, last, warmth }];
    }),
  );
}

// One device's villager data channels, each device with its own status.
export function villagerHandlersFor(deviceId: string): AllChannelHandlers {
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
    "villagers:face": async ({ slug }) => {
      const load = faces[`./villager-data/ready/faces/${slug}.png`];
      if (!shown() || load === undefined) return null;
      return (await load()).replace(/^data:image\/png;base64,/, "");
    },
    "villagers:profiles": async () =>
      shown() && loadProfiles !== undefined ? loadProfiles() : null,
    "villagers:visits": () => visitsOf(deviceId),
  };
}
