// The page's api, reached from outside the page (the harness, the
// guide eval): what a dev build, the fake host or an app started with
// --sm-lab hands over as window.__smLab
// (renderer/lib/runtime/labHandle.ts).
import type { JSHandle, Page } from "playwright-core";
import type { RendererApi } from "../../renderer/lib/runtime/pageApi.tsx";

// Runs in the page, so it is self-contained: Playwright sends its
// source. Throws until the window has handed it over.
function findPageApi(): RendererApi {
  const api = window.__smLab?.api;
  if (api === undefined) throw new Error("no page api in this window yet");
  return api;
}

// The page's api as a handle, to run code in the page with:
// `(await pageApi(page)).evaluate((api) => api.hub.status())`.
export function pageApi(page: Page): Promise<JSHandle<RendererApi>> {
  return page.evaluateHandle(findPageApi);
}

// Runs `fn` in the page with its api, and hands back what it returns.
export async function withPageApi<T>(
  page: Page,
  fn: (api: RendererApi) => T | Promise<T>,
): Promise<T> {
  return await (await pageApi(page)).evaluate(fn);
}
