# ui

What the app draws, apart from the app: the views, the primitives they are built from, the stylesheets and the fixture world, so the desktop window, the web client, the marketing site and the scenes proof draw the same thing (`V3.md`, decision 8). The app keeps the containers, hooks, store and routes, and imports the rest from here. Step 6 of `V3.md` moves it in by area; until it is done, part of it is still in `app/renderer`.

- `src/views/`: the views (`app/DESIGN.md`, "Views and containers"), by area as they were under `app/renderer/components`, and the models only they read. A view takes data and callbacks and draws; its container stays in the app.
- `src/primitives/`: the building blocks every view uses (button, input, tooltip, menus, the modal shell), each carrying the `data-slot` the themes hook (`app/DESIGN.md`).
- `src/hooks/`: hooks that only measure or keep time in the page (`useIsTruncated`, `useNow`, `useShortPath`, `useRovingPick`), never fetch.
- `src/lib/`: what the drawing reads: `cn`, relative times, file icons, fuzzy matching, a device's status in words, a villager's voice, a small external store, and the types the app's hooks and store build for the views (`BrowseListing`, `ScriptRunState`, `RemoteDeviceStatus`).
- `src/outside.tsx`: how a view opens a web URL or reveals a path. The app provides both at its root, through the host; a scene gets the defaults, which do nothing.
- `src/app-icons/`: the launcher icons and Finder's.
- `src/styles/`: the stylesheets. `index.css` is Tailwind, the tokens and the base rules, and imports the doubutsu overlay (`doubutsu.css`), its palettes (`palettes.css`) and the phone layout (`phone.css`). `fonts.css` is Zen Maru Gothic, loaded beside it rather than inside, and `fonts/` the Nerd Font symbols with their license.

Consumers import a module by its path under `src/`, with its extension: `@shigomori/ui/primitives/button.tsx`, `@shigomori/ui/lib/utils.ts`. Inside the package, imports are relative with the extension.

The package declares its runtime dependencies itself, at the catalog's versions, and keeps them in its own `node_modules`. Every build of the renderer tree resolves the ones it shares with the app once, from the app (`app/vite.dedupe.ts`), so the primitives and the app share one React and one Base UI. The stylesheet names this package's sources for Tailwind; a stylesheet that imports it names its own (`app/renderer/app.css`).

`test/boundary.test.ts` holds what the sources may import: the package's own dependencies, the contracts and each other, never the app, Node, Electron or the host bridge (`pnpm run check:ui` from the root).
