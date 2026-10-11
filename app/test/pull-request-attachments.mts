// Durable proof for how the create pull request dialog writes attachments
// into a description (ui's lib/pullRequestAttachments.ts): the
// names the host and gh take, the reference put at the caret on a
// line of its own, the preview's stand-ins, and a removal taking its
// line with it. Run: pnpm test pull-request-attachments.
import assert from "node:assert/strict";
import {
  attachmentMarkdown,
  attachmentName,
  attachmentRefusal,
  attachmentStems,
  dataUrlFile,
  insertBlock,
  linkedImages,
  linkStem,
  newAttachmentId,
  previewImages,
  previewSource,
  refersTo,
  uploadingMarkdown,
  withFetchedName,
  withoutReference,
  type Attachment,
} from "@shigomori/ui/lib/pullRequestAttachments.ts";
import {
  AttachmentIdSchema,
  AttachmentNameSchema,
} from "@shigomori/contracts/schemas";
import * as Schema from "effect/Schema";
import { it } from "vitest";

const isAttachmentId = Schema.is(AttachmentIdSchema);
const isAttachmentName = Schema.is(AttachmentNameSchema);

const attachment = (over: Partial<Attachment>): Attachment => ({
  id: "0123456789abcdef",
  name: "image.png",
  previewUrl: "data:image/png;base64,AAAA",
  status: "staged",
  ...over,
});

const file = (type: string, size = 1) => ({ name: "f", type, size });
const png = (name: string) => ({ name, type: "image/png" });

it("names the host and gh take, unique in the draft", () => {
  const taken = new Set<string>();
  const first = attachmentName(png("image.png"), taken);
  taken.add("image");
  assert.equal(first, "image.png");
  assert.equal(attachmentName(png("image.png"), taken), "image-2.png");
  assert.equal(
    attachmentName({ name: "image.gif", type: "image/gif" }, taken),
    "image-2.gif",
    "a stem taken by any extension",
  );
  assert.equal(
    attachmentName(png("Screen Shot 2026-10-11 at 9.41.03 AM.png"), taken),
    "Screen-Shot-2026-10-11-at-9.41.03-AM.png",
  );
  assert.equal(attachmentName(png("...hidden"), taken), "file.png");
  assert.equal(
    attachmentName({ name: "ログ.mov", type: "video/quicktime" }, taken),
    "file.mov",
    "a name of nothing gh takes",
  );
  assert.equal(
    attachmentName({ name: "photo.jpe", type: "image/jpeg" }, taken),
    "photo.jpg",
    "the type's extension, which is what gh goes by",
  );
  for (const name of ["a b.png", "-x.gif", "日本.webp", "x".repeat(300)]) {
    assert.ok(isAttachmentName(attachmentName(png(name), taken)), name);
  }
  assert.ok(isAttachmentId(newAttachmentId()));
});

it("only what GitHub shows, within its limits", () => {
  assert.equal(attachmentRefusal(file("image/png")), null);
  assert.equal(attachmentRefusal(file("video/mp4", 50 << 20)), null);
  assert.match(attachmentRefusal(file("image/png", 11 << 20)) ?? "", /10 MB/);
  assert.match(
    attachmentRefusal(file("application/pdf")) ?? "",
    /Only images and videos/,
  );
  assert.match(attachmentRefusal(file("image/png", 0)) ?? "", /empty/);
});

it("a reference lands at the caret on a line of its own", () => {
  const md = attachmentMarkdown("image.png", "a [shot]");
  assert.equal(md, "![a shot](./image.png)");
  assert.equal(insertBlock("", 0, 0, md), `${md}\n\n`);
  const mid = insertBlock("Before.\nAfter.", 7, 7, md);
  assert.equal(mid, `Before.\n\n${md}\n\nAfter.`);
  // A selection is replaced.
  assert.equal(insertBlock("A\n\nX\n\nB", 3, 4, md), `A\n\n${md}\n\n\nB`);
  assert.ok(refersTo(mid, "image.png"));
  assert.ok(!refersTo(mid, "image-2.png"));
});

