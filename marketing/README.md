# Marketing site

The site for shigomori.com, built with Astro into static HTML. Its pictures of the app are rendered directly from the app itself: views from `@shigomori/ui` drawn over the fixture world at build time, and for windows, the real app mounted over the fixture world once they come near the viewport. It is a package in the repo's pnpm workspace: install from the repo root, and run its scripts from here.

```sh
pnpm install  # from the repo root
pnpm dev      # local preview with reload
pnpm typecheck # astro check: the pages, components and scripts (build runs it too)
pnpm build    # static output in dist/
pnpm preview  # serve dist/ as it deploys
pnpm og       # render public/img/og.jpg from scripts/og.html
```

Lint and format use the repo-wide commands (`pnpm lint`, `pnpm format` at the root), and `pnpm typecheck` at the root runs this package's typecheck alongside every other package's, matching CI. The page follows the system's light or dark theme until the toggle is used ([`theme.js`](src/scripts/theme.js)). Either a browser's emulated color scheme or the toggle shows the other theme.

This package pins TypeScript 6 because `astro check` requires its programmatic API, which the native TypeScript 7 compiler lacks.

It deploys from `main` as its own Vercel project, set up as [`app/web/README.md`](../app/web/README.md) ("The Vercel projects") describes. [`vercel.json`](vercel.json) pins the Astro preset and the install command, and defines the response headers.

## Layout

- [`src/pages/index.astro`](src/pages/index.astro) is the main page, composed from the pieces in [`src/components/`](src/components/). [`src/layouts/Page.astro`](src/layouts/Page.astro) holds the head (title, description, and link preview), nav, and footer.
- [`src/pages/robots.txt.ts`](src/pages/robots.txt.ts) and [`src/pages/sitemap.xml.ts`](src/pages/sitemap.xml.ts) generate those two files from the site URL in [`astro.config.ts`](astro.config.ts).
- [`src/site.ts`](src/site.ts) holds links used in more than one place.
- [`src/styles/global.css`](src/styles/global.css) is the page's stylesheet. Its rules stop at a frame's root (`@scope`), where the app's stylesheet takes over.
- [`src/components/Frame.astro`](src/components/Frame.astro) renders an app frame (see below), and [`src/frames/scenes.tsx`](src/frames/scenes.tsx) lists what the frames draw.
- [`src/scripts/`](src/scripts/):
  - [`theme.js`](src/scripts/theme.js) sets light or dark mode before first paint and runs the toggle on the page and on the frames that follow it. It loads as a blocking script under a hashed filename.
  - [`platform.js`](src/scripts/platform.js) marks the visitor's platform before first paint (Windows or otherwise Mac), so only that platform's download buttons and notes show. It loads as a blocking script under a hashed filename, like `theme.js`.
  - [`frames.ts`](src/scripts/frames.ts) turns live frames into the real app when they come near the viewport.
  - [`download.ts`](src/scripts/download.ts) points the download links at the latest release's dmg or installer.
  - [`wallpaper.ts`](src/scripts/wallpaper.ts) pauses the wallpaper on bands that are off screen.
- [`scripts/og.html`](scripts/og.html) is the link preview card, and [`scripts/og.mts`](scripts/og.mts) renders it (see below).
- [`public/`](public/) is served as-is: the icons, wallpapers, link preview image, and font license, all of which need fixed URLs.

[`astro.config.ts`](astro.config.ts) disables asset inlining so every script and asset is emitted as its own file. That keeps the page within the strict CSP in [`vercel.json`](vercel.json), and lets everything under `/_astro/` cache for a year.

Each band is a `Band` ([`src/components/Band.astro`](src/components/Band.astro)): a `color` (`mint`, `sand`, `amber`, `sky`, `pink`, `wood`, or omitted for the page's own cream), a `wall` wallpaper (`leaf`, `apple`, `square`, `flower`, `triangle`), and a `kanji` watermark from [`src/assets/kanji/`](src/assets/kanji/). In `index.astro`, no two neighbors use the same color, and an untinted band sits between tinted ones so each reads as its own room.

## The frames

A frame draws a window or a part of the app using the app's views over the fixture world (`@shigomori/ui`'s scenes), rendered to HTML at build time through Astro's React integration. It lays out at the window's native size in the app and scales to the frame in CSS with no script, and a frame can show a cropped region of it. Its root carries the theme the same way the app's root does (theme classes, `data-palette`, `data-shell`), and `theme.js` sets the page's light or dark mode on it before paint so the toggle switches the frames too. The Looks frames each use a look of their own.

A frame with `live` upgrades to the real app on that route once the page has loaded and the frame comes near the viewport: [`frames.ts`](src/scripts/frames.ts) loads the app and the fixture world ([`app/lab/fake-host/frames.tsx`](../app/lab/fake-host/frames.tsx), running the lab's fake host in-process) in separate chunks, and mounts a window of the app into the frame's root, with all live frames sharing one client. Because its scene matches what the app shows first on that route, the frame keeps its picture as it goes live.

Only windows go live. Parts, the phone (the web app needs a client of its own), and Devices (which lives inside Settings in the app) stay as drawn at build time. Because of that, a part shows only what React renders on a server: any view that draws in a client effect, such as the terminal's panes (xterm), renders blank here and needs a static view first ([`packages/ui/README.md`](../packages/ui/README.md), "Adding a scene").

The build includes the app's stylesheet once for the build-time frames, and the app's boot reuses it from the page rather than loading its own ([`astro.config.ts`](astro.config.ts)). The app's stylesheet stops at a frame's root (`@shigomori/ui`'s `insideTheRoot`), and the page's stops there too, so neither styles the other. A frame's fonts are the page's Zen Maru Gothic, and kanji fall back to the system font just as the page's text does. File icons drawn in the live windows' file lists are copied into the build under `/material-icons/`.

The scenes have no project icons: the app draws a repo's icon as a `data:` URL, which the CSP does not allow, so the fixture world leaves them out and every project shows the app's letter tile.

## The link preview

[`public/img/og.jpg`](public/img/og.jpg) is the 1200x630 link preview card showing the app's icon and name over the tagline. Like the dmg's art ([`app/scripts/dmg-background.html`](../app/scripts/dmg-background.html)), [`scripts/og.html`](scripts/og.html) links the app's `doubutsu.css`, so the card uses the app's wallpaper, palette, and typography. `pnpm og` renders it with the system's Chrome, and the image is committed so it keeps a fixed URL. Re-run `pnpm og` after changing the card or anything it draws from: the icon, the palette, or the font.

## Where the pieces come from

- Colors, flat sticker shadows, and the five wallpapers (`leaf`, `apple`, `square`, `flower`, `triangle`, with their drift speeds) come from the app's doubutsu theme ([`packages/ui/src/styles/doubutsu.css`](../packages/ui/src/styles/doubutsu.css)).
- The kanji watermarks ([`src/assets/kanji/`](src/assets/kanji/)) are Zen Maru Gothic Black rendered to images and used as masks, so the site does not ship the 1.5 MB Japanese font file.
- Zen Maru Gothic is licensed under the SIL OFL ([`public/fonts/OFL.txt`](public/fonts/OFL.txt), served at `/fonts/OFL.txt`), copied from `@fontsource/zen-maru-gothic`. The icons in [`public/img/icons.svg`](public/img/icons.svg) are Lucide (ISC), taken from `lucide-react`, the same set the app uses.
