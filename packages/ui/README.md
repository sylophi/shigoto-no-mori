# ui

What the app draws, apart from the app: the views, the primitives they are built from, the stylesheets and the fixture world, so the desktop window, the web client, the marketing site and the scenes proof draw the same thing (`V3.md`, decision 8). The app keeps the containers, hooks, store and routes, and imports the rest from here.

- `src/views/`: the views (`app/DESIGN.md`, "Views and containers"), by area as they were under `app/renderer/components`, and the models only they read. A view takes data and callbacks and draws; its container stays in the app.
- `src/views/*/build*.ts`, `gridModel.ts`, `projectListSections.ts`: the row builders of the sidebar, the inbox, the home grid and the palette. Pure functions over what the app's hooks read (`src/lib/forest.ts` names those inputs), so a scene builds rows the same way the app does.
- `src/fixtures/`: the fixture world, a few devices with projects, worktrees, pull requests, changes, settings and villagers. The scenes draw it, and the lab's fake host (`app/lab/fake-host`) serves it to the real app. A worktree id is twelve hex digits, as the contracts require.
- `src/scenes/`: every scene, a picture of the app drawn by its views over the fixtures (`index.ts` lists them). The marketing site renders them, and the lab's viewer draws one at a time.
- `src/primitives/`: the building blocks every view uses (button, input, tooltip, menus, the modal shell), each carrying the `data-slot` the themes hook (`app/DESIGN.md`).
- `src/hooks/`: hooks that only measure or keep time in the page (`useIsTruncated`, `useNow`, `useShortPath`, `useRovingPick`), never fetch.
- `src/lib/`: what the drawing reads: `cn`, relative times, file icons, fuzzy matching, a device's status in words, a villager's voice, a small external store, and the types the app's hooks and store build for the views (`BrowseListing`, `ScriptRunState`, `RemoteDeviceStatus`, `CommandAccess`, and the device roster in `deviceRoster.ts`, which leaves out the host API the app's entries carry).
- `src/root.tsx`: the window's theme root, the element its theme classes, `data-palette` and `data-shell` live on (the app's `#root`, a scene's frame). Overlays mount inside it, so they wear the window's theme. Its `data-shell` root is a container, and the web shell's under 48rem wide takes the phone layout (`phone.css`), whatever box draws it.
- `src/outside.tsx`: how a view opens a web URL or reveals a path. The app provides both at its root, through the host; a scene gets the defaults, which do nothing.
- `src/app-icons/`: the launcher icons and Finder's.
- `src/styles/`: the stylesheets. `index.css` is Tailwind, the tokens and the base rules, and imports the doubutsu overlay (`doubutsu.css`), its palettes (`palettes.css`) and the phone layout (`phone.css`). `fonts.css` is Zen Maru Gothic, loaded beside it rather than inside, and `fonts/` the Nerd Font symbols with their license.

Consumers import a module by its path under `src/`, with its extension: `@shigomori/ui/primitives/button.tsx`, `@shigomori/ui/lib/utils.ts`. Inside the package, imports are relative with the extension.

The package declares its runtime dependencies itself, at the catalog's versions, and keeps them in its own `node_modules`. Every build of the renderer tree resolves the ones it shares with the app once, from the app (`app/vite.dedupe.ts`), so the primitives and the app share one React and one Base UI. The stylesheet names this package's sources for Tailwind; a stylesheet that imports it names its own (`app/renderer/app.css`).

Two proofs run in Node (`pnpm run check:ui` from the root). `test/boundary.test.ts` holds what the sources may import (the package's own dependencies, the contracts and each other, never the app, Node, Electron or the host bridge), that a view or primitive reads no global and no viewport width, and that no stylesheet rule reaches past the root. `test/scenes.test.tsx` renders every scene with no window, no router and no query client, and fails on a view no scene draws.
