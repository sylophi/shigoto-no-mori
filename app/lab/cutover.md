# The 3.0 cutover

3.0's hub turns away every build below its protocol, and a 2.x device's
credential has no device key, so the production hub, the web client and
every installed app move to 3.0 together. The release goes out in this
order.

1. The D1 migrations on a copy of production: `wrangler d1 export` of
   `shigomori-hub`, applied locally with every migration. The export
   prints a presigned link to it, valid an hour; keep that line out of
   anything shared.
2. The release published from main's tip, flagged as a prerelease. A
   2.x updater passes over a prerelease, so no device runs 3.0 before
   its hub does: one that enrolled on the 2.x hub would keep a key the
   hub never stored. The workflow's "on main" check skips a
   prerelease, so the tag is checked against main's tip by hand.
3. The hub, from `hub/`: `wrangler d1 migrations apply shigomori-hub
   --remote`, then `pnpm run deploy:prod`. The migration goes first,
   since 3.0's Worker reads `public_key` in every device query and
   2.x's is fine on the new column.
4. At once, the release marked a full release:
   `gh release edit v3.0.0 --prerelease=false --latest`. Between 3 and 4
   every 2.x device is turned away. A 2.x updater offers only full
   releases; it checks the staged bundle with `codesign --verify --deep
   --strict` and the installed app's Team ID, swaps it in, and 3.0's
   first start migrates the data folder.
5. The web client: `web-client-prod` moved to the tag's commit by hand
   (`gh api -X PATCH repos/sylophi/shigoto-no-mori/git/refs/heads/web-client-prod -f sha=<sha>`).
   The workflow's job that moves it runs only for a release published
   as a full one, and marking one full later runs nothing.
6. Each device reads signed out on its first 3.0 start and enrolls
   again: on its own while its Clerk session lives, after a sign-in
   otherwise. Until then its peers can't reach it.

Clerk's production instance needs nothing new: 3.0 signs in with the
origin and redirect 2.x uses (`hub/README.md`).

## Upgrading is one-way

Once the import is verified, 3.0's first start deletes the files 2.x
kept its state in, the hub turns 2.x away, and nothing exports back to
2.x. A backup of the data folder made before the update is the only way
back, and the release notes say to make one.

## The way back

The backup alone isn't all of it: the move into `wt/` also changes
git's records outside the data folder (each worktree's `.git` file and
each repo's `.git/worktrees/<name>/gitdir`). With 3.0 quit:

1. Move each worktree the import moved back to where 2.x kept it. The
   moves are in the store:
   `sqlite3 <data folder>/store.db "SELECT from_path, to_path FROM wt_moves WHERE moved = 1"`.
   The import's are the rows whose `from_path` is under a 2.x root (the
   data folder's `worktrees/<project>`, the project's own
   `.shigomori/worktrees`, or a drive's `.sm/worktrees/<project>`). A
   later move or rename adds a row from that `to_path` on, so where the
   worktree is now is the end of its chain, as `git worktree list`
   shows. For each, `mkdir -p` the parent of `<from_path>` (the import
   removes a 2.x root it emptied), then
   `git -C <project> worktree move <where it is now> <from_path>`,
   which rewrites both links. Git won't move a worktree across volumes:
   one a later move took to another drive is copied back instead
   (`cp -Rp` to `<from_path>`, then
   `git -C <project> worktree repair -- <from_path>`, then the copy on
   the drive deleted). A worktree made after the update isn't in the
   backup, and 2.x doesn't know it.
2. Copy the backed-up 2.x files back into the data folder.
3. Set `store.db` and its `-wal` and `-shm` aside. A store whose import
   is recorded never imports again, so what 2.x writes after the
   restore would never reach a later 3.0.

The data files, every repo's worktree list, refs and local config, and
each worktree's HEAD, changes and stashes are then as they were before
the update, and 2.x opens the folder as one that never saw 3.0.
