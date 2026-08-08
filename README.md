# Shigoto no Mori

A desktop app for managing many git worktrees in parallel.

Comes with a focused GUI and one-click launchers per worktree (editor, shell, agent CLI, anything configurable per project). Agent and platform-agnostic by design.

<img width="1032" height="712" alt="Shigoto no Mori in doubutsu mode: a mint sidebar of projects and worktrees beside a cream detail pane with launcher pills" src="assets/readme-app.png" />

`Shigoto no Mori` plays on *Doubutsu no Mori* (Animal Crossing), "work forest", and the idea of a forest of worktrees: many pieces of work growing side by side without becoming chaos.

Note: This project is still early and in active development. We offer macOS Apple Silicon builds and experimental Windows x64 builds. See [WINDOWS.md](WINDOWS.md) for Windows setup and caveats.

## Agent skills

`skills/` holds instruction snippets that teach coding agents the `sgm`
workflow (create a worktree, switch to one, land and clean up, register a
project). Install with [Vercel skills](https://github.com/vercel-labs/skills)
(skills.sh); the installer lets you pick which ones to include:

```sh
npx skills add https://github.com/sylophi/shigoto-no-mori
```

## License

Shigoto no Mori is licensed under the MIT License. See [LICENSE](LICENSE).
