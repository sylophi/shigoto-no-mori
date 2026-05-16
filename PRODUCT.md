# Product

## Register

product

## Users

Solo developers and small teams running parallel local development. They juggle multiple feature branches at once, often with AI agents running in worktrees, and want the worktree primitive made first-class without an opinionated workflow on top.

Context when using: at a desktop, switching between branches mid-task, frequently spawning new branches for experiments or agent runs, and needing fast access to a shell, editor, or agent inside each worktree.

The job to be done: manage a forest of git worktrees with the same ease a CLI power-user expects from a tool like worktrunk, but with a GUI, persistent across sessions, and one-click launching of common per-worktree commands.

## Product Purpose

Shigoto no Mori is a lightweight desktop app for managing many git worktrees in parallel. It does three things well:

- Create, list, switch, merge, and delete worktrees from a single window.
- Launch per-worktree commands (editor, shell, agent CLI, anything configured per project) with one click.
- Show enough git context per worktree (branch, ahead/behind, diff summary, status) to act without leaving the app.

It deliberately does not own the terminal, the editor, the agent, or the dev server. Those tools already exist and are good. The app's job is the worktree, the launcher, and the at-a-glance status.

The product succeeds when a developer can run 3–10 parallel worktrees with agents or experiments and feel calm, not chaotic.

## Brand Personality

**Target aesthetic (post-v1):** Animal Crossing themed. Bold, colorful, rounded, playful. Zen Maru Gothic typography, OKLCH chromatic palette (leaf, wood, amber, sky, pink), watermark kanji, gentle motion. Voice: warm and assured, low-key whimsical, never childish.

**Interim aesthetic (v1):** Restrained, tool-shaped, in the lineage of tuneloupe / hewwo / fileatlas. Geist sans plus Geist mono, OKLCH neutrals, single accent reserved for primary actions, dashed drop-zone affordances, no chromatic tinting yet. Generous rounding (carry the ~24px radius DNA forward) so the AC pass later does not require restructuring.

Three-word personality: **calm, direct, earned-playful**.

## Anti-references

- **Conductor / AI-native lock-in.** Chat-as-the-app, task-list-as-the-app, prompt history surfaced in the UI. This is a worktree manager, not an agent UI.
- **Generic Electron chrome.** Slack and Discord-shaped sidebars, glassy panels, web-app-in-a-frame energy.
- **VS Code clones.** Activity bar plus tab bar plus status bar plus panels, editor-shaped chrome where there is no editor.
- **SaaS dashboards.** Hero metrics, big-number cards, illustrated empty states, marketing polish on a dev tool.
- **AI-product cliché.** Gradients, sparkles, "magic" framing.

## Design Principles

1. **Worktree is the primary noun.** No abstraction layer (task, session, feature) between the user and the thing on disk. The list you see is the worktrees you have.

2. **Lean in, don't lock in.** The app makes parallel work easy by letting the user configure what to launch inside each worktree. It does not own the editor, the shell, the agent, or the dev server.

3. **Earn the UX before the dress.** Ship a restrained v1 that proves the interaction model works. Apply the Animal Crossing aesthetic as a deliberate, named pass, not piecemeal alongside features.

4. **Calm parallelism.** Running 10 worktrees should feel like 10 quiet things, not 10 noisy things. Visual hierarchy, color, and motion all serve this, even at the playful end of the AC spectrum.

5. **Keyboard parity for the core loop.** Switching, creating, and launching across worktrees must be keyboardable. Other surfaces can be mouse-first.

## Accessibility & Inclusion

No formal WCAG target for v1. Defaults to honor:

- Keyboard navigation for the core loop (worktree list, create, switch, launch).
- Reasonable contrast across surfaces; light and dark themes both readable at small text sizes.
- `prefers-reduced-motion` respected for any non-essential animation introduced now or in the AC pass later.

Revisit accessibility once the core workflow is stable.
