// robots.txt: every crawler is welcome, and the sitemap's address comes
// from the site URL in astro.config.mjs.
import type { APIRoute } from "astro";

export const GET: APIRoute = ({ site }) =>
  new Response(
    `User-agent: *\nAllow: /\n\nSitemap: ${new URL("/sitemap.xml", site).href}\n`,
    { headers: { "Content-Type": "text/plain; charset=utf-8" } },
  );
