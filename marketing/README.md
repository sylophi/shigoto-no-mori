# Marketing site

The site for shigomori.com, built with Astro into static HTML. Its
pictures of the app are the app's own: the views from `@shigomori/ui`,
drawn over the fixture world at build time, and for the windows, the
real app over the fixture world once they come near the screen. It is a
package of the repo's pnpm workspace, like `hub/`: install from the
repo root, run its scripts from here.

```sh
pnpm install  # from the repo root
pnpm dev      # local preview with reload
pnpm check    # type-check the pages, components and scripts (build runs it too)
pnpm build    # static output in dist/
pnpm og       # shoot public/img/og.jpg from dist/ (after a build)
```

TypeScript stays on 6.x for now: `astro check` needs its programmatic
API, which the native TypeScript 7 compiler doesn't ship yet.

It deploys as its own Vercel project with the Root Directory set to
`marketing`, and the install uses the workspace's lockfile at the
repo root. `vercel.json` pins the Astro preset and holds the headers.
The production build follows `main`.

## Layout

- `src/pages/index.astro` is the page, composed from the pieces in
  `src/components/`. `src/layouts/Page.astro` holds the head (title,
  description and link preview), the nav and the footer.
- `src/pages/robots.txt.ts` and `src/pages/sitemap.xml.ts` build those
  two files from the site URL in `astro.config.ts`.
- `src/site.ts` holds the links more than one place uses.
- `src/styles/global.css` is the page's stylesheet. Its rules stop at a
  frame's root (`@scope`), where the app's takes over.
- `src/components/Frame.astro` is a frame of the app (below), and
  `src/frames/scenes.tsx` lists what the frames draw.
- `src/scripts/`:
  - `theme.js` sets light or dark before first paint and runs the
    toggle, on the page and on the frames that follow it. It loads as
    a blocking script, under a hashed name.
  - `frames.ts` turns the live frames into the app near the screen.
  - `download.ts` points the download buttons at the latest release's
    dmg.
  - `wallpaper.ts` pauses the wallpaper of bands that are off screen.
- `scripts/og.mts` shoots the link preview image (below).
- `public/` is served as is: the icons, the wallpapers, the link
  preview image and the font license, which need fixed URLs.

`astro.config.ts` turns off asset inlining, so every script and asset
is its own file. That keeps the page inside the strict CSP in
`vercel.json`, and lets everything under `/_astro/` cache for a year.

## The frames

A frame draws a window or a part of the app with the app's views over
the fixture world (`@shigomori/ui`'s scenes), rendered to HTML at build
time through Astro's React integration. It lays out at the size the
window has in the app and is scaled to the frame in CSS, with no
script; a frame can show a crop of it. Its root carries the theme the
way the app's root does (the theme classes, `data-palette`,
`data-shell`), and `theme.js` sets the page's light or dark on it before
it paints, so the toggle switches the frames too. The Looks frames wear
a look of their own.

A frame with `live` becomes the real app on that route once the page
has loaded and the frame comes near the screen: `frames.ts` loads the
app and the fixture world (`app/lab/fake-host/frames.tsx`, the lab's
fake host in-process) in chunks of their own, and mounts a window of
the app into the frame's root, all the live frames on one client. Its
scene is what the app shows first on that route, so the frame keeps
its picture as it goes live. Only windows go live; parts, the phone
(the web app needs a client of its own) and Devices (Settings holds it
in the app) stay as drawn at build time.

The build takes the app's stylesheet once, for the frames drawn at
build time, and the app's boot takes it from the page rather than
loading its own (`astro.config.ts`). The app's stylesheet stops at a
frame's root (`@shigomori/ui`'s `insideTheRoot`), and the page's stops
there too, so neither styles the other. A frame's fonts are the page's
Zen Maru Gothic; kanji fall back to the system's, as the page's text
does. The file icons the live windows' file lists draw are copied into
the build under `/material-icons/`.

The scenes have no project icons: the app draws a repo's icon as a
`data:` URL, which the CSP doesn't allow, so the fixture world has none
and every project wears the app's letter tile.

## The link preview

`public/img/og.jpg` is the hero as a link preview shows it, 1200 by
630: the headline over the hero window's first hundred pixels, as the
build draws it. `pnpm og` shoots it from the built site with the
system's Chrome through playwright-core, as the scene comparison does.

The Link preview workflow (`.github/workflows/og.yml`) builds the site
and shoots it whenever the site, the views or the lockfile change on
`main`, and opens a pull request when the image changed. It is shot in
CI and committed rather than at deploy because Vercel's build has no
browser to shoot with, and a committed image keeps the fixed URL with
its own caching, reviewed like any other change. A runner draws text a
little differently from a Mac, so the first run after a Mac shot opens
one pull request of its own. Opening the pull request needs the
repository to let Actions create them; without that, the run's summary
links the pushed branch.

## Where the pieces come from

- Colors, the flat sticker shadows, and the five wallpapers (`leaf`,
  `apple`, `square`, `flower`, `triangle`, with their drift speeds)
  come from the app's doubutsu theme
  (`packages/ui/src/styles/doubutsu.css`).
- The kanji watermarks (`src/assets/kanji/`) are Zen Maru Gothic Black
  rendered to images and used as masks, so the site doesn't ship the
  1.5 MB Japanese font file.
- Zen Maru Gothic is under the SIL OFL (`public/fonts/OFL.txt`, served
  as `/fonts/OFL.txt`), copied
  from `@fontsource/zen-maru-gothic`. The icons in
  `public/img/icons.svg` are Lucide (ISC), taken from `lucide-react`,
  the set the app uses.
