// The Worktree location page with the data folder reached through a
// link, in the packaged build: a worktree already where the layout puts
// it is not offered a move, though git spells its path through the link.
import { afterAll, beforeAll, expect, it } from "vitest";
import { withPageApi } from "../reliability/pageApi.mts";
import { seedDemo } from "./lib/demoRepo.mts";
import { bootLab, type Lab } from "./lib/labApp.mts";
import { main, openPrimary } from "./lib/page.mts";

let lab: Lab;

beforeAll(async () => {
  lab = await bootLab({ seed: seedDemo, linkedDataDir: true });
  lab.sm("create", "placed", "-p", "demo", "--no-cd", "--no-setup");
  await openPrimary(lab.page, "demo");
});
afterAll(() => lab?.close());

it("offers no move for a worktree already in place", async () => {
  const { page } = lab;
  await page.getByRole("button", { name: "More actions for demo" }).click();
  await page.getByRole("menuitem", { name: "Configure" }).click();
  await main(page).getByRole("button", { name: "Change…" }).click();
  await main(page)
    .getByRole("heading", { name: "Worktree location" })
    .waitFor();
  // The page reads "Save location" while its plan is still loading
  // too, so the plan it draws from is read first, for the layout it
  // shows (the project's default): one worktree, in place.
  const plan = await withPageApi(page, async (api) => {
    const projects = await api.run(api.projects.list());
    const projectId = projects.find((each) => each.name === "demo")?.id;
    if (projectId === undefined) throw new Error("no demo project");
    return await api.run(
      api.worktrees.relocationPlan({
        projectId,
        layout: "managed-root",
        customPath: null,
      }),
    );
  });
  expect(plan).toEqual([
    expect.objectContaining({
      destination: expect.stringMatching(/\/placed$/),
      inPlace: true,
    }),
  ]);
  await main(page).getByRole("button", { name: "Save location" }).waitFor();
  const text = await main(page).innerText();
  expect(text).not.toContain("will move");
  expect(text).not.toMatch(/Move \d+ worktree/);
});
