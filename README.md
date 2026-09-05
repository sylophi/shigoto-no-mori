# Shigoto no Mori

A desktop app for managing many git worktrees in parallel.

Comes with a focused GUI and one-click launchers per worktree (editor, shell, agent CLI, anything configurable per project). Agent and platform-agnostic by design.

<img width="1032" height="712" alt="Shigoto no Mori in doubutsu mode: a mint sidebar of projects and worktrees beside a cream detail pane with launcher pills" src="assets/readme-app.png" />

`Shigoto no Mori` plays on *Doubutsu no Mori* (Animal Crossing), "work forest", and the idea of a forest of worktrees: many pieces of work growing side by side without becoming chaos.

## Layout

One UI, two shells. The desktop window and the browser tab render the
same `renderer/` tree over the same `window.api` surface. What differs
is the binding underneath, and the two bindings are parallel:

| Concern | Desktop (Electron) | Web (browser) |
| --- | --- | --- |
| Composition root: handlers on the wires, the direct plane, `window.api` | `main/ipc/register.ts` + `main/preload.ts` | `web/ipc/register.ts` + `web/preload.ts` |
| Transport under `window.api` | `main/preloadTransport.ts` (IPC) | `web/ipc/loopback.ts` (in-page) |
| Account: credential store, enroll, device name | `main/account/` | `web/account/` |
| Device hub socket | `host/hub/connection.ts` (node) | `web/hub/connection.ts` (browser) |
| Page entry | `index.html` → `renderer/index.tsx` | `web/index.html` → `web/main.tsx` → `web/boot.tsx` |

`host/` is what a binding serves: the projects, worktrees, scripts and
git of the machine it runs on. The browser binding serves none of it (a
tab hosts nothing), so the web client is the desktop with no local
projects: a hostless controller for the account's other devices. The
renderer gates the few surfaces that only make sense with a machine of
its own behind the window (launch tools, this device's settings, port
forwarding) on `renderer/lib/localHost.ts`; everything else is the same
code in both shells. `shared/` is the contract layer every side
compiles.

## Agent skills

`skills/` holds instruction snippets that teach coding agents the `sm`
workflow (create a worktree, switch to one, land and clean up, tear one
down, register a project). Install with [Vercel skills](https://github.com/vercel-labs/skills)
(skills.sh); the installer lets you pick which ones to include:

```sh
npx skills add https://github.com/sylophi/shigoto-no-mori
```

## License

Shigoto no Mori is licensed under the MIT License. See [LICENSE](LICENSE).
