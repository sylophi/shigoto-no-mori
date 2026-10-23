# Working on Shigoto no Mori

`README.md` has the layout, and each folder documents itself.

- pnpm for JavaScript, one workspace installed from the root
  (`pnpm install`, then `pnpm run postinstall`, since install scripts
  are off; `pnpm -C app …` or the root scripts for the app), Go for `file-sync/`
  and `macfs/`, Bun to compile the terminal `sm` (`packages/cli`).
- On commit, lefthook runs lint, format, typecheck and the proofs the
  change touches, and CI runs every check on each pull request:
  `pnpm check`, each piece a `check:*` script in the root
  `package.json`. `pnpm test <name>` runs one proof (`app/test/`), and
  `pnpm -C packages/<package> exec vitest run <file>` one package
  test file. `pnpm typecheck` also prints the Effect language
  service's suggestions (`suggestion TS377…`), which don't fail it.
  Run the checks a change touches and leave the repo-wide suite to CI.
- To check a change by running it (a screen in some state, a
  screenshot, the real app on several devices), start at
  `app/lab/README.md`. Pages and windows are driven with weblab.
- UI changes follow `app/DESIGN.md`, and come with before and after
  shots from the lab, in light and dark.
- Effect code follows `EFFECT.md`, which starts by sending you to
  Effect's own guidance for the pinned version: read it before writing
  Effect code.
- A workflow that changes state is proved by a failure injected
  between each pair of its external steps and by a recovery that itself
  fails, and its cleanup after a refusal and after a kill, not only
  after success.
- A pull request has a short title and a body that is a single brief
  `## Description` section: what changed and why, in a few sentences.
  No test plan or other sections.
- Docs state what is and why it is so. A comparison with another
  product or codebase goes in a report, a PR body or a thread, not a
  doc.
- A comment stays only when it says what the code can't: a quirk, a
  workaround and what it works around, an invariant or an ordering a
  reader could break, a why that isn't obvious. A doc comment on an
  exported API keeps the one line that says what it is for when its
  name doesn't. The READMEs aren't held to this.
- A fix's `## Description` also names the defect's class, the earlier
  failures of that class, the search made for its siblings and that
  search's scope, and what became of each sibling: fixed with it, its
  own PR, or left, and why.
- Path identity and a GitHub host's identity are boundary policies
  every consumer shares. After a failure of either, find every consumer and
  check each across linked data folders, project and custom paths, a
  second volume, denied folders, public and Enterprise GitHub hosts,
  and more than one machine.
- `skills/` is for people using `sm`, not instructions for this repo.
