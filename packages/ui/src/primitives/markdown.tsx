import { useEffect, useLayoutEffect, useRef } from "react";
import {
  GITHUB_IMAGE_HOSTS,
  isAllowedImage,
} from "@shigomori/contracts/predicates/imageHosts";
import { isWebUrl } from "@shigomori/contracts/predicates/webUrl";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { useOutside } from "../outside.tsx";
import { cn } from "../lib/utils.ts";

// What can load something into the page, by attribute. An element of
// the first kind with a URL from elsewhere goes whole, any other loses
// the attribute. Inline styles and the old `background` attribute go
// always: their url() loads from anywhere.
const LOADERS = new Set(["IMG", "SOURCE", "VIDEO", "AUDIO", "TRACK"]);
const URL_ATTRIBUTES = ["src", "srcset", "poster"];

const urlsOf = (attribute: string, value: string) =>
  attribute === "srcset"
    ? value
        .split(",")
        .map((candidate) => candidate.trim().split(/\s+/)[0] ?? "")
        .filter((url) => url !== "")
    : [value];

// A URL with no scheme and no host of its own (`./shot.png`): it can
// only reach the page's own origin, which isn't where it means.
const isLocal = (url: string) =>
  !/^[a-z][a-z0-9+.-]*:/i.test(url) && !url.startsWith("//");

// Whether an attribute's URLs (every candidate of a srcset) all load
// from `hosts`.
const loadsFrom = (
  attribute: string,
  value: string,
  hosts: readonly string[],
) => urlsOf(attribute, value).every((url) => isAllowedImage(url, hosts));

const REMOTE_SRC = "data-remote-src";
// A local image's src, for the caller to show from its own place
// (`images`, `localImage`).
const LOCAL_SRC = "data-local-src";

// Remote images load lazily and without a referrer: a long changelog
// shouldn't pull every screenshot at once, and GitHub needn't learn
// which page asked. An image GitHub signed for a few minutes (the
// host's withSignedImages) loads at once: lazily, one under a
// description's fold would wait past its signature. Any signature is in
// the query, so an image with one loads at once, a badge's too. On a
// purifier of the module's own, so no other sanitize in the app picks
// the rule up.
// A server (a scene rendered in Node or at build time) has no DOM to
// sanitize with, and draws the source as text instead (Markdown).
const purify = DOMPurify(typeof window === "undefined" ? undefined : window);
if (purify.isSupported) {
  // The one input a description has is a task list's checkbox (`- [x]`),
  // which shows its state and is never a control. Any other goes.
  purify.addHook("uponSanitizeElement", (node, data) => {
    if (
      data.tagName === "input" &&
      (node as Element).getAttribute("type") !== "checkbox"
    ) {
      node.parentNode?.removeChild(node);
    }
  });
  purify.addHook("afterSanitizeAttributes", (node) => {
    node.removeAttribute("style");
    // The app's own classes would let a description lay itself out over
    // the window.
    node.removeAttribute("class");
    node.removeAttribute("background");
    // An image on another https host is not loaded from it: its src
    // waits under REMOTE_SRC for the caller's `remoteImage`, and a local
    // one's under LOCAL_SRC.
    const src = node.getAttribute("src");
    if (
      node.tagName === "IMG" &&
      src !== null &&
      !loadsFrom("src", src, GITHUB_IMAGE_HOSTS) &&
      URL.parse(src)?.protocol === "https:"
    ) {
      node.setAttribute(REMOTE_SRC, src);
      node.removeAttribute("src");
      node.removeAttribute("srcset");
    }
    if (node.tagName === "IMG" && src !== null && isLocal(src)) {
      node.setAttribute(LOCAL_SRC, src);
      node.removeAttribute("src");
      node.removeAttribute("srcset");
    }
    for (const attribute of URL_ATTRIBUTES) {
      const value = node.getAttribute(attribute);
      if (value === null) continue;
      if (loadsFrom(attribute, value, GITHUB_IMAGE_HOSTS)) continue;
      if (LOADERS.has(node.tagName)) {
        node.parentNode?.removeChild(node);
        return;
      }
      node.removeAttribute(attribute);
    }
    if (node.tagName === "IMG") {
      const signed = node.getAttribute("src")?.includes("?");
      if (!signed) node.setAttribute("loading", "lazy");
      node.setAttribute("referrerpolicy", "no-referrer");
    }
    if (node.tagName === "INPUT") node.setAttribute("disabled", "");
  });
}

// Written in v1's vocabulary like any component: tokens only, so the
// doubutsu overlay and the palettes carry over.
const PROSE = cn(
  "text-xs leading-relaxed break-words select-text",
  "[&>:first-child]:mt-0 [&>:last-child]:mb-0",
  "[&_p]:my-2",
  "[&_:is(h1,h2,h3,h4)]:mt-4 [&_:is(h1,h2,h3,h4)]:mb-1.5 [&_:is(h1,h2,h3,h4)]:font-semibold [&_:is(h1,h2,h3,h4)]:text-foreground",
  "[&_h1]:text-sm [&_h2]:text-sm [&_:is(h3,h4)]:text-xs",
  "[&_strong]:font-semibold [&_strong]:text-foreground",
  "[&_a]:underline [&_a]:underline-offset-2 [&_a:hover]:text-foreground",
  "[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-0.5",
  "[&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-2xs",
  "[&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0",
  "[&_img]:my-2 [&_img]:h-auto [&_img]:max-w-full",
  "[&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground",
  "[&_hr]:my-4 [&_hr]:border-border",
  "[&_li:has(>input)]:list-none [&_li>input]:mr-1.5 [&_li>input]:align-middle",
  "[&_table]:my-2 [&_table]:block [&_table]:overflow-x-auto [&_:is(th,td)]:px-2 [&_:is(th,td)]:py-1 [&_:is(th,td):first-child]:pl-0 [&_th]:text-left [&_th]:font-semibold [&_th]:text-foreground",
);

