// A pull request's diff page on real git, in the packaged build,
// against a fake gh: the branch's changes as GitHub has them, the image
// it changes drawn on both sides.
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { seedDemo } from "./lib/demoRepo.mts";
import { fakeGitHub, type FakeGitHub } from "./lib/fakeGitHub.mts";
import { bootLab, type Lab } from "./lib/labApp.mts";
import { deepText, main, media } from "./lib/page.mts";

let lab: Lab;
let github: FakeGitHub;

beforeAll(async () => {
  lab = await bootLab({
    gh: (root) => {
      github = fakeGitHub(root);
      return github.ghScript;
    },
    seed: (dir, git) => {
      const repo = seedDemo(dir, git);
      git(repo, "stash", "push", "-q", "-u", "-m", "park");
      git(repo, "checkout", "-q", "-b", "images");
      copyFileSync(
        join(repo, "media/logo.png"),
        join(repo, "media/logo-copy.png"),
      );
      writeFileSync(
        join(repo, "media/logo.png"),
        readFileSync(join(import.meta.dirname, "fixtures/logo-before.png")),
      );
      writeFileSync(join(repo, "README.md"), "# Demo\n\nNow with images.\n");
      git(repo, "add", "-A");
      git(repo, "commit", "-q", "-m", "Images");
      github.wire(repo, git);
      github.openPullRequest(git, {
        repo,
        head: "images",
        base: "main",
        title: "Images",
      });
      // Past what GitHub has for the pull request: its diff must not show.
      writeFileSync(join(repo, "local-only.txt"), "not pushed\n");
      git(repo, "add", "-A");
      git(repo, "commit", "-q", "-m", "Not pushed");
    },
  });
  await lab.page.getByRole("button", { name: "demo, open images" }).click();
});
afterAll(() => lab?.close());

const unexpected = () =>
  existsSync(github.ghLog) ? readFileSync(github.ghLog, "utf8") : "";

it("shows the pull request on its branch's page", async () => {
  const { page } = lab;
  await main(page).getByText("Images", { exact: true }).first().waitFor();
  await expect
    .poll(() => deepText(page), { message: unexpected() })
    .toContain("Ready to merge");
});

it("draws the pull request's diff, the image on both sides", async () => {
  const { page } = lab;
  await main(page)
    .getByRole("button", { name: /^3 files changed/ })
    .click();
  await expect
    .poll(() => deepText(page), { message: unexpected() })
    .toContain("Now with images");
  const text = await deepText(page);
  expect(text).toContain("changed into");
  expect(text).not.toContain("local-only.txt");
  for (const path of ["README.md", "media/logo.png", "media/logo-copy.png"]) {
    expect(text).toContain(path);
  }
  await expect
    .poll(() => media(page), { message: unexpected() })
    .toMatchObject({ images: 3, broken: 0 });
});
