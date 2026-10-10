// pnpm reliability [--clients web,desktop,tunnel,terminal]
//   [--scenarios a,b] [--soak <duration>] [--gap <min>-<max>] [--seed <n>]
//   [--headed] [--keep] [--deploy-local-hub]
//
// The clients' reliability scenarios against the dev hub, once each
// or looped for a soak, with a report of every recovery and failure and
// the trace each one left (README.md beside this file).
/* oxlint-disable no-await-in-loop -- the harness steps through time on purpose: each wait, poll and scenario follows the one before */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  CLIENT_KINDS,
  Lab,
  sleep,
  within,
  type ClientKind,
  type TraceLine,
} from "./lab.mts";
import {
  ALL_SCENARIOS,
  hubMatchesRelease,
  recovered,
  SOAK_SCENARIOS,
  showProject,
  silentFailures,
  terminalRoundTrip,
  type Scenario,
} from "./scenarios.mts";

const { values } = parseArgs({
  options: {
    clients: { type: "string", default: CLIENT_KINDS.join(",") },
    scenarios: { type: "string" },
    soak: { type: "string" },
    gap: { type: "string", default: "30s-3m" },
    seed: { type: "string" },
    headed: { type: "boolean", default: false },
    keep: { type: "boolean", default: false },
    "deploy-local-hub": { type: "boolean", default: false },
  },
});

function durationMs(text: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(text.trim());
  if (match === null) throw new Error(`not a duration: ${text}`);
  const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[match[2] as "ms"];
  return Number(match[1]) * unit;
}

// A small seeded generator, so a soak's order and gaps can be replayed.
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const seed = Number(values.seed ?? Math.floor(Math.random() * 2 ** 31));
const random = mulberry32(seed);
const soakMs = values.soak === undefined ? null : durationMs(values.soak);
const [gapLow = "30s", gapHigh = "3m"] = values.gap.split("-");
const gap = [durationMs(gapLow), durationMs(gapHigh)] as const;

const clients = new Set(
  values.clients.split(",").map((kind) => {
    if (!(CLIENT_KINDS as readonly string[]).includes(kind)) {
      throw new Error(`no client ${kind} (${CLIENT_KINDS.join(", ")})`);
    }
    return kind as ClientKind;
  }),
);

let chosen: readonly Scenario[] =
  values.scenarios === undefined
    ? soakMs === null
      ? ALL_SCENARIOS.filter((scenario) => !scenario.destructive)
      : SOAK_SCENARIOS
    : values.scenarios.split(",").map((name) => {
        const found = ALL_SCENARIOS.find((scenario) => scenario.name === name);
        if (found === undefined) throw new Error(`no scenario ${name}`);
        return found;
      });
chosen = [
  ...chosen.filter((scenario) => !scenario.destructive),
  ...chosen.filter((scenario) => scenario.destructive),
];
if (
  chosen.some((scenario) => scenario.name === "hub-redeploy") &&
  !values["deploy-local-hub"] &&
  !hubMatchesRelease()
) {
  console.log(
    "[reliability] skipping hub-redeploy: this checkout's hub differs from origin/release/v3 (--deploy-local-hub deploys it anyway)",
  );
  chosen = chosen.filter((scenario) => scenario.name !== "hub-redeploy");
}

const out = join(import.meta.dirname, "report");
const lab = new Lab({
  headed: values.headed,
  out,
  keep: values.keep,
  clients,
});
chosen = chosen.filter((scenario) => {
  const applies = scenario.applies?.(lab) ?? true;
  if (!applies) lab.note(`skipping ${scenario.name}: no client it applies to`);
  return applies;
});

type Outcome = {
  readonly scenario: string;
  readonly startedAt: number;
  readonly recoveryMs: number | null;
  readonly failure: string | null;
  readonly trace: TraceLine[];
};
const outcomes: Outcome[] = [];
const startedAt = Date.now();

const clock = (at: number) => new Date(at).toISOString().slice(11, 23);

function writeReport(): void {
  const byScenario = new Map<string, Outcome[]>();
  for (const outcome of outcomes) {
    byScenario.set(outcome.scenario, [
      ...(byScenario.get(outcome.scenario) ?? []),
      outcome,
    ]);
  }
  const recoveries = outcomes.filter((outcome) => outcome.failure === null);
  const longest = recoveries.reduce<Outcome | null>(
    (worst, outcome) =>
      worst === null || (outcome.recoveryMs ?? 0) > (worst.recoveryMs ?? 0)
        ? outcome
        : worst,
    null,
  );
  const lines = [
    "# Reliability report",
    "",
    `Started ${new Date(startedAt).toISOString()}, ran ${((Date.now() - startedAt) / 60_000).toFixed(1)} min, seed ${seed}.`,
    `Host ${lab.host?.label ?? "?"} (${lab.host?.deviceId ?? "?"}), clients ${[...clients].join(", ")}${clients.has("web") ? `, web client ${lab.origin}` : ""}.`,
    "",
    `${outcomes.length} scenarios, ${recoveries.length} recovered, ${outcomes.length - recoveries.length} failed.` +
      (longest === null
        ? ""
        : ` Longest recovery ${(longest.recoveryMs ?? 0) / 1000} s (${longest.scenario} at ${clock(longest.startedAt)}).`),
    "",
    "| Scenario | Runs | Recovered | Median | Longest | Bound |",
    "| --- | --- | --- | --- | --- | --- |",
    ...[...byScenario].map(([name, runs]) => {
      const times = runs
        .filter((run) => run.failure === null)
        .map((run) => run.recoveryMs ?? 0)
        .toSorted((a, b) => a - b);
      const bound = ALL_SCENARIOS.find((s) => s.name === name)?.boundMs ?? 0;
      const median = times[Math.floor(times.length / 2)];
      return `| ${name} | ${runs.length} | ${times.length} | ${median === undefined ? "-" : `${median / 1000} s`} | ${times.length === 0 ? "-" : `${(times.at(-1) ?? 0) / 1000} s`} | ${bound / 1000} s |`;
    }),
    "",
    "## Scenarios",
    "",
    ...ALL_SCENARIOS.filter((s) => byScenario.has(s.name)).map(
      (s) => `- **${s.name}**: ${s.does}`,
    ),
    "",
    "## Runs",
    "",
  ];
  for (const outcome of outcomes) {
    lines.push(
      `### ${clock(outcome.startedAt)} ${outcome.scenario}: ${outcome.failure === null ? `recovered in ${(outcome.recoveryMs ?? 0) / 1000} s` : `FAILED`}`,
      "",
    );
    if (outcome.failure !== null) lines.push(`${outcome.failure}`, "");
    lines.push("```");
    for (const line of outcome.trace) {
      lines.push(
        `${clock(line.at)} ${line.source.padEnd(7)} ${line.level.padEnd(13)} ${line.text.split("\n")[0]?.slice(0, 300)}`,
      );
    }
    lines.push("```", "");
  }
  writeFileSync(join(out, "report.md"), lines.join("\n"));
  writeFileSync(
    join(out, "report.json"),
    JSON.stringify(
      {
        seed,
        startedAt,
        endedAt: Date.now(),
        outcomes: outcomes.map(({ trace: _trace, ...rest }) => rest),
      },
      null,
      2,
    ),
  );
}

