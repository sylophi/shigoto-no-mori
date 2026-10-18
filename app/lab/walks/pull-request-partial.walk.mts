// A pull request whose commits can't be fetched here (GitHub names a
// head no remote serves, as a network that can't reach it would leave
// it), in the packaged build against a fake gh: its diff still shows,
// from `gh pr diff`, and each image it changes says once that it isn't
// here, with a retry, rather than a blank side; once the commits can be
// reached, the retry draws them.
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
        unfetchableHead: true,
      });
    },
  });
  await lab.page.getByRole("button", { name: "demo, open images" }).click();
});
afterAll(() => lab?.close());

const unexpected = () =>
  existsSync(github.ghLog) ? readFileSync(github.ghLog, "utf8") : "";

it("shows the diff, and each image as not here with a retry", async () => {
  const { page } = lab;
  await main(page).getByText("Images", { exact: true }).first().waitFor();
  await main(page)
    .getByRole("button", { name: /^3 files changed/ })
    .click();
  await expect
    .poll(() => deepText(page), { message: unexpected() })
    .toContain("Now with images");
  await expect
    .poll(() => deepText(page), { message: unexpected() })
    .toContain("Not shown: this needs the pull request's commits");
  // Once a file: the changed image's and the copy's.
  await expect
    .poll(() => main(page).getByRole("button", { name: "Try again" }).count())
    .toBe(2);
});

it("draws the sides once Try again finds the commits", async () => {
  const { page } = lab;
  github.reachHead();
  await main(page).getByRole("button", { name: "Try again" }).first().click();
  await expect
    .poll(() => media(page), { message: unexpected() })
    .toMatchObject({ images: 3, broken: 0 });
  expect(
    await main(page).getByRole("button", { name: "Try again" }).count(),
  ).toBe(0);
});
