// Builds the terminal binary:
// `node build.mts [outfile] [--flavor=prod|dev|<test word>] [--version=<v>] [--arch=<x64|arm64>]`,
// dev without a flavor, the version a release stamps ("dev" without
// one), and for this machine's arch without one.
// Bun compiles it to bytecode, which starts faster, and on macOS the
// binary is signed ad hoc, which macOS requires to run it.
import { execFileSync } from "node:child_process";
import { flavorNames, isFlavor } from "@shigomori/engine/flavor";

const args = process.argv.slice(2);
const flavor =
  args.find((arg) => arg.startsWith("--flavor="))?.slice("--flavor=".length) ??
  "dev";
if (!isFlavor(flavor)) throw new Error(`No flavor is called "${flavor}".`);
const stamp = args.find((arg) => arg.startsWith("--version"));
if (stamp !== undefined && !/^--version=./.test(stamp)) {
  throw new Error("Give the version as --version=<v>.");
}
const version = stamp?.slice("--version=".length) ?? "dev";
const arch = args
  .find((arg) => arg.startsWith("--arch="))
  ?.slice("--arch=".length);
const bunOs = process.platform === "win32" ? "windows" : process.platform;
const outfile =
  args.find((arg) => !arg.startsWith("--")) ??
  `dist/${flavorNames(flavor).binaryName}`;

execFileSync(
  "bun",
  [
    "build",
    "--compile",
    "--minify",
    "--bytecode",
    "--format=esm",
    "src/main.ts",
    ...(arch === undefined ? [] : [`--target=bun-${bunOs}-${arch}`]),
    "--define",
    `SM_FLAVOR="${flavor}"`,
    "--define",
    `SM_VERSION=${JSON.stringify(version)}`,
    "--outfile",
    outfile,
  ],
  { cwd: import.meta.dirname, stdio: "inherit" },
);
if (process.platform === "darwin") {
  execFileSync("codesign", ["--force", "--sign", "-", outfile], {
    cwd: import.meta.dirname,
    stdio: "inherit",
  });
}
