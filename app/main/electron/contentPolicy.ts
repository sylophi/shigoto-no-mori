// The window's Content-Security-Policy, sent with everything the
// renderer scheme serves (main/electron/clerk.ts). The page holds the
// loopback's token, which runs scripts and terminals on this machine,
// so what may run in it is the bundle and Clerk's script alone: no
// inline script, no eval, and nothing to connect to but the loopback
// and Clerk. The web client's policy (vercel.json) is the model. A dev
// build serves through vite, whose client and React's refresh preamble
// are inline and whose updates arrive over a socket of its own.

import { GITHUB_IMAGE_HOSTS } from "@shigomori/contracts/predicates/imageHosts";

// The Clerk instance's Frontend API host, which serves its script and
// answers its calls: what a publishable key encodes, base64 after its
// pk_test_ or pk_live_ prefix and ending in "$". None for an
// unconfigured build or a key that isn't one.
export function clerkFrontendHost(publishableKey: string): string | null {
  const match = /^pk_(?:test|live)_([A-Za-z0-9+/=_-]+)$/.exec(publishableKey);
  if (match === null) return null;
  const decoded = Buffer.from(match[1] ?? "", "base64").toString("utf8");
  const host = decoded.endsWith("$") ? decoded.slice(0, -1) : "";
  return /^[a-z0-9.-]+$/i.test(host) ? host : null;
}

export function rendererContentPolicy(options: {
  readonly clerkHost: string | null;
  readonly dev: boolean;
}): string {
  const clerk =
    options.clerkHost === null ? [] : [`https://${options.clerkHost}`];
  // Clerk's bot check, on a sign-up it asks one of.
  const challenges = "https://challenges.cloudflare.com";
  const dev = (...sources: string[]) => (options.dev ? sources : []);
  const directives: Record<string, readonly string[]> = {
    "default-src": ["'self'"],
    "script-src": ["'self'", ...clerk, challenges, ...dev("'unsafe-inline'")],
    "style-src": ["'self'", "'unsafe-inline'"],
    // Clerk's avatars, and a description's images from GitHub. One on a
    // project's remote's host comes as a data: URL its device read
    // (projects:remoteImage), as in the web client, whose policy is
    // static.
    "img-src": [
      "'self'",
      "data:",
      "https://img.clerk.com",
      ...GITHUB_IMAGE_HOSTS.flatMap((host) => [
        `https://${host}`,
        `https://*.${host}`,
      ]),
      // Where github.com/user-attachments/assets/<id> redirects a reader
      // GitHub doesn't know: the policy holds redirects too.
      "https://github-production-user-asset-6210df.s3.amazonaws.com",
    ],
    // The files page's video and audio, read whole into data: URLs.
    "media-src": ["'self'", "data:"],
    "font-src": ["'self'", "data:"],
    "connect-src": [
      "'self'",
      "ws://127.0.0.1:*",
      ...clerk,
      challenges,
      ...dev("ws://localhost:*"),
    ],
    "worker-src": ["'self'", "blob:"],
    "frame-src": [challenges],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'none'"],
    "frame-ancestors": ["'none'"],
  };
  return Object.entries(directives)
    .map(([name, sources]) => `${name} ${sources.join(" ")}`)
    .join("; ");
}
