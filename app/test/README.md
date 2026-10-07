# Tests

The programmatic checks: proofs that run unattended, with no window,
account or second device. Testing by hand, on the real UI, is the
lab's (`../lab/README.md`).

Each proof is a standalone script at the top of this directory that
exits non-zero when it fails, and `lib/` holds what they share.
`pnpm test` lists them and `pnpm test <name>` runs one (`run.mts`, the
runner, has the other forms). `lefthook.yml` runs each on commit,
gated to the files it covers, and `lefthook run pre-commit --all-files`
runs the lot. CI runs every one on each pull request (`pnpm test --all`,
in `.github/workflows/checks.yml`). The hub has its own suite in
`../../hub`.

To add one, add `<name>.mts` here and a lefthook job that runs it when
the files it covers change.
