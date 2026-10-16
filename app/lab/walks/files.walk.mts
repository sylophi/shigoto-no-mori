// The files viewer on real files, in the packaged build: the tree, an
// image, a video, a tone, markdown and a long text file.
import { afterAll, beforeAll, expect, it } from "vitest";
import { seedDemo } from "./lib/demoRepo.mts";
import { bootLab, type Lab } from "./lib/labApp.mts";
import { deepText, main, media, openPrimary, sidebar } from "./lib/page.mts";

let lab: Lab;

beforeAll(async () => {
  lab = await bootLab({ seed: seedDemo });
  await openPrimary(lab.page, "demo");
  await lab.page.getByRole("button", { name: "Files", exact: true }).click();
  await main(lab.page).getByRole("heading", { name: "Files" }).waitFor();
});
afterAll(() => lab?.close());

const open = async (...path: string[]) => {
  for (const name of path) {
    await sidebar(lab.page).getByText(name, { exact: true }).click();
  }
};

it("lists the worktree's files", async () => {
  for (const name of [
    "media",
    "src",
    "package.json",
    "README.md",
    "new-file.txt",
  ]) {
    await sidebar(lab.page).getByText(name, { exact: true }).waitFor();
  }
});

it("shows an image, a video and a tone", async () => {
  await open("media", "logo.png");
  await expect
    .poll(() => media(lab.page))
    .toMatchObject({ images: 1, broken: 0 });
  await open("clip.mp4");
  await expect
    .poll(() => media(lab.page))
    .toMatchObject({ videos: 1, broken: 0 });
  await open("tone.mp3");
  await expect
    .poll(() => media(lab.page))
    .toMatchObject({ audios: 1, broken: 0 });
});

it("shows markdown and text", async () => {
  await open("README.md");
  await expect
    .poll(() => deepText(lab.page))
    .toContain("A repo for the walks.");
  await open("src", "long.txt");
  await expect.poll(() => deepText(lab.page)).toContain("line 1");
});
