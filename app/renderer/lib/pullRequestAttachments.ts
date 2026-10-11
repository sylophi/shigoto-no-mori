import {
  ATTACHMENT_IMAGE_EXTENSIONS,
  ATTACHMENT_VIDEO_EXTENSIONS,
  MAX_ATTACHMENT_IMAGE_BYTES,
  MAX_ATTACHMENT_VIDEO_BYTES,
} from "@shared/schemas";

// Files pasted, dropped or picked into a new pull request's description,
// and images and videos that come as links (one dragged off a web page,
// or pasted as one). Each is written into the text as a reference to
// `./<name>`, which is how gh's --attach finds where an uploaded file
// goes (the host points the reference at the staged copy). Pure, so the
// dialog and the proofs share it.

export interface Attachment {
  // The host's staging id, 16 hex characters.
  id: string;
  // The name the description refers to it by, unique in the draft. A
  // link still being fetched goes by its id until its type names it,
  // and is shown by its `label` meanwhile.
  name: string;
  label?: string;
  // What the preview shows an image as: its bytes as a data URL, or the
  // link it came from. Null for a video, which the preview names
  // rather than plays.
  previewUrl: string | null;
  status: "staging" | "staged" | "failed";
  error?: string;
}

// Why a file can't be attached, or null when it can.
export function attachmentRefusal(file: {
  name: string;
  type: string;
  size: number;
}): string | null {
  const video = isVideo(file.type);
  if (!video && !Object.hasOwn(ATTACHMENT_IMAGE_EXTENSIONS, file.type)) {
    return `Only images and videos can be attached, and ${file.name} is neither`;
  }
  if (file.size === 0) return `${file.name} is empty`;
  const max = video ? MAX_ATTACHMENT_VIDEO_BYTES : MAX_ATTACHMENT_IMAGE_BYTES;
  if (file.size > max) {
    return `${file.name} is over the ${max / 1024 / 1024} MB GitHub takes`;
  }
  return null;
}

// The types a file picker offers.
export const ATTACHMENT_ACCEPT = Object.keys({
  ...ATTACHMENT_IMAGE_EXTENSIONS,
  ...ATTACHMENT_VIDEO_EXTENSIONS,
}).join(",");

export function isVideo(type: string): boolean {
  return Object.hasOwn(ATTACHMENT_VIDEO_EXTENSIONS, type);
}

export function newAttachmentId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// A file name the host and gh take as it is: letters, digits, dots,
// dashes and underscores, starting with a letter or digit, and not
// one the draft already uses ("image.png", then "image-2.png"). The
// extension is the type's, which is what gh goes by, whatever the file
// was called.
export function attachmentName(
  file: { name: string; type: string },
  stems: ReadonlySet<string>,
): string {
  const ext =
    ATTACHMENT_IMAGE_EXTENSIONS[file.type] ??
    ATTACHMENT_VIDEO_EXTENSIONS[file.type] ??
    "";
  const stem = clean(stemOf(file.name)).slice(0, 80) || "file";
  return `${unique(stem, stems)}${ext ? `.${ext}` : ""}`;
}

// The names the draft holds, by their stems: a file's name without its
// extension, a link still being fetched by the stem it will be named
// with. A new name takes a stem none of them has, so no extension can
// make two the same.
export function attachmentStems(
  attachments: readonly Attachment[],
): Set<string> {
  return new Set(attachments.map((a) => a.label ?? stemOf(a.name)));
}

// A file's name without its extension: its stem, and what its alt text
// says.
export function stemOf(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot > 0 ? fileName.slice(0, dot) : fileName;
}

function unique(stem: string, stems: ReadonlySet<string>): string {
  let n = 1;
  const named = () => (n > 1 ? `${stem}-${n}` : stem);
  while (stems.has(named())) n += 1;
  return named();
}

function clean(part: string): string {
  return part
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .replace(/-+$/, "");
}

// The markdown that shows an attachment, on a line of its own: alone in
// its paragraph, a video becomes a player on GitHub.
export function attachmentMarkdown(name: string, alt: string): string {
  return `![${altMarkdown(alt)}](./${name})`;
}

// Alt text as it can stand between the brackets: no brackets of its
// own, and a backslash escaped, which would otherwise escape the `]`.
function altMarkdown(alt: string): string {
  return alt.replace(/[[\]]/g, "").replace(/\\/g, "\\\\");
}

// The description once a fetched link has its name: its placeholder's
// reference pointed at the file, keeping alt text written over the
// placeholder's own meanwhile.
export function withFetchedName(
  body: string,
  id: string,
  stem: string,
  name: string,
  alt: string,
): string {
  const placeholderAlt = `Uploading ${stem}…`;
  return body.replace(
    new RegExp(`!\\[([^\\]]*)\\]\\(\\./${escapeRegExp(id)}\\)`, "g"),
    (_, written: string) =>
      `![${written === placeholderAlt ? altMarkdown(alt) : written}](./${name})`,
  );
}

