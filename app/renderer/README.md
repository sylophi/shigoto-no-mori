# renderer

The app's UI as the desktop window and the web client both run it: the
containers, hooks, stores and routes over the views in `@shigomori/ui`
(`app/DESIGN.md`, "Views and containers"). The web client's entry
(`../web`) mounts this same tree.

- `index.tsx`, `boot.tsx`: a desktop window's entry and the boot both
  shells share. `startApp` runs once a page (the query client, the
  atoms' registry and what it keeps mounted, the device registry sync,
  each peer's push watch);
  `mountWindow` draws a window into it (`App.tsx`, the provider tree,
  and `router.tsx`, the one route tree).
- `components/<area>/`: the containers, by area, each binding its data
  to a view from `@shigomori/ui` under the plain name the view drops
  `View` from. A container draws no markup of its own.
- `hooks/<area>/`: where a container's data comes from (`EFFECT.md`,
  section 10), unless one container alone reads it, which may ask in
  place. An atom is built with `lib/runtime/atoms.ts`, and a host
  view's is read through `lib/runtime/viewHooks.ts`; a request's key
  comes from `lib/queryKeys.ts`. A hook under `hooks/remote/` scopes
  its calls to a device (`useHostScope`). A hook of the page's own
  logic (which device is picked, where a click goes,
  what a menu offers) sits with the containers of the area it belongs
  to (`components/shared/DeviceTabs.tsx`'s `useDeviceTabs`,
  `components/sidebar/openProject.ts`), and another area imports it
  from there.
- `lib/runtime/`: the client's runtime, one per window or tab, built
  from its links as the page boots and disposed as it goes
  (EFFECT.md, section 3): `client.ts`, the links (`ClientLinks.ts`,
  `peerLink.ts`), the api over them (`Api.ts`), and the page's api
  (`pageApi.tsx`): the shell's facts, the device id and that api,
  which the entry builds and hands to the boot. React reads it with
  `useApi()`; what the boot starts outside React takes it as a
  parameter. Nothing reads it off a global. A call on it, or on a
  device's api (`useHostScope().api`, a peer's), is an effect, run
  with that api's `run` (a query hands it React Query's `signal`, so
  a fetch it drops cancels the call); a push or a view is a stream,
  read with its `listen` or an atom.
- `lib/`: the rest of the window's own logic (deep links, focus, the
  theme root, toasts, the remote device registry and its sync).
- `store/`: the page's own state kept outside React (the terminal
  drawer, this window's unsent pull request drafts), and two helpers
  the script runs use (the slot codec, keyed subscribers).

A new screen is a view in `@shigomori/ui` with a scene
(`packages/ui/README.md`), a container here that binds it, a route in
`router.tsx` when it is a page, and its data from a hook.
