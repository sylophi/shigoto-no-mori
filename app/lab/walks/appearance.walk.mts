// Settings > Appearance in the packaged build: a palette or a theme
// picked shows on the window and stays until it is saved or discarded.
// Uncompiled, the palette provider handed out a new setter each render,
// and Settings dropped its previews on every one, so a pick snapped back
// at once.
import { afterAll, beforeAll, expect, it } from "vitest";
import { seedDemo } from "./lib/demoRepo.mts";
import { bootLab, type Lab } from "./lib/labApp.mts";
import { main, sidebar } from "./lib/page.mts";

let lab: Lab;

beforeAll(async () => {
  lab = await bootLab({ seed: seedDemo });
});
afterAll(() => lab?.close());

// What the window wears: its palette and whether it is dark.
const worn = () =>
  lab.page.evaluate(() => {
    const root = document.querySelector("#root");
    return {
      palette: root?.getAttribute("data-palette") ?? null,
      dark: root?.classList.contains("dark") ?? false,
    };
  });

it("keeps a staged pick on the window until Discard", async () => {
  const { page } = lab;
  await sidebar(page).getByRole("button", { name: "Settings" }).click();
  await main(page).getByRole("heading", { name: "Appearance" }).waitFor();
  const saved = await worn();

  const theme = (name: string) =>
    main(page).getByRole("radio", { name }).click();
  // Light first, whatever the machine's own appearance.
  await theme("Light");
  await main(page).getByRole("button", { name: "Sakura" }).click();
  await expect.poll(worn).toEqual({ dark: false, palette: "sakura" });
  await theme("Dark");
  await expect.poll(worn).toMatchObject({ dark: true });
  // Back to light, the palette staged before the theme is still worn.
  await theme("Light");
  await expect.poll(worn).toEqual({ dark: false, palette: "sakura" });

  await main(page).getByRole("button", { name: "Discard" }).click();
  await expect.poll(worn).toEqual(saved);
});
