# Product

## Register

product

## Users

Solo developers running parallel development across the machines they own: a desktop at home, a laptop on the road, maybe a box that stays on. They juggle many feature branches at once, often with AI agents running in worktrees, and want the worktree primitive made first-class on every one of those machines without an opinionated workflow on top.

Context when using: at whichever machine is in front of them, or in a browser tab on one with nothing installed. Switching between branches mid-task, spawning branches for experiments or agent runs, starting a dev server or an agent on another machine and expecting the port or the output to show up here, moving a worktree to the machine with the right hardware. Needing fast access to a shell, editor, or agent inside each worktree.

The job to be done: manage a forest of git worktrees, on every machine you own, with the ease a CLI power-user expects from a tool like worktrunk, but with a GUI, persistent across sessions, one-click launching of per-worktree commands, and no networking homework. Sign in, add a machine, and it works.

Today sm has one user, its author. Simplicity is a feature, and the author dogfooding every path is the QA strategy. The product is sized for one person to hold in their head. Many-user machinery is not built.

## Product Purpose

Shigoto no Mori is a lightweight desktop app, with a matching website, for managing many git worktrees in parallel across every machine you own. It does four things well:

- Create, list, switch, merge, and delete worktrees from a single window, on any of your devices.
- Launch per-worktree commands (editor, shell, agent CLI, anything configured per project) with one click.
- Show enough git context per worktree (branch, ahead/behind, diff summary, status) to act without leaving the app.
- Make the machine a worktree lives on stop mattering: see every project and worktree on every device, reach remote work through port forwarding, continuous syncing, or a one-time transfer (see below), change any device's settings from anywhere.

It deliberately does not own the terminal, the editor, the agent, or the dev server. Those tools already exist and are good. The app's job is the worktree, the launcher, and the at-a-glance status, wherever the worktree lives.

The product succeeds when a developer can run 3 to 10 parallel worktrees, spread across their machines, with agents or experiments and feel calm, not chaotic. For the multi-device half, the bar is not "remote access works". The bar is that you stop noticing which machine a worktree lives on.

### Three ways to reach remote work

There are exactly three ways to work with a worktree that lives on another machine. Each has its own job, and none is a fallback for another.

- **Port forwarding.** Start the dev server over there, open the port here. Enough for web apps and anything else reached through a browser or a socket. The files stay where they are.
- **Worktree syncing.** The worktree is continuously mirrored between the two machines: every file, not only what git tracks. Work happens on the remote machine and shows up here instantly, and edits made here show up there. Both sides are real git worktrees whose branch, commits, and uncommitted changes agree, so git behaves identically on either machine. This is the default answer to "I want that worktree in front of me": for every practical purpose, the remote worktree is on the local disk.
- **Worktree transfer.** A special case of syncing: the worktree crosses once, in full, uncommitted changes included, and then lives on the destination. Copy it, or move it and tear the source down. For when the work belongs on the machine with the right hardware, or the source machine is going away.

## How Decisions Get Made

Priorities, in order. When two pull apart, resolve in this order and say so.

1. **Simplicity, YAGNI, maintainability.** The smallest correct thing one person can hold in their head and keep working. Prefer the boring, conventional mechanism over the clever one. When a review proposes armor, ceremony, or abstraction beyond that, cut it.
2. **Seamlessness.** It matters enormously. A remote machine has to stop feeling remote. Anything that makes the happy path slower, chattier, or more confusing is a bug, not a nice-to-have.
3. **Everything else.**

Two rules sit alongside the order:

- **YAGNI applies to implementations, never to requirements.** Simplify how a thing is built. Do not trim what the product does to make the build smaller.
- **Be optimistic.** Secure and seamless are not in tension. The owner's own machines and the managed services carrying their traffic are not adversaries. Keep the cheap correctness that comes for free (validate inputs at the boundary, fail-closed gates because they are simpler to reason about than open ones) and stop there. Hypothetical-threat armor does not get built. The real work is the quality of the workflow.

## Brand Personality

**Doubutsu** is the default, shipped look: Animal Crossing themed. Bold, colorful, rounded, playful. Zen Maru Gothic typography, OKLCH chromatic palette (leaf, wood, amber, sky, pink), watermark kanji, gentle motion. Voice: warm and assured, low-key whimsical, never childish.

**v1** is the opt-out: restrained, tool-shaped, in the lineage of tuneloupe / hewwo / fileatlas. Geist sans plus Geist mono, OKLCH neutrals, single accent reserved for primary actions, dashed drop-zone affordances. It is also the vocabulary every component is written in. Doubutsu is an overlay that remaps it, never a second component tree.

Three-word personality: **calm, direct, earned-playful**.

Remote devices feel native. A worktree on another machine is drawn the same as one here, not set apart. Devices are not separated in the UI. Worktree flows are merged across them as far as possible, so the device is a detail of a worktree, not a mode the app is in.

## Anti-references

- **Conductor / AI-native lock-in.** Chat-as-the-app, task-list-as-the-app, prompt history surfaced in the UI. This is a worktree manager, not an agent UI.
- **Generic Electron chrome.** Slack and Discord-shaped sidebars, glassy panels, web-app-in-a-frame energy.
- **VS Code clones.** Activity bar plus tab bar plus status bar plus panels, editor-shaped chrome where there is no editor.
- **SaaS dashboards.** Hero metrics, big-number cards, illustrated empty states, marketing polish on a dev tool.
- **AI-product cliché.** Gradients, sparkles, "magic" framing.
- **Networking homework.** Tailscale, hand-rolled SSH, or manual port forwarding as the price of reaching your own machines. Log in, add a machine, and it works.
- **Armor against hypothetical threats.** Treating your own machines, or the managed services carrying your traffic, as adversaries. Cheap correctness that comes for free stays. The rest does not get built.

t3 code is the comparison product for the multi-device half: a real account, a relay kept out of the hot path, reconnect discipline. Borrow a specific verified idea from it when it fits, never the many-user machinery around it.

## Design Principles

1. **Worktree is the primary noun.** No abstraction layer (task, session, feature) between the user and the thing on disk. The list you see is the worktrees you have.

2. **Lean in, don't lock in.** The app makes parallel work easy by letting the user configure what to launch inside each worktree. It does not own the editor, the shell, the agent, or the dev server.

3. **Calm parallelism.** Running 10 worktrees should feel like 10 quiet things, not 10 noisy things. Visual hierarchy, color, and motion all serve this, even at the playful end of the AC spectrum.

4. **Keyboard parity for the core loop.** Switching, creating, and launching across worktrees must be keyboardable. Other surfaces can be mouse-first.

5. **Build in v1 vocabulary, verify in all four modes.** New surfaces are written in v1 terms (tokens, borders, shadows) and inherit doubutsu through the overlay. A theme-specific fork of a component is a bug. Light, dark, and both with doubutsu get eyeballed before chrome changes ship.

## Accessibility & Inclusion

No formal WCAG target yet. Defaults to honor:

- Keyboard navigation for the core loop (worktree list, create, switch, launch).
- Reasonable contrast across surfaces, with light and dark themes both readable at small text sizes in both visual systems.
- `prefers-reduced-motion` respected for any non-essential animation.

Revisit accessibility once the multi-device workflow is stable.
