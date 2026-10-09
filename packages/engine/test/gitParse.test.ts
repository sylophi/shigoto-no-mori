// Properties of the readers of git's output: each reads back what git
// would have printed for generated checkouts, files and refs, spaces and
// odd names included.
import { isDeepStrictEqual } from "node:util";
import * as Arbitrary from "effect/Arbitrary";
import * as Schema from "effect/Schema";
import { describe, it } from "vitest";
import {
  escapeGitignorePattern,
  parseBranchRefs,
  parseStatus,
  parseWorktreeList,
  splitRemoteRef,
  type WorktreeEntry,
} from "../src/gitParse.ts";
import { holds, textOf } from "./lib/properties.ts";

// A file or folder name: spaces, dashes, dots and the characters a
// gitignore pattern treats as special.
const name = textOf(
  ["a", "b", "x y", "-", ".", "é", "*", "?", "[", "]", "#", "!", "\\", " "],
  {
    minLength: 1,
    maxLength: 6,
  },
);
const path = Arbitrary.map(
  Arbitrary.array(name, { minLength: 1, maxLength: 3 }),
  (parts) => parts.join("/"),
);
// A branch or remote name, which holds no whitespace.
const ref = textOf(["main", "feat", "x", "-", "1", "/"], {
  minLength: 1,
  maxLength: 4,
}).pipe(
  Arbitrary.filter(
    (text) =>
      !text.startsWith("/") && !text.endsWith("/") && !text.includes("//"),
  ),
);
const flag = Arbitrary.schema(Schema.Boolean);

// As `git worktree list --porcelain` prints them.
const porcelain = (entries: ReadonlyArray<WorktreeEntry>) =>
  entries
    .map((one) =>
      [
        `worktree ${one.path}`,
        ...(one.head === "" ? [] : [`HEAD ${one.head}`]),
        ...(one.branch === "" ? [] : [`branch ${one.branch}`]),
        ...(one.bare ? ["bare"] : []),
        ...(one.detached ? ["detached"] : []),
        ...(one.locked ? ["locked"] : []),
      ]
        .map((line) => `${line}\n`)
        .join(""),
    )
    .join("\n");

describe("worktree list", () => {
  const entry: Arbitrary.Arbitrary<WorktreeEntry> = Arbitrary.map(
    Arbitrary.all({
      path: Arbitrary.map(path, (rest) => `/${rest}`),
      head: Arbitrary.schema(Schema.Literals(["", "0123abcd".repeat(5)])),
      branch: Arbitrary.flatMap(flag, (detached) =>
        detached
          ? Arbitrary.Constant("")
          : Arbitrary.map(ref, (short) => `refs/heads/${short}`),
      ),
      bare: flag,
      locked: flag,
    }),
    (fields) => ({ ...fields, detached: fields.branch === "" }),
  );

  it("reads back every checkout", () =>
    holds(Arbitrary.array(entry, { maxLength: 5 }), (entries) =>
      isDeepStrictEqual(parseWorktreeList(porcelain(entries)), entries),
    ));
});

