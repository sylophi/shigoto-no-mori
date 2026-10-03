# Marketing site

The site for shigomori.com, built with Astro into plain static HTML
(no client framework). It is a standalone pnpm project, like `hub/`,
except that it shows the real app, which it builds from `../app` (see
below), so the app's dependencies need installing too.

```sh
pnpm install
pnpm -C ../app install
pnpm dev      # local preview with reload, on the port port-pool gave this worktree
pnpm check    # type-check the pages, components and scripts (build runs it too)
pnpm build    # static output in dist/
pnpm demo     # rebuild only the app frames (dev and build run it first)
```

TypeScript stays on 6.x for now: `astro check` needs its programmatic
API, which the native TypeScript 7 compiler doesn't ship yet.

It deploys as its own Vercel project with the Root Directory set to
`marketing`. `vercel.json` pins the Astro preset, installs the app's
dependencies beside the site's (without their install scripts: the
frames need none of Electron), and holds the headers.

## Layout

- `src/pages/index.astro` is the page, composed from the pieces in
  `src/components/`. `LiveApp.astro` is a frame showing the app (see
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
  - `live.ts` scales each app frame to fit, poses it and shows it.
- `public/` is served as is: the icons, the wallpapers, the link
  preview image and the font license, which need fixed URLs. `pnpm
  demo` builds the app frames into `public/demo/` (gitignored).

`astro.config.ts` turns off asset inlining, so every script and asset
is its own file. That keeps the page inside the strict CSP in
`vercel.json`, and lets everything under `/_astro/` cache for a year.

## The app frames

Where a page would show a screenshot, this one runs the app. The app's
UI lab (its `lab/README.md`) mounts the real renderer over a fixture
world: four devices, their projects, worktrees and pull requests.
`app/lab/demo/` is the lab's entry for this site, which `pnpm demo`
builds into `/demo/`. Each `<LiveApp>` is an iframe of it, so every
frame is its own window and can take its own pose: theme, route,
desktop or phone, by the lab's URL parameters. The frames stay out of
each other's way and the page's (storage per frame, no focus until a
visitor clicks in), and the desktop ones draw their traffic lights
where the real window has them.

A frame shows either a whole window, scaled to fit, which a visitor
with a pointer can click around in, or a region of one, which is only
shown. A region can count from an element (`anchor`), so it follows
that element when a change to the app moves it (it is measured once,
when the frame is posed). A frame's `clicks` pose it
further once it has drawn, like opening a menu. Their selectors are
CSS, or `text=` and `:has-text()`, simpler cousins of Playwright's
(`scripts/live.ts` says how they match). The pins over the sidebar row
find their parts of the live row by the `row-*` slots the app sets on
them. A pose that stops matching the app leaves its
frame unposed and warns in the console, so check the frames after
changing what they show.

Frames load as they near the screen, and hidden ones not at all. They share one build, which
the browser fetches once: about 380 KB of compressed script.

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
