// The doctor's checks for what a crash left running: stale locks and orphaned processes.
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { plural, pluralize } from "@shigomori/contracts/words";
import { parseProcessTable } from "../doctorParse.ts";
import { flavorNames } from "../flavor.ts";
import * as Paths from "../Paths.ts";
import { pidAlive, PS_BIRTH_ENV } from "../processes.ts";
import * as RunningScripts from "../RunningScripts.ts";
import { readTunnelPid } from "../tunnelPid.ts";
import { SCRIPT_START_TOLERANCE_MS, check } from "./documents.ts";
import type { ReadsArea } from "./reads.ts";

export const makeLeftoverChecks = ({ reads }: { readonly reads: ReadsArea }) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const paths = yield* Paths.Paths;
    const { home, flavor } = paths;
    const names = flavorNames(flavor);
    const { capture, readText } = reads;
    // The app records its cloudflared child's pid and kills a leftover one
    // at its next launch. Until then a tunnel whose app crashed keeps this
    // Mac reachable.
    const checkOrphanTunnel = Effect.gen(function* () {
      const userData = path.join(
        home,
        "Library",
        "Application Support",
        names.userDataDir,
      );
      const raw = yield* readText(path.join(userData, "cloudflared.pid"));
      if (Option.isNone(raw)) return [];
      const pid = readTunnelPid(raw.value);
      if (pid === undefined || pid < 2) return [];
      const ps = yield* capture("ps", [
        "-o",
        "ppid=,comm=",
        "-p",
        String(pid),
      ]).pipe(Effect.option);
      // Gone, which is the ordinary case.
      if (Option.isNone(ps) || ps.value.code !== 0) return [];
      const output = ps.value.stdout.trim();
      const space = output.indexOf(" ");
      const ppid = space < 0 ? output : output.slice(0, space);
      const comm = space < 0 ? "" : output.slice(space + 1);
      // Reparented to launchd is what outliving the app looks like. With
      // the app alive it is the app's child, and the app's business.
      if (!comm.toLowerCase().includes("cloudflared") || ppid.trim() !== "1") {
        return [];
      }
      return [
        check("Processes", "tunnel", "tunnel").warn(
          `a cloudflared tunnel (pid ${pid}) outlived the app that started it, so this Mac stays reachable through it`,
          `Open the app, which stops it at launch, or run \`kill ${pid}\`.`,
        ),
      ];
    });

    // The dev servers and scripts the app started outlive a crashed app
    // until its next launch stops them, holding their ports. Read from
    // the store, so a run that can't open it leaves them out.
    const checkOrphanScripts = Effect.gen(function* () {
      const recorded = yield* (yield* RunningScripts.RunningScripts).list;
      const owners = [...new Set(recorded.map(({ ownerPid }) => ownerPid))];
      const gone = new Set<number>();
      for (const owner of owners) {
        if (!(yield* pidAlive(owner))) gone.add(owner);
      }
      const scripts = recorded.filter(({ ownerPid }) => gone.has(ownerPid));
      if (scripts.length === 0) return [];
      const pids = scripts.map(({ pid }) => String(pid));
      // Non-zero when none are alive.
      const ps = yield* capture(
        "ps",
        ["-p", pids.join(","), "-o", "pid=,lstart="],
        PS_BIRTH_ENV,
      ).pipe(Effect.option);
      const live = parseProcessTable(
        Option.match(ps, { onNone: () => "", onSome: ({ stdout }) => stdout }),
      );
      const orphans = scripts.filter(({ pid, startedAt }) => {
        const started = live.get(pid);
        // A recycled pid started at another time.
        return (
          started !== undefined &&
          Math.abs(started - startedAt) <= SCRIPT_START_TOLERANCE_MS
        );
      });
      if (orphans.length === 0) return [];
      const n = orphans.length;
      return [
        check("Processes", "scripts", "scripts").warn(
          `${pluralize(n, "script")} the app started ${plural(n, "is", "are")} still running after it quit (${orphans.map(({ command }) => command).join(", ")}), holding ${plural(n, "its", "their")} ports`,
          `Open the app, which stops them at launch, or run \`kill ${orphans.map(({ pid }) => String(pid)).join(" ")}\`.`,
        ),
      ];
    });

    return { checkOrphanTunnel, checkOrphanScripts };
  });

export type LeftoverChecksArea = Effect.Success<
  ReturnType<typeof makeLeftoverChecks>
>;
