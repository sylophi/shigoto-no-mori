# Marketing site

The static site for shigomori.com: HTML, CSS and three small scripts,
with no build step. Preview it with any static server from this
folder, for example `python3 -m http.server`.

It deploys as its own Vercel project with the Root Directory set to
`marketing`. `vercel.json` holds its headers.

- `theme.js` sets light or dark before first paint and runs the
  toggle.
- `download.js` points the download buttons at the latest release's
  dmg.
- `wallpaper.js` pauses the wallpaper of bands that are off screen.

Where the pieces come from:

- Screenshots in `img/` are the real app, posed in the UI lab
  (`lab/README.md`). Desktop views were taken at 1280x800, the phone
  view at 390x844, and the sidebar row close-up at 4x. They were then
  cropped, sized to twice their largest displayed width and converted
  to webp. The lab runs in a browser, so macOS traffic lights were
  drawn into the page before each window capture, where the real
  window puts them. The launch row is a crop of `assets/readme-app.png`.
- `img/og.jpg` is the link preview card: the hero rendered at 1200x630.
- Colors, the flat sticker shadows, and the five wallpapers
  (`leaf`, `apple`, `square`, `flower`, `triangle`, with their drift
  speeds) come from the doubutsu theme (`renderer/doubutsu.css`).
- The kanji watermarks (`kanji-*.webp`) are Zen Maru Gothic Black
  rendered to images and used as masks, so the page doesn't ship the
  1.5 MB Japanese font file.
- Zen Maru Gothic is under the SIL OFL (`fonts/OFL.txt`), copied from
  `@fontsource/zen-maru-gothic`. The icons in `img/icons.svg` are
  Lucide (ISC), taken from `lucide-react`, the set the app uses.
