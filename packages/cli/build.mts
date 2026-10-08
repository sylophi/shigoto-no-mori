// Builds the terminal binary:
// `node build.mts [outfile] [--prod] [--version=<v>]`, the version a
// release stamps ("dev" without one).
// Bun compiles it to bytecode, which starts faster, and the binary is
// signed ad hoc, which macOS requires to run it.
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const flavor = args.includes("--prod") ? "prod" : "dev";
const stamp = args.find((arg) => arg.startsWith("--version"));
if (stamp !== undefined && !/^--version=./.test(stamp)) {
  throw new Error("Give the version as --version=<v>.");
}
const version = stamp?.slice("--version=".length) ?? "dev";
const outfile =
  args.find((arg) => !arg.startsWith("--")) ??
  `dist/${flavor === "prod" ? "sm" : "smd"}`;

execFileSync(
  "bun",
  [
    "build",
    "--compile",
    "--minify",
    "--bytecode",
    "--format=esm",
    "src/main.ts",
    "--define",
    `SM_FLAVOR="${flavor}"`,
    "--define",
    `SM_VERSION=${JSON.stringify(version)}`,
    "--outfile",
    outfile,
  ],
  { cwd: import.meta.dirname, stdio: "inherit" },
);
execFileSync("codesign", ["--force", "--sign", "-", outfile], {
  cwd: import.meta.dirname,
  stdio: "inherit",
});
