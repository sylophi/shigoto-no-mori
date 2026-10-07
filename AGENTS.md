# Working on Shigoto no Mori

`README.md` has the layout, and each folder documents itself.

- pnpm for JavaScript (`pnpm -C app …`, or the root scripts that forward
  to it), Go for `cli/` and `file-sync/`.
- On commit, lefthook runs lint, format, typecheck and the proofs the
  change touches, and CI runs every check on each pull request:
  `pnpm check`, each piece a `check:*` script in the root
  `package.json`. `pnpm test <name>` runs one proof (`app/test/`).
- To check a change by running it (a screen in some state, a
  screenshot, the real app on several devices), start at
  `app/lab/README.md`. Pages and windows are driven with weblab.
- UI changes follow `app/DESIGN.md`.
- `skills/` is for people using `sm`, not instructions for this repo.