it("the preview shows images and names videos", () => {
  const body = "Look:\n\n![shot](./image.png)\n\n![demo](./demo.mp4)";
  const attachments = [
    attachment({}),
    attachment({ name: "demo.mp4", previewUrl: null }),
  ];
  assert.equal(
    previewSource(body, attachments),
    "Look:\n\n![shot](./image.png)\n\n*demo.mp4*",
    "an image keeps its reference, so its bytes stay out of the source",
  );
  assert.deepEqual(previewImages(attachments), {
    "./image.png": "data:image/png;base64,AAAA",
  });
});

it("a removal takes its line with it", () => {
  const body = "Before.\n\n![shot](./image.png)\n\nAfter.";
  assert.equal(withoutReference(body, "image.png"), "Before.\n\nAfter.");
  assert.equal(withoutReference(body, "image-2.png"), body);
  assert.equal(
    withoutReference("See ![x](./x.png) below.\n", "x.png"),
    "See below.\n",
    "one in a sentence goes alone, and the rest stays as it was",
  );
  assert.equal(
    withoutReference("![x](./x.png)\n\n## What changed\n", "x.png"),
    "## What changed\n",
  );
});

it("images that come as links", async () => {
  const cat = "https://example.com/pics/cat.jpg?w=200";
  // An image dragged off a page: its <img>, inside a link or not.
  assert.deepEqual(
    linkedImages(
      `<a href="/x"><img class=a alt="A &quot;cat&quot;" src='${cat}'></a>`,
      cat,
    ),
    { links: [{ url: cat, alt: 'A "cat"' }], alone: true },
  );
  // Copied text with an image in it is text to paste.
  assert.equal(linkedImages(`<p>Look <img src="${cat}"></p>`, "").alone, false);
  // A link list alone counts only where it ends like an image.
  assert.deepEqual(
    linkedImages("", `# comment\n${cat}\nhttps://example.com/page`).links,
    [{ url: cat, alt: "" }],
  );
  assert.deepEqual(
    linkedImages(
      '<img src="data:image/png;base64,AAAA"><img src="file:///etc/x.png"><img src="data:image/png;base64,AAAA">',
      "",
    ).links,
    [{ url: "data:image/png;base64,AAAA", alt: "" }],
    "an embedded image once, and nothing but the web's and embedded ones",
  );

  const taken = attachmentStems([
    attachment({ name: "cat.png" }),
    attachment({
      id: "0000000000000002",
      name: "0000000000000002",
      label: "dog",
    }),
  ]);
  assert.deepEqual([...taken], ["cat", "dog"], "a link fetching by its stem");
  assert.equal(linkStem(cat, taken), "cat-2", "unique whatever its type");
  assert.equal(linkStem("https://x.io/dog.webp", taken), "dog-2");
  assert.equal(linkStem("https://x.io/foo.bar.png", taken), "foo.bar");
  assert.equal(linkStem("https://example.com/", taken), "image");
  assert.equal(linkStem("https://example.com/a%20b.webp", taken), "a-b");
  assert.equal(
    uploadingMarkdown("0123456789abcdef", "cat"),
    "![Uploading cat…](./0123456789abcdef)",
  );
  assert.equal(
    withoutReference(
      `Before.\n\n${uploadingMarkdown("0123456789abcdef", "cat")}\n\nAfter.`,
      "0123456789abcdef",
    ),
    "Before.\n\nAfter.",
    "a link that failed takes its placeholder with it",
  );

  const id = "0123456789abcdef";
  const body = `${uploadingMarkdown(id, "cat")}\n\n![A cat, retitled](./${id})`;
  assert.equal(
    withFetchedName(body, id, "cat", "cat.png", "The cat"),
    "![The cat](./cat.png)\n\n![A cat, retitled](./cat.png)",
    "its references named, keeping alt text written meanwhile",
  );

  const svg = dataUrlFile(
    "data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22x%22%2F%3E",
  );
  assert.equal(svg?.type, "image/svg+xml");
  assert.equal(await svg?.text(), '<svg xmlns="x"/>');
  assert.equal(await dataUrlFile("data:image/png;base64,UE5H")?.text(), "PNG");
  assert.equal(dataUrlFile("data:image/png;base64,%%%"), null);
  assert.equal(dataUrlFile("data:text/plain,hi"), null);
});
