// `port-pool ensure` for this worktree, run ahead of every dev server
// (`pnpm start`, `web:dev`, `fake-host`, `fake-host:web`) so each one
// finds its port in .env.ports. Best-effort when port-pool isn't installed: the
// servers then fall back to their defaults (scripts/lib/portsEnvFile.mts).
//
// port-pool refuses to touch a checkout whose allocation predates a
// change to portNames in port-pool.config.json ("config shape
// changed") and leaves the release to the user. Every existing
// checkout hits that once when a port is added to the pool, so this
// does the release and provisions afresh. The fresh allocation may
// move the ports, so a dev server this checkout already has running
// keeps the old one until it restarts.
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";

// The worktree, `..` from app/ where pnpm runs the scripts, by its real
// path: port-pool keys allocations by the exact path string, so a
// checkout reached through a symlink (macOS's /tmp is /private/tmp)
// would otherwise hold one lease per spelling. The engine provisions a
// managed worktree under its stored path, which is real too.
const worktree = realpathSync("..");

function portPool(command: string, pipeStderr = false) {
  const result = spawnSync("port-pool", [command, worktree], {
    stdio: ["ignore", "inherit", pipeStderr ? "pipe" : "inherit"],
    encoding: "utf8",
  });
  if (result.error) {
    console.error(
      `[ensure-ports] skipped, port-pool did not run (${result.error.message}). ` +
        "Without it every checkout shares the default dev ports: " +
        "https://github.com/dittofleet/port-pool",
    );
    process.exit(0);
  }
  return result;
}

const first = portPool("ensure", true);
if (first.status === 0 || !first.stderr.includes("config shape changed")) {
  process.stderr.write(first.stderr);
  process.exit(first.status ?? 1);
}

console.error(
  "[ensure-ports] port-pool.config.json names other ports than this " +
    "checkout holds. Releasing them and provisioning afresh.",
);
for (const command of ["release", "ensure"]) {
  const { status } = portPool(command);
  if (status !== 0) process.exit(status ?? 1);
}
