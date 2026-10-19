// The darwin helper as macfs/ is now, built once per state of its
// sources into the temp dir, for the tests and proofs that run the
// Darwin service. No side effects on import, so the app's proofs can
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
import { isolatedGitEnv } from "../../../../gitIsolation.ts";

const dir = join(import.meta.dirname, "..", "..", "..", "..", "macfs");
let built: string | undefined;

export function macfs(): string {
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
    `macfs-${hash.digest("hex").slice(0, 16)}`,
    "macfs",
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
