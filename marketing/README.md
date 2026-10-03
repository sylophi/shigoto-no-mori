# Marketing site

The site for shigomori.com, built with Astro into plain static HTML
(no client framework). It is a standalone pnpm project, like `hub/`,
except that it draws the app with the app's own components, from
`../app` (see below), so the app's dependencies need installing too.

```sh
pnpm install
pnpm -C ../app install
pnpm dev      # local preview with reload, on the port port-pool gave this worktree
pnpm check    # type-check the pages, components and scripts (build runs it too)
pnpm build    # static output in dist/
```

TypeScript stays on 6.x for now: `astro check` needs its programmatic
API, which the native TypeScript 7 compiler doesn't ship yet.

It deploys as its own Vercel project with the Root Directory set to
`marketing`. `vercel.json` pins the Astro preset, installs the app's
dependencies beside the site's (without their install scripts: the
views need none of Electron), and holds the headers.

## Layout

- `src/pages/index.astro` is the page, composed from the pieces in
  `src/components/`. `AppFrame.astro` is a frame showing the app (see
  below). `src/layouts/Page.astro` holds the head (title,
  description and link preview), the nav and the footer.
- `src/pages/robots.txt.ts` and `src/pages/sitemap.xml.ts` build those
  two files from the site URL in `astro.config.ts`.
- `src/site.ts` holds the links more than one place uses.
- `src/styles/global.css` is the one stylesheet.
- `src/scripts/`:
  - `theme.js` sets light or dark before first paint and runs the
    toggle. It loads as a blocking script, under a hashed name.
  - `download.ts` points the download buttons at the latest release's
    dmg.
  - `wallpaper.ts` pauses the wallpaper of bands that are off screen.
  - `frames.ts` scales each app frame to fit and places the pins on
    the sidebar row.
- `public/` is served as is: the icons, the wallpapers, the link
  preview image and the font license, which need fixed URLs.

`astro.config.ts` turns off asset inlining, so every script and asset
is its own file. That keeps the page inside the strict CSP in
`vercel.json`, and lets everything under `/_astro/` cache for a year.

## The app frames

Where a page would show a screenshot, this one draws the app with the
app's own React components, rendered to HTML at build time. The page
ships none of their code. The app keeps them as views (components that
take their data as props) and composes them into scenes over its UI
lab's fixtures: four devices, their projects, worktrees and pull
requests (the app's `lab/README.md`, "Views and scenes"). The page
takes the scenes from the catalog in `../app/lab/scenes/` and gives
each to an `<AppFrame scene={...}>`, so a change to the app shows up
here on the next build.

- `AppSurface.astro` renders a scene into a shadow root declared in
  the HTML, with the app's stylesheet inside it, so the app's styles
  and the page's never meet. Two of its elements stand in for the
  app's `<html>` and `<body>` and wear the theme the app would put on
  `<html>`: light or dark, doubutsu or neutral, the desktop window or
  the phone layout.
- `plugins/shadowAppCss.ts` makes the app's stylesheet fit a shadow
  root: its document selectors move onto those two elements, its
  breakpoints ask the surface's width rather than the viewport's (a
  desktop window keeps its layout on a phone), and its faces move out
  to the page (`src/styles/app-fonts.css`), where Chrome looks for
  them.
- `AppFrame.astro` lays a scene out at the size its catalog entry
  names (a 1280x800 window, a 390x844 phone), or crops one to its
  top-left corner, and `scripts/frames.ts` zooms it to the frame's
  width. Desktop windows get their traffic lights where the real
  window draws them.
- A frame reads as a picture: one stop for a screen reader, with its
  description, and nothing inside takes a click or the keyboard.
- The pins over the sidebar row find their parts by selector (the
  `row-*` slots the app's row sets, and its accessible labels). A pin
  whose part is gone stays hidden and `frames.ts` warns in the console,
  so look there after changing the row.

`astro.config.ts` points the app's import aliases at `../app` and keeps
one React for both. The app's test `pnpm test scenes` renders every
scene in Node, so a view that starts to need the running app fails
there before it breaks this build.

## Where the pieces come from

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
