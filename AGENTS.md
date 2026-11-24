# Working on Shigoto no Mori

- Run `pnpm run postinstall` after `pnpm install`, since install scripts are off.
- Run the checks a change touches and leave the repo-wide suite to CI.
- Tests only guard the user's data: the v2 import, the store's migrations, code that deletes files, and the wire fixtures.
- UI changes follow [`app/DESIGN.md`](app/DESIGN.md). Use the lab ([`app/lab/README.md`](app/lab/README.md)) to visually verify them when needed.
- Read [`EFFECT.md`](EFFECT.md) before writing Effect code.
- Technical docs say what is and why, with no comparisons to other products. Comments only say what the code can't.
- [`skills/`](skills/) is for people using `sm`, not for working on this repo.
