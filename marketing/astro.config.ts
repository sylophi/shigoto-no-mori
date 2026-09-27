import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://shigomori.com",
  devToolbar: { enabled: false },
  // Astro's default ("jsx") follows React's whitespace rules, which join
  // "like\n<code>" into "like<code>". Plain collapsing keeps the space.
  compressHTML: true,
  vite: {
    // Keep every asset and script a real file. Inlined data: URLs and
    // inline scripts would each need their own CSP exception, and files
    // cache on their own.
    build: { assetsInlineLimit: 0 },
  },
});
