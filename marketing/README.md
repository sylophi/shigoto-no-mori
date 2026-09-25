# Marketing site

The site for shigomori.com, built with Astro into plain static HTML
(no client framework). It is a standalone pnpm project, like `hub/`.

```sh
pnpm install
pnpm dev      # local preview with reload
pnpm check    # type-check the pages, components and scripts (build runs it too)
pnpm build    # static output in dist/
```

TypeScript stays on 6.x for now: `astro check` needs its programmatic
API, which the native TypeScript 7 compiler doesn't ship yet.

It deploys as its own Vercel project with the Root Directory set to
`marketing`. `vercel.json` pins the Astro preset and holds the headers.

## Layout

- `src/pages/index.astro` is the page, composed from the pieces in
  `src/components/`. `src/layouts/Page.astro` holds the head (title,
  description and link preview), the nav and the footer.
- `src/pages/robots.txt.ts` and `src/pages/sitemap.xml.ts` build those
  two files from the site URL in `astro.config.mjs`.
- `src/site.ts` holds the links more than one place uses.
- `src/styles/global.css` is the one stylesheet.
- `src/scripts/`:
  - `theme.js` sets light or dark before first paint and runs the
    toggle. It loads as a blocking script, under a hashed name.
  - `download.ts` points the download buttons at the latest release's
    dmg.
  - `wallpaper.ts` pauses the wallpaper of bands that are off screen.
- `public/` is served as is: the icons, the wallpapers, the link
  preview image and the font license, which need fixed URLs.

`astro.config.mjs` turns off asset inlining, so every script and asset
is its own file. That keeps the page inside the strict CSP in
`vercel.json`, and lets everything under `/_astro/` cache for a year.

## Where the pieces come from

- Screenshots in `src/assets/` are the real app, posed in the UI lab
  (the app's `lab/README.md`). Desktop views were taken at 1280x800,
  the phone view at 390x844, and the sidebar row close-up at 4x. They
  were then cropped to twice their largest displayed width. Astro makes
  the smaller sizes phones get. The lab runs in a browser, so macOS
  traffic lights were drawn into the page before each window capture,
  where the real window puts them. The launch row is a crop of the
  app's `assets/readme-app.png`.
- `public/img/og.jpg` is the link preview card: the hero rendered at
  1200x630.
- Colors, the flat sticker shadows, and the five wallpapers (`leaf`,
  `apple`, `square`, `flower`, `triangle`, with their drift speeds)
  come from the app's doubutsu theme (`renderer/doubutsu.css`).
- The kanji watermarks (`src/assets/kanji/`) are Zen Maru Gothic Black
  rendered to images and used as masks, so the site doesn't ship the
  1.5 MB Japanese font file.
- Zen Maru Gothic is under the SIL OFL (`public/fonts/OFL.txt`, served
  as `/fonts/OFL.txt`), copied
  from `@fontsource/zen-maru-gothic`. The icons in
  `public/img/icons.svg` are Lucide (ISC), taken from `lucide-react`,
  the set the app uses.
