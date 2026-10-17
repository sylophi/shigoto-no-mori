@AGENTS.md

# While the v3 branch lives

`V3.md` is the branch's charter and checklist, and `EFFECT.md` the
conventions every Effect change follows. A thread handed a `V3.md`
item works like this. Remove this section when `release/v3` merges into
`main`.

1. **Load the context.** `V3.md`: the decision behind the item, its
   step, and the designs and vocabulary sections for the piece being
   changed. `EFFECT.md` in full for any TypeScript change.
   `app/DESIGN.md` for any UI change. `node_modules/effect` for any
   API on an unstable module; never write such a pattern from memory.
2. **Take a worktree on the branch.** `smv3 worktrees create --base release/v3`,
   then name it (the `sm-basics` and `sm-for-agents` skills): a branch name starting with
   `v3/`, a title written like a PR title and starting with `V3: `,
   and a description that says which `V3.md` item it closes.
   The owner dogfoods v3, so every worktree and title for this branch
   goes through the installed v3 build's `smv3`, never v2's `sm`, and
   the work shows in the v3 app; the skills' `sm` commands are run as
   `smv3`.
3. **Keep to the item.** The PR targets `release/v3`, with an ordinary title
   and the `easy-pr` body style. A neighboring improvement goes in
   the report, not the PR, unless the brief says otherwise. The
   terminal `sm` keeps the Go `sm`'s verbs, flags and JSON (decision
   13); a new verb or flag is the owner's call.
   Cut down on unnecessary comments: one stays only when it says what
   the code cannot (a quirk, a workaround and what it works around, an
   invariant or ordering a reader could break, a why that isn't
   obvious), and a doc comment on exported API keeps the one line
   that says what the thing is for when its name doesn't; the READMEs
   and `V3.md` are not comments.
   A fix is closed only once it names the defect's class, the earlier
   failures of that class, the search made for its siblings and that
   search's scope, and each sibling's disposition: fixed here, its
   own PR, or a line in `V3.md`.
   A workflow that changes state is proved by a failure injected
   between each pair of its external steps and by a recovery that
   itself fails, and its cleanup is proved after a refusal and after
   a kill, not only after success.
   Run the targeted checks (lefthook on commit, `pnpm test <name>` for
   the proofs touched) and leave the repo-wide suite to CI. A UI
   change comes with before and after shots from the lab
   (`app/lab/README.md`), in both themes.
4. **Close it out.** Tick the item's box in `V3.md` in the same PR,
   and add a line under its step if something was left open. Finalize
   (`/finalize`). Every review started is read before landing, and
   one of them reviews the final change, not an earlier commit. Ask
   before landing unless the brief says the PR may merge itself when
   green. Report to the orchestration thread with
   the PR link, what was left out and why, and what the next item
   should know.

## Which model for what, while the branch lives

Opus for UI and UX design given direction, for copy and prose (PR
titles and bodies, docs, release notes, user-facing strings), and for
working out what the owner needs from a loose ask. Fable for the
large plans, the decisions and trade-offs, and the orchestration
thread, which delegates the former and keeps the latter. Sonnet for
linear bulk verification once the judgment has been made: walking a
checklist over many files, or confirming a mechanical change held.
