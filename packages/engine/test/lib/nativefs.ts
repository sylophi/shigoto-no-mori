// The filesystem helper as nativefs/ is now, built once per state of its
// sources into the temp dir, for the tests and proofs that run the
// NativeFs service. No side effects on import, so the app's proofs can
// take it without the sandbox's environment.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isolatedGitEnv } from "../../../../test/gitIsolation.ts";

const dir = join(import.meta.dirname, "..", "..", "..", "..", "nativefs");
let built: string | undefined;

export function nativefs(): string {
  if (built !== undefined) return built;
  const hash = createHash("sha256");
  for (const rel of readdirSync(dir)
    .filter(
      (file) =>
        file === "go.mod" ||
        file === "go.sum" ||
        (file.endsWith(".go") && !file.endsWith("_test.go")),
    )
    .toSorted()) {
    hash.update(`${rel}\0`);
    hash.update(readFileSync(join(dir, rel)));
  }
  const binary = join(
    tmpdir(),
    `nativefs-${hash.digest("hex").slice(0, 16)}`,
    "nativefs",
  );
  if (!existsSync(binary)) {
    mkdirSync(dirname(binary), { recursive: true });
    // Built under a name of its own and renamed in, so two files
    // building at once both end with a whole binary.
    const partial = `${binary}.${process.pid}`;
    execFileSync("go", ["build", "-buildvcs=false", "-o", partial, "."], {
      cwd: dir,
      env: { ...isolatedGitEnv(), LC_ALL: "C" },
      stdio: ["ignore", "ignore", "inherit"],
    });
    renameSync(partial, binary);
  }
  built = binary;
  return binary;
}

// The engine's run builds it before its files start, which would
// otherwise each build it at once, past a hook's time from a cold Go
// cache (vitest.config.ts globalSetup).
export function setup(): void {
  nativefs();
}
