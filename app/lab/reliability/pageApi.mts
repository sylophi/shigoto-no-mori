// The page's api, reached from outside the page (the harness, the
// guide eval, a script on a debugging port). The app keeps it in a
// React context (renderer/lib/runtime/pageApi.tsx), never on window, so
// this walks React's tree down from the page's root to that context's
// provider.
import type { JSHandle, Page } from "playwright-core";
import type { RendererApi } from "../../renderer/lib/runtime/pageApi.tsx";

// Runs in the page, so it is self-contained: Playwright sends its
// source, and `${findPageApi}` is the same source for a raw
// Runtime.evaluate. Throws until the window has mounted.
export function findPageApi(): RendererApi {
  type Fiber = {
    readonly type?: { readonly displayName?: string } | null;
    readonly memoizedProps?: { readonly value?: RendererApi } | null;
    readonly child: Fiber | null;
    readonly sibling: Fiber | null;
  };
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- Playwright sends this function's source alone, so what it calls must be inside it
  const isFiber = (value: unknown): value is Fiber =>
    typeof value === "object" && value !== null && "child" in value;
  const root = document.getElementById("root");
  const key =
    root === null
      ? undefined
      : Object.keys(root).find((name) => name.startsWith("__reactContainer$"));
  const container: unknown =
    root === null || key === undefined ? null : Reflect.get(root, key);
  const stack: Fiber[] = isFiber(container) ? [container] : [];
  for (let fiber = stack.pop(); fiber !== undefined; fiber = stack.pop()) {
    const value = fiber.memoizedProps?.value;
    if (fiber.type?.displayName === "PageApi" && value !== undefined) {
      return value;
    }
    if (fiber.sibling !== null) stack.push(fiber.sibling);
    if (fiber.child !== null) stack.push(fiber.child);
  }
  throw new Error("no page api in this window yet");
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
