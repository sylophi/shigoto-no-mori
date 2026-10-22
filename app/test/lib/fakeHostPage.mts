// The real renderer on the lab's fake host (app/lab/fake-host), in a
// browser: its vite server on a port of its own, and a page opened on it.
import { spawn } from "node:child_process";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { appRoot, freeLoopbackPort, waitFor } from "./checkKit.mts";
import { trackTest } from "./vitestKit.mts";

export async function startFakeHost(): Promise<string> {
  const port = await freeLoopbackPort();
  const server = spawn(
    join(appRoot, "node_modules/.bin/vite"),
    ["--config", "lab/fake-host/vite.config.ts", "--host", "127.0.0.1"],
    {
      cwd: appRoot,
      env: { ...process.env, FAKE_HOST_PORT: String(port) },
      stdio: "ignore",
    },
  );
  trackTest(() => {
    server.kill();
  });
  const url = `http://127.0.0.1:${port}`;
  await waitFor(
    () =>
      fetch(url).then(
        (r) => r.ok,
        () => false,
      ),
    "the fake host's vite server",
    60_000,
  );
  return url;
}

// A cold vite transforms the whole renderer on the first load, which
// takes a CI runner a minute or more, can answer 504 while it bundles
// dependencies, and reloads the page once they're bundled.
export async function openFakeHost(page: Page, url: string): Promise<void> {
  const deadline = Date.now() + 180_000;
  for (;;) {
    try {
      await page.goto(`${url}/?theme=dark`, {
        waitUntil: "commit",
        timeout: 60_000,
      });
      await page.waitForFunction(() => window.fakeHost?.navigate, null, {
        timeout: Math.max(1, Math.min(60_000, deadline - Date.now())),
      });
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
    }
  }
}
