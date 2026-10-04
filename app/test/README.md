# Tests

The programmatic checks: proofs that run unattended, with no window,
account or second device. Testing by hand, on the real UI, is the
lab's (`../lab/README.md`).

```sh
pnpm test                  # list the proofs
pnpm test socket-host      # run one
pnpm test mirror account   # run several, in order, stopping at a failure
pnpm test socket-host --update   # flags pass through to the proof
```

Each proof is a standalone script at the top of this directory that
exits non-zero when it fails (`run.mts` is the runner, `lib/` what they
share). `lefthook.yml` runs each on commit, gated to the files it
covers, and `lefthook run pre-commit --all-files` runs the lot. The
hub has its own suite in `../../hub`.

To add one, add `<name>.mts` here and a lefthook job that runs it when
the files it covers change.
