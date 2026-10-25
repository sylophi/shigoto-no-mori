# Working on Shigoto no Mori

- Run `pnpm run postinstall` after `pnpm install`, since install
  scripts are off.
- Run the checks a change touches and leave the repo-wide suite to CI.
- Tests only guard the user's data: the v2 import, the store's
  migrations, what deletes files, and the wire fixtures.
- UI changes follow `app/DESIGN.md`, with before and after shots from
  the lab (`app/lab/README.md`) in light and dark.
- Read `EFFECT.md` before writing Effect code.
- A pull request has a short title and a body that is one brief
  `## Description` section: what changed and why.
- Docs say what is and why, with no comparisons to other products.
  Comments only say what the code can't.
- `skills/` is for people using `sm`, not for this repo.