// `text` with `insert` put where the selection was, set apart by blank
// lines from what's around it.
export function insertBlock(
  text: string,
  start: number,
  end: number,
  insert: string,
): string {
  const before = text.slice(0, start);
  const after = text.slice(end);
  const lead =
    before === "" || before.endsWith("\n\n")
      ? ""
      : before.endsWith("\n")
        ? "\n"
        : "\n\n";
  const trail = after.startsWith("\n") ? "\n" : "\n\n";
  return `${before}${lead}${insert}${trail}${after}`;
}

export function refersTo(body: string, name: string): boolean {
  return body.includes(`](./${name})`);
}

// The description as the preview renders it: a video's reference
// named instead, since the preview doesn't play one. An image keeps its
// `./<name>`, which previewImages resolves once it's rendered, so its
// bytes never become markdown (Markdown caches what it renders, by its
// source).
export function previewSource(
  body: string,
  attachments: readonly Attachment[],
): string {
  let source = body;
  for (const { name, previewUrl } of attachments) {
    if (previewUrl !== null) continue;
    source = source.replaceAll(
      new RegExp(`!\\[[^\\]]*\\]\\(\\./${escapeRegExp(name)}\\)`, "g"),
      `*${name}*`,
    );
  }
  return source;
}

// Where the preview's images come from, by the `./<name>` they're
// referred to by.
export function previewImages(
  attachments: readonly Attachment[],
): Record<string, string> {
  return Object.fromEntries(
    attachments.flatMap(({ name, previewUrl }) =>
      previewUrl === null ? [] : [[`./${name}`, previewUrl]],
    ),
  );
}

// Drops every reference to `name` from the description: one alone on
// its line with the line, one inside a sentence on its own. The rest of
// the text stays as it was.
export function withoutReference(body: string, name: string): string {
  const ref = `!\\[[^\\]]*\\]\\(\\./${escapeRegExp(name)}\\)`;
  return body
    .replace(new RegExp(`(^|\\n)${ref}(?=\\n|$)`, "g"), "$1")
    .replace(new RegExp(` ?${ref}`, "g"), "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+/, "");
}

// The links among what was dropped or pasted that point at an image, in
// order and once each: an <img> in the HTML a page gives, else a link
// that ends like an image. An image inside the HTML (a data: URL) comes
// as one too, for the dialog to read as a file. `alone` says the HTML is
// nothing but its images, so taking them loses no text with them.
export function linkedImages(
  html: string,
  uriList: string,
): { links: { url: string; alt: string }[]; alone: boolean } {
  const links: { url: string; alt: string }[] = [];
  const add = (url: string, alt: string) => {
    if (
      /^(https?:|data:image\/)/i.test(url) &&
      !links.some((l) => l.url === url)
    ) {
      links.push({ url, alt });
    }
  };
  for (const [tag] of html.matchAll(/<img\b[^>]*>/gi)) {
    const src = attribute(tag, "src");
    if (src) add(src, attribute(tag, "alt") ?? "");
  }
  if (html === "") {
    for (const line of uriList.split(/\r?\n/)) {
      const url = line.trim();
      if (url && !url.startsWith("#") && IMAGE_PATH.test(url)) add(url, "");
    }
  }
  const text = html
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .trim();
  return { links, alone: text === "" };
}

const IMAGE_PATH = new RegExp(
  `\\.(jpeg|${[
    ...Object.values(ATTACHMENT_IMAGE_EXTENSIONS),
    ...Object.values(ATTACHMENT_VIDEO_EXTENSIONS),
  ].join("|")})(?:[?#]|$)`,
  "i",
);

function attribute(tag: string, name: string): string | null {
  const match = new RegExp(
    `\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
    "i",
  ).exec(tag);
  const value = match?.[1] ?? match?.[2] ?? match?.[3];
  return value === undefined ? null : decodeEntities(value);
}

function decodeEntities(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

// An image a page carried inside its HTML, as the file it is (its
// bytes base64 or URL-encoded, after any parameters), or null when
// they can't be read.
export function dataUrlFile(url: string): File | null {
  const match =
    /^data:(image\/[\w.+-]+)((?:;[\w-]+=[^;,]*)*)(;base64)?,(.*)$/is.exec(url);
  if (!match?.[1] || match[4] === undefined) return null;
  try {
    const bytes = match[3]
      ? Uint8Array.from(atob(match[4]), (c) => c.charCodeAt(0))
      : new TextEncoder().encode(decodeURIComponent(match[4]));
    return new File([bytes], "image", { type: match[1].toLowerCase() });
  } catch {
    return null;
  }
}

// What a linked file is called before its type is known: the last part
// of its path without the extension, unique among the draft's stems
// (attachmentStems), so whatever extension it gets can't collide.
export function linkStem(url: string, stems: ReadonlySet<string>): string {
  let last = "";
  try {
    last = decodeURIComponent(
      new URL(url).pathname.split("/").findLast(Boolean) ?? "",
    );
  } catch {
    // An unparsable link keeps the fallback.
  }
  return unique(clean(stemOf(last)).slice(0, 70) || "image", stems);
}

// Holds a linked file's place while the host fetches it, as GitHub's
// own form does while it uploads.
export function uploadingMarkdown(id: string, stem: string): string {
  return `![Uploading ${stem}…](./${id})`;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
