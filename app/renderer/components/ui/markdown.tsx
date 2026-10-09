import { isWebUrl } from "@shigomori/contracts/predicates/webUrl";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { openExternalUrl } from "@/lib/openExternal";
import { cn } from "@/lib/utils";

// Remote images load lazily and without a referrer: a long changelog
// shouldn't pull every screenshot at once, and GitHub needn't learn
// which page asked. An image GitHub signed for five minutes
// (the host's withSignedImages), loads at once: lazily, one under a
// description's fold would wait past its signature. On a purifier of
// the module's own, so no other sanitize in the app picks the rule up.
const purify = DOMPurify(window);
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
  if (node.tagName === "IMG") {
    const signed = node
      .getAttribute("src")
      ?.startsWith("https://private-user-images.githubusercontent.com/");
    if (!signed) node.setAttribute("loading", "lazy");
    node.setAttribute("referrerpolicy", "no-referrer");
  }
  if (node.tagName === "INPUT") node.setAttribute("disabled", "");
});

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
  "[&_img]:my-2 [&_img]:h-auto [&_img]:max-w-full [&_img]:rounded-lg",
  "[&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground",
  "[&_hr]:my-4 [&_hr]:border-border",
  "[&_li:has(>input)]:list-none [&_li>input]:mr-1.5 [&_li>input]:align-middle",
  "[&_table]:my-2 [&_table]:block [&_table]:overflow-x-auto [&_:is(th,td)]:px-2 [&_:is(th,td)]:py-1 [&_:is(th,td):first-child]:pl-0 [&_th]:text-left [&_th]:font-semibold [&_th]:text-foreground",
);

// Sanitized HTML by source. The sources are release notes, which don't
// change and number in the tens (the full changelog renders every one
// each time it opens), and worktree and PR descriptions, where every
// edit is a new source: so a cap, the oldest going first.
const RENDERED_CAP = 100;
const rendered = new Map<string, string>();

function htmlOf(source: string): string {
  let html = rendered.get(source);
  if (html === undefined) {
    html = purify.sanitize(
      marked.parse(source, { async: false, gfm: true, breaks: true }),
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
// worktree's description or its pull request's),
// rendered the way GitHub shows it, line breaks included, and
// sanitized before it reaches the DOM. Renderer windows never
// navigate, so a click on a link opens it in the browser instead,
// through the same web-URL-only door as every other link.
export function Markdown({
  source,
  className,
}: {
  source: string;
  className?: string;
}) {
  const html = htmlOf(source);
  return (
    // oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- delegates the clicks of the links inside, which are the focusable controls (Enter on one fires this same click)
    <div
      data-slot="markdown"
      className={cn(PROSE, className)}
      onClick={(event) => {
        if (!(event.target instanceof Element)) return;
        const anchor = event.target.closest("a[href]");
        if (anchor === null) return;
        event.preventDefault();
        const href = anchor.getAttribute("href") ?? "";
        if (isWebUrl(href)) openExternalUrl(href);
      }}
      // Sanitized above: DOMPurify strips scripts, handlers and
      // non-web URLs.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
