// Reading and reaching things in the lab window, as a person would.
import type { Locator, Page } from "playwright-core";

export const sidebar = (page: Page): Locator => page.locator("aside");
export const main = (page: Page): Locator => page.locator("main");

// The home's project card opens the project's primary checkout.
export async function openPrimary(page: Page, project: string): Promise<void> {
  await page.getByRole("button", { name: `${project}, open main` }).click();
  await main(page).getByRole("heading", { level: 1, name: "main" }).waitFor();
}

// The media a page shows, through shadow roots (the diff renderer's),
// with how many of the images and players actually loaded.
export function media(page: Page) {
  return page.evaluate(async () => {
    const found: Element[] = [];
    const walk = (node: Element | ShadowRoot) => {
      for (const child of Array.from(node.children)) {
        if (["IMG", "VIDEO", "AUDIO"].includes(child.tagName))
          found.push(child);
        if (child.shadowRoot) walk(child.shadowRoot);
        walk(child);
      }
    };
    walk(document.querySelector("main") ?? document.body);
    const loaded = await Promise.all(
      found.map(async (el) => {
        if (el instanceof HTMLImageElement) {
          if (!el.complete) {
            await new Promise((r) => {
              el.addEventListener("load", r, { once: true });
              el.addEventListener("error", r, { once: true });
            });
          }
          return el.naturalWidth > 0;
        }
        const player = el as HTMLMediaElement;
        if (player.readyState < 1) {
          await new Promise((r) => {
            player.addEventListener("loadedmetadata", r, { once: true });
            player.addEventListener("error", r, { once: true });
            setTimeout(r, 5000);
          });
        }
        return player.readyState >= 1 && player.error === null;
      }),
    );
    const count = (tag: string) =>
      found.filter((el, i) => el.tagName === tag && loaded[i]).length;
    return {
      images: count("IMG"),
      videos: count("VIDEO"),
      audios: count("AUDIO"),
      broken: loaded.filter((ok) => !ok).length,
    };
  });
}

// Text a page draws inside the diff renderer's shadow roots too.
export function deepText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const out: string[] = [];
    const walk = (node: Node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent?.trim();
        if (text) out.push(text);
        return;
      }
      if (node instanceof Element && ["STYLE", "SCRIPT"].includes(node.tagName))
        return;
      if (node instanceof Element && node.shadowRoot) walk(node.shadowRoot);
      node.childNodes.forEach(walk);
    };
    walk(document.querySelector("main") ?? document.body);
    return out.join("\n");
  });
}
