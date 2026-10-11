# renderer

The app's UI as the desktop window and the web client both run it: the
containers, hooks, stores and routes over the views in `@shigomori/ui`
(`app/DESIGN.md`, "Views and containers"). The web client's entry
(`../web`) mounts this same tree.

- `index.tsx`, `boot.tsx`: a desktop window's entry and the boot both
  shells share. `startApp` runs once a page (the query client, the
  atoms' registry, the device registry sync, each peer's push watch);
  `mountWindow` draws a window into it (`App.tsx`, the provider tree,
  and `router.tsx`, the one route tree).
- `components/<area>/`: the containers, by area, each binding its data
  to a view from `@shigomori/ui` under the plain name the view drops
  `View` from. A container draws no markup of its own.
- `hooks/<area>/`: where a container's data comes from. A host view (a
  stream the host serves) is an atom (`lib/runtime/atoms.ts`, read
  through `lib/runtime/viewHooks.ts`); a request is a React Query query
  whose key comes from `lib/queryKeys.ts`. A hook under
  `hooks/remote/` scopes its calls to a device (`useHostScope`).
- `lib/runtime/`: the client's runtime, one per window or tab, built
  from its links as the page boots and disposed as it goes
  (EFFECT.md, section 3): `client.ts`, the links (`ClientLinks.ts`,
  `peerLink.ts`), and the api over them (`Api.ts`).
- `lib/`: the rest of the window's own logic (deep links, focus, the
  theme root, toasts, the remote device registry and its sync).
- `store/`: the stores that keep a stream or a feed rather than a view
  (the script runs, the worktree lifecycle, the terminal drawer).

A new screen is a view in `@shigomori/ui` with a scene
(`packages/ui/README.md`), a container here that binds it, a route in
`router.tsx` when it is a page, and its data from a hook. What is still
migrating here (the global `window.api`, the stores that become atoms)
is listed in V3.md, step 7, Leftover mechanisms.
