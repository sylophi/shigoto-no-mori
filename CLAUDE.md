@AGENTS.md

# While the v3 branch lives

`V3.md` is the branch's charter and checklist, and `EFFECT.md` the
conventions every Effect change follows. A thread handed a `V3.md`
item works like this. Remove this section when `v3` merges into
`main`.

1. **Load the context.** `V3.md`: the decision behind the item, its
   step, and the designs and vocabulary sections for the piece being
   changed. `EFFECT.md` in full for any TypeScript change.
   `app/DESIGN.md` for any UI change. `node_modules/effect` for any
   API on an unstable module; never write such a pattern from memory.
2. **Take a worktree on the branch.** `sm worktrees create --base v3`,
   then name it (`/sm-name-worktree`): a descriptive branch name, a
   title written like a PR title, and a description that says which
   `V3.md` item it closes.
3. **Keep to the item.** The PR targets `v3`, with an ordinary title
   and the `easy-pr` body style. A neighboring improvement goes in
   the report, not the PR, unless the brief says otherwise. A
   converted subsystem keeps a Promise adapter for unconverted callers
   (`EFFECT.md`, runtime boundaries) until the last caller moves. The
   Go CLI gets bug fixes only; its verbs, flags and JSON are frozen.
   Comments describe how a thing is used and move with the code; the
   ordering and cleanup prose that the structure now enforces goes.
   Run the targeted checks (lefthook on commit, `pnpm test <name>` for
   the proofs touched) and leave the repo-wide suite to CI. A UI
   change comes with before and after shots from the lab
   (`app/lab/README.md`), in both themes.
4. **Close it out.** Tick the item's box in `V3.md` in the same PR,
   and add a line under its step if something was left open. Finalize
   (`/finalize`). Ask before landing unless the brief says the PR may
   merge itself when green. Report to the orchestration thread with
   the PR link, what was left out and why, and what the next item
   should know.
