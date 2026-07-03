# Shigoto no Mori

A desktop app for managing many git worktrees in parallel.

Comes with a focused GUI and one-click launchers per worktree (editor, shell, agent CLI, anything configurable per project). Agent and platform-agnostic by design.

<img width="1032" height="800" alt="Screenshot 2026-05-18 at 11 43 28 PM" src="https://github.com/user-attachments/assets/eaf42f85-38e3-49e2-af44-0e8fffdbb0f6" />

`Shigoto no Mori` plays on *Doubutsu no Mori* (Animal Crossing), "work forest", and the idea of a forest of worktrees: many pieces of work growing side by side without becoming chaos.

Note: This project is still early and in active development. We offer macOS Apple Silicon builds and Windows builds (Squirrel installer, currently unsigned, so SmartScreen will warn on first run).

On Windows, Git for Windows must be installed and on PATH. Symlink-mode carry-over entries need Developer Mode enabled (Settings > System > For developers); copy mode always works. For development on Windows, use `pnpm run start:win` (the plain `start` script depends on the macOS-only port-pool tool).

## License

Shigoto no Mori is licensed under the MIT License. See [LICENSE](LICENSE).
