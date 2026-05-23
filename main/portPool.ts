// Port-pool integration detection. The user's port-pool tool keeps its
// config at <project-or-worktree-root>/port-pool.config.json. We
// activate the integration when the global toggle is on AND the file
// parses as JSON with a recognizable schemaVersion field. Richer
// validation is left to port-pool itself.
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { Context, Data, Effect, Layer } from "effect";

const execFileP = promisify(execFile);

let installedCache: { value: boolean; expires: number } | null = null;
const INSTALLED_CACHE_TTL_MS = 30_000;

export class PortPoolConfigInvalid extends Data.TaggedError(
  "PortPoolConfigInvalid",
)<{
  readonly cwd: string;
  readonly cause: unknown;
}> {
  override get message(): string {
    return `Invalid port-pool config in ${this.cwd}`;
  }
}

function isInstalledEffect() {
  return Effect.gen(function* () {
    const now = Date.now();
    if (installedCache && installedCache.expires > now) {
      return installedCache.value;
    }
    const installed = yield* Effect.tryPromise({
      try: () => execFileP("which", ["port-pool"]),
      catch: () => undefined,
    }).pipe(
      Effect.as(true),
      Effect.catchAll(() => Effect.succeed(false)),
    );
    installedCache = {
      value: installed,
      expires: now + INSTALLED_CACHE_TTL_MS,
    };
    return installed;
  });
}

function isConfiguredEffect(cwd: string) {
  return Effect.gen(function* () {
    const raw = yield* Effect.tryPromise({
      try: () => readFile(join(cwd, "port-pool.config.json"), "utf8"),
      catch: () => undefined,
    }).pipe(Effect.catchAll(() => Effect.succeed(null)));
    if (raw === null) return false;
    const parsed = yield* Effect.try({
      try: () => JSON.parse(raw) as Record<string, unknown>,
      catch: (cause) => new PortPoolConfigInvalid({ cwd, cause }),
    }).pipe(Effect.catchAll(() => Effect.succeed(null)));
    return parsed !== null && "schemaVersion" in parsed;
  });
}

export class PortPoolService extends Context.Tag("PortPoolService")<
  PortPoolService,
  {
    readonly isInstalled: () => Effect.Effect<boolean>;
    readonly isConfigured: (cwd: string) => Effect.Effect<boolean>;
    readonly isActive: (cwd: string) => Effect.Effect<boolean>;
  }
>() {}

export const PortPoolServiceLive = Layer.succeed(PortPoolService, {
  isInstalled: isInstalledEffect,
  isConfigured: isConfiguredEffect,
  isActive: (cwd) =>
    Effect.all([isInstalledEffect(), isConfiguredEffect(cwd)], {
      concurrency: "unbounded",
    }).pipe(Effect.map(([installed, configured]) => installed && configured)),
});

export const PortPool = {
  isInstalled: () =>
    Effect.flatMap(PortPoolService, (portPool) => portPool.isInstalled()),
  isConfigured: (cwd: string) =>
    Effect.flatMap(PortPoolService, (portPool) => portPool.isConfigured(cwd)),
  isActive: (cwd: string) =>
    Effect.flatMap(PortPoolService, (portPool) => portPool.isActive(cwd)),
};

export function runPortPoolProgram<A, E>(
  effect: Effect.Effect<A, E, PortPoolService>,
): Promise<A> {
  return Effect.runPromise(Effect.provide(effect, PortPoolServiceLive));
}

export async function isPortPoolInstalled(): Promise<boolean> {
  return runPortPoolProgram(PortPool.isInstalled());
}

export function clearPortPoolInstalledCache(): void {
  installedCache = null;
}

export async function isPortPoolConfigured(cwd: string): Promise<boolean> {
  return runPortPoolProgram(PortPool.isConfigured(cwd));
}

export async function isPortPoolActive(cwd: string): Promise<boolean> {
  return runPortPoolProgram(PortPool.isActive(cwd));
}
