// A PostCSS plugin for every build that loads fonts.css. Fontsource
// lists a .woff fallback after every .woff2, and every browser the
// stylesheet targets takes the woff2, so the fallbacks (about 10 MB
// across Zen Maru Gothic's subsets) would ship unused.
export function woff2Only() {
  return {
    postcssPlugin: "shigomori-woff2-only",
    Declaration: {
      src(decl: { value: string }) {
        decl.value = decl.value
          .split(/,\s*(?=url\()/)
          .filter((source) => !/format\(["']woff["']\)/.test(source))
          .join(", ");
      },
    },
  };
}
woff2Only.postcss = true as const;
