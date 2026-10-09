# Working on Shigoto no Mori

`README.md` has the layout, and each folder documents itself.

- pnpm for JavaScript, one workspace installed from the root
  (`pnpm -C app …` or the root scripts for the app), Go for `file-sync/`
  and `macfs/`, Bun to compile the terminal `sm` (`packages/cli`).
- On commit, lefthook runs lint, format, typecheck and the proofs the
  change touches, and CI runs every check on each pull request:
  `pnpm check`, each piece a `check:*` script in the root
  `package.json`. `pnpm test <name>` runs one proof (`app/test/`).
- To check a change by running it (a screen in some state, a
  screenshot, the real app on several devices), start at
  `app/lab/README.md`. Pages and windows are driven with weblab.
- UI changes follow `app/DESIGN.md`.
- Effect code follows `EFFECT.md`. While the `release/v3` branch lives, `V3.md`
  is its charter and checklist, and `CLAUDE.md` holds the rules for a
  thread working one of its items.
- A pull request has a short title and a body that is a single brief
  `## Description` section: what changed and why, in a few sentences.
  No test plan or other sections.
- Docs state what is and why it is so. A comparison with another
  product or codebase goes in a report, a PR body or a thread, not a
  doc.
- `skills/` is for people using `sm`, not instructions for this repo.
