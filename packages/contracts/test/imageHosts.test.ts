// Where an image in markdown may load from (src/predicates/imageHosts.ts):
// GitHub's hosts and a registered remote's, each with its subdomains,
// over https, and nowhere else.
import assert from "node:assert/strict";
import { it } from "vitest";
import {
  GITHUB_IMAGE_HOSTS,
  isAllowedImage,
  remoteHost,
} from "../src/predicates/imageHosts.ts";

const known = [...GITHUB_IMAGE_HOSTS, "git.uni.example"];

it("names the host of an https, ssh or scp-like remote", () => {
  assert.equal(
    remoteHost("https://git.uni.example/lab/repo.git"),
    "git.uni.example",
  );
  assert.equal(
    remoteHost("git@git.uni.example:lab/repo.git"),
    "git.uni.example",
  );
  assert.equal(
    remoteHost("ssh://git@Git.Uni.Example:2222/lab/repo"),
    "git.uni.example",
  );
  assert.equal(remoteHost("/Users/me/repo"), null);
});

it("lets an image load from GitHub or a registered remote's host, and refuses any other", () => {
  for (const src of [
    "https://github.com/user-attachments/assets/1",
    "https://private-user-images.githubusercontent.com/1/a.png",
    "https://git.uni.example/storage/user/1/files/a.png",
    "https://media.git.uni.example/user/1/files/a.png",
    "data:image/png;base64,AAAA",
  ]) {
    assert.equal(isAllowedImage(src, known), true, src);
  }
  for (const src of [
    "https://tracker.example/pixel.gif",
    "https://evilgithub.com/a.png",
    "https://github.com.evil.example/a.png",
    "http://git.uni.example/a.png",
    "//tracker.example/pixel.gif",
    "pixel.gif",
  ]) {
    assert.equal(isAllowedImage(src, known), false, src);
  }
  assert.equal(
    isAllowedImage("https://git.uni.example/a.png", GITHUB_IMAGE_HOSTS),
    false,
    "an unregistered enterprise host",
  );
});
