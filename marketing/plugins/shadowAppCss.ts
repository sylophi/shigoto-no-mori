// The app's stylesheet, made to work inside the shadow root each app
// surface on the page renders into (components/AppSurface.astro).
//
// The app styles a whole document: its theme tokens and resets sit on
// :root, html and body. In a surface those are two elements of the
// surface's own, so every such selector moves onto them: :root and
// html onto the outer one (.app-html, which wears the theme classes the
// app puts on <html>) and body onto the inner one (.app-body). The
// app's @font-face rules are dropped here, since Chrome ignores them
// inside a shadow root. The page declares the same faces itself
// (styles/app-fonts.css).
import postcss, { rule as cssRule, type Root } from "postcss";
import type { Plugin } from "vite";

// The stylesheet this applies to.
const APP_CSS = "/src/styles/app.css";

// A document-level selector as a whole token: not inside a class or
// attribute name, so `.dark-html` or `[data-html]` stay as they are.
const DOCUMENT = /(?<![\w-])(:root|html|body)(?![\w-])/g;

export function scopeAppCss(root: Root): void {
  root.walkAtRules("font-face", (rule) => {
    rule.remove();
  });
  root.walkRules((rule) => {
    rule.selector = rule.selector.replace(DOCUMENT, (token) =>
      token === "body" ? ".app-body" : ".app-html",
    );
  });
  // The page hides a surface until this sheet has loaded (a stylesheet
  // in a shadow root doesn't hold up the first paint), and this shows
  // it: an important rule from inside the shadow root outranks the
  // page's own.
  root.append(
    cssRule({ selector: ":host" }).append({
      prop: "visibility",
      value: "visible",
      important: true,
    }),
  );
}

export function shadowAppCss(): Plugin {
  return {
    name: "shadow-app-css",
    // No enforce: after Vite's CSS compile (Tailwind, @import inlining)
    // has made the stylesheet whole, and before its post step wraps it
    // into a module.
    async transform(code, id) {
      const [path, query = ""] = id.split("?");
      // The ?url import is only the module naming the built sheet's URL.
      // The sheet itself comes through on its own (?transform-only in a
      // build, plain in dev).
      if (!path?.endsWith(APP_CSS) || /(^|&)url\b/.test(query)) return null;
      const result = await postcss([
        { postcssPlugin: "scope-app-css", Once: scopeAppCss },
      ]).process(code, { from: undefined });
      return { code: result.css, map: null };
    },
  };
}
