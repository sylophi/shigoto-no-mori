// The version and commit the desktop renderer and the web client bake
// in (renderer/build.d.ts).
import { execSync } from "node:child_process";

// Bounded, so a stalled remote (remoteTag's) costs the version rather
// than the build.
function gitOutput(args: string): string | null {
  try {
    return execSync(`git ${args}`, {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

function remoteTag(sha: string): string | undefined {
  return gitOutput(
    `ls-remote --tags https://github.com/${process.env.VERCEL_GIT_REPO_OWNER}/${process.env.VERCEL_GIT_REPO_SLUG}`,
  )
    ?.split("\n")
    .find((line) => line.startsWith(`${sha}\t`))
    ?.split("\t")[1]
    ?.replace(/^refs\/tags\/|\^\{\}$/g, "");
}

// Git can't read the repository in Vercel's deploy build of the web
// client, so there Vercel names the commit and the remote names its
// tag. The commit is cut to the length git abbreviates this repo's to,
// so it reads as the desktop's does.
export function buildInfoDefine(mode: string): Record<string, string> {
  const vercelSha = process.env.VERCEL_GIT_COMMIT_SHA;
  const sha = vercelSha
    ? vercelSha.slice(0, 8)
    : gitOutput("rev-parse --short HEAD");
  // The release workflow stamps the tag into package.json before
  // building, because Info.plist and app.getVersion() read the version
  // from there at packaging time. Excluding that one file keeps shipped
  // builds from reporting themselves as dirty, while genuine
  // uncommitted changes still set the flag. The "top" magic anchors the
  // exclusion to the repo root, so it holds no matter which directory
  // vite is invoked from.
  const dirty =
    (gitOutput("status --porcelain -- ':(exclude,top)app/package.json'") ??
      "") !== "";
  const commit = sha ? (dirty ? `${sha}-dirty` : sha) : "unknown";
  const tag = vercelSha
    ? remoteTag(vercelSha)
    : gitOutput("describe --tags --exact-match HEAD");
  const version = mode === "production" ? (tag ?? "unknown") : "dev";
  return {
    __APP_VERSION__: JSON.stringify(version),
    __APP_COMMIT__: JSON.stringify(commit),
  };
}