describe("status", () => {
  const XY = Arbitrary.schema(
    Schema.Literals([".M", "M.", "MM", "A.", "AM", ".D", "D."]),
  );
  // One file as `git status --porcelain=v2 -z` records it, and what
  // reading it should give.
  const file = Arbitrary.flatMap(
    Arbitrary.schema(Schema.Literals(["?", "1", "2", "u"])),
    (kind) =>
      Arbitrary.map(Arbitrary.all([XY, path, path]), ([xy, at, from]) => {
        const hashes = "0123abcd 0123abcd";
        switch (kind) {
          case "?":
            return { record: `? ${at}`, path: at, kind: "added" };
          case "1":
            return {
              record: `1 ${xy} N... 100644 100644 100644 ${hashes} ${at}`,
              path: at,
            };
          case "2":
            return {
              record: `2 ${xy} N... 100644 100644 100644 ${hashes} R100 ${at}\0${from}`,
              path: at,
              kind: "renamed",
              prevPath: from,
            };
          default:
            return {
              record: `u UU N... 100644 100644 100644 100644 ${hashes} 0123abcd ${at}`,
              path: at,
              conflicted: true,
            };
        }
      }),
  );

  it("reads back every file's path, sorted, renames and conflicts kept", () =>
    holds(Arbitrary.array(file, { maxLength: 6 }), (files) => {
      const read = parseStatus(
        files.map(({ record }) => `${record}\0`).join(""),
      );
      const want = files.toSorted((a, b) =>
        a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
      );
      return (
        read.length === want.length &&
        read.every(
          (got, index) =>
            got.path === want[index]?.path &&
            (want[index].kind === undefined || got.kind === want[index].kind) &&
            got.prevPath === want[index].prevPath &&
            (got.conflicted === true) === (want[index].conflicted === true),
        )
      );
    }));
});

describe("refs", () => {
  const refs = Arbitrary.all({
    locals: Arbitrary.array(ref, { maxLength: 4 }),
    remotes: Arbitrary.array(
      Arbitrary.map(
        Arbitrary.all([
          Arbitrary.schema(Schema.Literals(["origin", "fork"])),
          ref,
        ]),
        ([remote, branch]) => `${remote}/${branch}`,
      ),
      { maxLength: 4 },
    ),
    heads: Arbitrary.array(
      Arbitrary.schema(Schema.Literals(["origin", "fork"])),
      {
        maxLength: 2,
      },
    ),
  });

  it("reads back the branches and each remote's HEAD", () =>
    holds(refs, ({ locals, remotes, heads }) => {
      const owned = [...new Set(heads)];
      const listing = [
        ...locals.map((short) => `refs/heads/${short} `),
        ...remotes.map((short) => `refs/remotes/${short} `),
        ...owned.map(
          (remote) => `refs/remotes/${remote}/HEAD refs/remotes/${remote}/main`,
        ),
      ].join("\n");
      const read = parseBranchRefs(listing);
      return (
        isDeepStrictEqual(read.locals, locals) &&
        isDeepStrictEqual(read.remotes, remotes) &&
        isDeepStrictEqual(
          [...read.remoteHeads],
          owned.map((remote) => [remote, `refs/remotes/${remote}/main`]),
        )
      );
    }));

  it("splits a remote ref by the longest remote naming it", () =>
    holds(
      Arbitrary.all([
        Arbitrary.array(ref, { minLength: 1, maxLength: 4 }),
        ref,
      ]),
      ([remotes, branch]) =>
        remotes.every((remote) => {
          const split = splitRemoteRef(`${remote}/${branch}`, remotes);
          return (
            split !== undefined &&
            `${split.remote}/${split.branch}` === `${remote}/${branch}` &&
            !remotes.some(
              (other) =>
                other.length > split.remote.length &&
                `${remote}/${branch}`.startsWith(`${other}/`),
            )
          );
        }),
    ));
});

describe("gitignore patterns", () => {
  const SPECIAL = new Set(["*", "?", "[", "]", "#", "!"]);

  // The name a pattern matches, or undefined where something in it is
  // left for git to read as a pattern: a special character or a
  // trailing space, which git strips.
  const literal = (pattern: string) => {
    let text = "";
    let trailing = false;
    for (let at = 0; at < pattern.length; at++) {
      const char = pattern[at] ?? "";
      if (char === "\\") {
        at++;
        text += pattern[at] ?? "";
        trailing = false;
      } else if (SPECIAL.has(char)) {
        return undefined;
      } else {
        text += char;
        trailing = char === " ";
      }
    }
    return trailing ? undefined : text;
  };

  it("escapes a path to the one name it matches", () =>
    holds(path, (raw) => literal(escapeGitignorePattern(raw)) === raw));
});