// Sanitized HTML by source, one cache per way of breaking lines. The
// sources are release notes, which don't change and number in the tens
// (the full changelog renders every one each time it opens), and
// worktree and PR descriptions and files, where every edit is a new
// source: so a cap, the oldest going first.
const RENDERED_CAP = 100;
const withBreaks = new Map<string, string>();
const withoutBreaks = new Map<string, string>();

function htmlOf(source: string, breaks: boolean): string {
  const rendered = breaks ? withBreaks : withoutBreaks;
  let html = rendered.get(source);
  if (html === undefined) {
    html = purify.sanitize(
      marked.parse(source, { async: false, gfm: true, breaks }),
      { FORBID_TAGS: ["style", "form", "button"] },
    );
    rendered.set(source, html);
    if (rendered.size > RENDERED_CAP) {
      rendered.delete(rendered.keys().next().value ?? "");
    }
  }
  return html;
}

// GitHub-flavored markdown from outside the app (release notes, a
// worktree's description or its pull request's, a file in a worktree),
// rendered the way GitHub shows it, and sanitized before it reaches
// the DOM. Renderer windows never navigate, so a click on a link opens
// it in the browser instead, through the same web-URL-only door as
// every other link.
export function Markdown({
  source,
  remoteImage,
  className,
  images,
  localImage,
  breaks = true,
}: {
  source: string;
  // An image on a host other than GitHub's, as a data: URL its
  // project's device read (projects:remoteImage), which refuses any host
  // but its remotes'. Without one, such an image stays blank.
  remoteImage?: (url: string) => Promise<string>;
  className?: string;
  // Each line break a line break, as GitHub shows a comment. A file
  // is shown without, so prose wrapped in the source reflows.
  breaks?: boolean;
  // Images the source refers to by a local name (`./shot.png`), and
  // where each is shown from, set on the rendered <img> rather than
  // written into the source, which would cache the bytes with it.
  images?: Readonly<Record<string, string>>;
  // Any other local image, as a data: URL read from where the source
  // lives (a file's worktree). Without one, such an image stays blank.
  localImage?: (src: string) => Promise<string>;
}) {
  const { openUrl } = useOutside();
  const html = purify.isSupported ? htmlOf(source, breaks) : "";
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!images) return;
    for (const img of ref.current?.querySelectorAll<HTMLImageElement>(
      `img[${LOCAL_SRC}]`,
    ) ?? []) {
      const resolved = images[img.getAttribute(LOCAL_SRC) ?? ""];
      if (resolved !== undefined) img.src = resolved;
    }
  }, [html, images]);
  // Each asked for as it nears the view, as lazily as a remote image
  // loads (a long README shouldn't pull every screenshot at once), but a
  // signed one at once, as a direct image loads: one under a fold would
  // wait past its signature.
  useEffect(() => {
    let current = true;
    const load = (img: Element) => {
      const remote = img.getAttribute(REMOTE_SRC);
      return (
        remote !== null
          ? remoteImage?.(remote)
          : localImage?.(img.getAttribute(LOCAL_SRC) ?? "")
      )?.then(
        (src) => {
          if (current && img instanceof HTMLImageElement) img.src = src;
        },
        // Refused or unreadable: the image stays blank, not the one
        // the same markup showed for another file.
        () => {
          if (current) img.removeAttribute("src");
        },
      );
    };
    const nearing = new IntersectionObserver(
      (entries) => {
        for (const { target, isIntersecting } of entries) {
          if (!isIntersecting) continue;
          nearing.unobserve(target);
          void load(target);
        }
      },
      { rootMargin: "400px" },
    );
    if (remoteImage) {
      for (const img of ref.current?.querySelectorAll(`img[${REMOTE_SRC}]`) ??
        []) {
        if (img.getAttribute(REMOTE_SRC)?.includes("?")) void load(img);
        else nearing.observe(img);
      }
    }
    if (localImage) {
      for (const img of ref.current?.querySelectorAll(`img[${LOCAL_SRC}]`) ??
        []) {
        nearing.observe(img);
      }
    }
    return () => {
      current = false;
      nearing.disconnect();
    };
  }, [html, remoteImage, localImage]);
  if (!purify.isSupported) {
    return (
      <div
        data-slot="markdown"
        className={cn(PROSE, "whitespace-pre-wrap", className)}
      >
        {source}
      </div>
    );
  }
  return (
    // oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- delegates the clicks of the links inside, which are the focusable controls (Enter on one fires this same click)
    <div
      ref={ref}
      data-slot="markdown"
      className={cn(PROSE, className)}
      onClick={(event) => {
        if (!(event.target instanceof Element)) return;
        const anchor = event.target.closest("a[href]");
        if (anchor === null) return;
        event.preventDefault();
        const href = anchor.getAttribute("href") ?? "";
        if (isWebUrl(href)) openUrl(href);
      }}
      // Sanitized above: DOMPurify strips scripts, handlers and
      // non-web URLs, and the hooks images from hosts it doesn't know.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
