// Stashes for the Git section. The stash list belongs to the whole
// repository, shared by every worktree, so a worktree lists the ones
// made on its own branch. Each is addressed by its commit hash, since
// the stash@{n} positions shift whenever any worktree stashes or drops.
import type { StashEntry } from "@shigomori/contracts/schemas";
import { onIndex } from "./changes";
import { PATCH_MAX_BUFFER, run, splitZ } from "./core";
import { conflictedPaths } from "./operation";

interface RawStash {
  ref: string;
  hash: string;
  subject: string;
  date: string;
}

async function readStashes(worktreePath: string): Promise<RawStash[]> {
  const out = await run(worktreePath, [
    "stash",
    "list",
    "-z",
    "--format=%gd%x00%h%x00%gs%x00%cI",
  ]);
  const fields = splitZ(out);
  const stashes: RawStash[] = [];
  for (let i = 0; i + 3 < fields.length; i += 4) {
    const [ref = "", hash = "", subject = "", date = ""] = fields.slice(
      i,
      i + 4,
    );
    stashes.push({ ref, hash, subject, date });
  }
  return stashes;
}

// Git words a stash's subject "On <branch>: <message>" when it was given
// one, and "WIP on <branch>: <hash> <subject>" when not.
function messageOn(
  subject: string,
  branch: string,
): { message: string; named: boolean } | null {
  const named = `On ${branch}: `;
  if (subject.startsWith(named)) {
    return { message: subject.slice(named.length), named: true };
  }
  const wip = `WIP on ${branch}: `;
  if (subject.startsWith(wip)) {
    const rest = subject.slice(wip.length);
    return { message: rest.slice(rest.indexOf(" ") + 1), named: false };
  }
  return null;
}

export async function listStashes(
  worktreePath: string,
  branch: string,
): Promise<StashEntry[]> {
  return (await readStashes(worktreePath)).flatMap(
    ({ hash, subject, date }) => {
      const parsed = messageOn(subject, branch);
      return parsed === null ? [] : [{ hash, ...parsed, date }];
    },
  );
}

// Untracked files go too, so the worktree comes back clean, which is
// what a stash is for here.
export function stashChanges(
  worktreePath: string,
  message: string | undefined,
): Promise<void> {
  return onIndex(worktreePath, async () => {
    const args = ["stash", "push", "--include-untracked"];
    if (message?.trim()) args.push("-m", message.trim());
    await run(worktreePath, args);
  });
}

async function refOf(worktreePath: string, hash: string): Promise<string> {
  const stash = (await readStashes(worktreePath)).find((s) => s.hash === hash);
  if (!stash) throw new Error("That stash is gone.");
  return stash.ref;
}

// With `drop`, a pop: the stash goes only once it applied cleanly. One
// that applied with conflicts stays, so nothing is lost while the
// conflicts are sorted out.
export function applyStash(
  worktreePath: string,
  hash: string,
  drop: boolean,
): Promise<void> {
  return onIndex(worktreePath, async () => {
    const ref = await refOf(worktreePath, hash);
    try {
      await run(worktreePath, ["stash", "apply", "--end-of-options", ref]);
    } catch (err) {
      if ((await conflictedPaths(worktreePath)).length === 0) throw err;
      throw new Error(
        "The stash applied with conflicts. It's kept until they're resolved.",
        { cause: err },
      );
    }
    if (drop) await run(worktreePath, ["stash", "drop", "--quiet", ref]);
  });
}

export async function dropStash(
  worktreePath: string,
  hash: string,
): Promise<void> {
  const ref = await refOf(worktreePath, hash);
  await run(worktreePath, ["stash", "drop", "--quiet", ref]);
}

// The way back from a drop: the stash's commit is still in the object
// store, and `stash store` lists it again, on top, under its subject as
// git words it. An unnamed one's names the stash itself where git's
// names the commit under it, which nothing here reads.
// store takes no --end-of-options, and needs none: the hash is
// schema-pinned hex.
export async function restoreStash(
  worktreePath: string,
  branch: string,
  hash: string,
  { message, named }: { message: string; named: boolean },
): Promise<void> {
  await run(worktreePath, [
    "stash",
    "store",
    "-m",
    named ? `On ${branch}: ${message}` : `WIP on ${branch}: ${hash} ${message}`,
    hash,
  ]);
}

// What a stash holds, as one patch: its tracked changes and the
// untracked files it took, as additions.
export async function readStashDiff(
  worktreePath: string,
  hash: string,
): Promise<string> {
  const ref = await refOf(worktreePath, hash);
  return run(
    worktreePath,
    ["stash", "show", "-p", "--include-untracked", "--no-color", ref],
    { maxBuffer: PATCH_MAX_BUFFER },
  );
}