async function runOne(scenario: Scenario): Promise<void> {
  const at = Date.now();
  lab.note(`--- ${scenario.name}`);
  let recoveryMs: number | null = null;
  let failure: string | null = null;
  try {
    const ended = await scenario.run(lab, random);
    // A destructive scenario holds its own bound, and its trace says
    // how long it took.
    recoveryMs = scenario.destructive
      ? 0
      : await recovered(lab, ended, scenario.boundMs);
    if (!scenario.destructive) await terminalRoundTrip(lab);
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
  const trace = [
    ...lab.trace.filter((line) => line.at >= at),
    ...lab.devicesLogSince(at),
  ].toSorted((a, b) => a.at - b.at);
  const silent = silentFailures(trace);
  if (failure === null && silent.length > 0) failure = silent.join("; ");
  outcomes.push({
    scenario: scenario.name,
    startedAt: at,
    recoveryMs,
    failure,
    trace,
  });
  lab.note(
    failure === null
      ? `${scenario.name} recovered in ${(recoveryMs ?? 0) / 1000} s`
      : `${scenario.name} FAILED: ${failure}`,
    failure === null ? "info" : "error",
  );
  if (failure !== null) {
    for (const tab of lab.pages()) {
      await tab.page
        .screenshot({
          path: join(
            out,
            `${clock(at).replaceAll(":", "")}-${scenario.name}-${tab.name}.png`,
          ),
        })
        .catch(() => {});
    }
    await heal();
  }
  writeReport();
}

// After a failure, puts the lab back the way a scenario expects it: the
// network up, every app going and its host running, one awake tab on
// the host's project.
async function heal(): Promise<void> {
  lab.network.restore({ cut: true });
  for (const app of [lab.hostApp, lab.desk, lab.remote]) {
    app?.thaw(app.appPids());
  }
  for (const tab of lab.pages()) {
    await tab.setFrozen(false).catch(() => {});
    await tab.setOffline(false).catch(() => {});
    await tab.setHidden(false).catch(() => {});
    await tab.shiftClock(0).catch(() => {});
  }
  for (const extra of lab.tabs.slice(1)) await lab.closeTab(extra);
  const deskWindows = lab.windows.filter((each) => each.app === lab.desk);
  for (const extra of deskWindows.slice(2)) await lab.closeWindow(extra);
  if (lab.hostPid() === null) {
    await lab.stopHostApp();
    await lab.launchHost(false);
  }
  for (const page of lab.pages()) {
    await within(60_000, "the reload", page.page.reload()).catch(() => {});
  }
  await recovered(lab, Date.now(), 120_000).catch((error) =>
    lab.note(`still not healed: ${String(error)}`, "error"),
  );
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    writeReport();
    void lab.close().finally(() => process.exit(130));
  });
}

try {
  await lab.startNetwork();
  if (clients.has("web")) await lab.startWeb();
  await lab.startDevices();
  if (clients.has("web")) {
    await lab.startBrowser();
    const tab = await lab.openTab();
    await lab.ensureSignedIn(tab);
  }
  for (const page of lab.pages()) await showProject(lab, page).catch(() => {});
  lab.note("waiting for the clients to reach the host");
  await recovered(lab, Date.now(), 180_000);
  if (soakMs === null) {
    for (const scenario of chosen) await runOne(scenario);
  } else {
    const until = startedAt + soakMs;
    while (Date.now() < until) {
      const scenario = chosen[Math.floor(random() * chosen.length)];
      if (scenario === undefined) break;
      await runOne(scenario);
      const wait = Math.round(gap[0] + random() * (gap[1] - gap[0]));
      if (Date.now() + wait >= until) break;
      lab.note(`next scenario in ${Math.round(wait / 1000)} s`);
      await sleep(wait);
    }
  }
} finally {
  writeReport();
  await lab.close();
}
const failed = outcomes.filter((outcome) => outcome.failure !== null).length;
console.log(
  `[reliability] ${outcomes.length} scenarios, ${failed} failed; report at ${join(out, "report.md")}`,
);
process.exit(failed === 0 ? 0 : 1);
