// Villagers speak in toasts. With Village life on, a worktree named
// after an Animal Crossing character is that character's home, and its
// news comes out in their voice. The rules, all decided here so call
// sites only say which worktree a toast is about:
//
// - Only success. A warning or an error is never cute, and a neutral
//   notice (a discard, an undo) usually reports a loss.
// - Only a name that is a character's slug (`sheldon`, `sheldon-2`),
//   and only a catchphrase in Latin script: kana would read as a glitch
//   in an English sentence. The catchphrase keeps its own casing (WHONK)
//   and takes the sentence's end.
// - A worktree appearing is its villager moving in, and one going is
//   them moving out, whoever did it: this app, the CLI or another
//   device (lib/villagers/moves.ts watches for both).
// - The moment scales with rarity (DESIGN.md, "Village life: rarity").
//   Special characters have no catchphrase, so a rare or legendary one
//   speaks through their quote instead, and stays on screen longer.
//
// Pure, so test/villager-voice.mjs drives it under plain Node.
import type {
  VillagerProfile,
  VillagerProfiles,
  Worktree,
} from "@shared/schemas";
import { type VillagerRarity, villagerRarity } from "@shared/villagers/rarity";

// A character speaking for one of their worktrees.
export interface Speaker {
  // "sheldon", for `sheldon-2` too.
  slug: string;
  profile: VillagerProfile;
  rarity: VillagerRarity;
  // Their face as a data URL, or null without one.
  face: string | null;
  // Their own color, read off the face (lib/villagers/faceColor.ts),
  // for a rare one's name plate. Null without a clear one.
  color: string | null;
}

export interface VillagerLine {
  // The message without its closing punctuation.
  lead: string;
  // What the villager adds: ", cardio!".
  tail: string;
  // "Sheldon", for the tail's tooltip.
  speaker: string;
}

// The character a worktree is named after: its name, or its name
// before a numeric suffix (`sheldon-2`, a second Sheldon worktree).
// Null for any other name.
export function speakerSlug(
  worktreeName: string,
  profiles: VillagerProfiles,
): string | null {
  if (Object.hasOwn(profiles, worktreeName)) return worktreeName;
  const base = /^(.+)-\d+$/.exec(worktreeName)?.[1];
  return base !== undefined && Object.hasOwn(profiles, base) ? base : null;
}

// The speaker for a worktree, without their face and color (the caller
// reads those), or null when the name isn't a character's.
export function speakerFor(
  worktreeName: string,
  profiles: VillagerProfiles,
): Omit<Speaker, "face" | "color"> | null {
  const slug = speakerSlug(worktreeName, profiles);
  if (slug === null) return null;
  const profile = profiles[slug];
  return { slug, profile, rarity: villagerRarity(slug, profile) };
}

// Letters from any script but Latin rule a phrase out. Punctuation and
// spaces are fine (li'l one, bully, eh).
const NON_LATIN_LETTER = /(?!\p{Script=Latin})\p{L}/u;
const TRAILING_PUNCTUATION = /[\s.!?…,;:]+$/u;
// A catchphrase that trails off or exclaims on its own takes no second
// mark. An apostrophe is part of the word (rockin').
const CLOSES_ITSELF = /[.!?…—–~]$/u;

// Something a villager says (a catchphrase, a quote) tidied for a
// sentence, or null when there is nothing this voice can use: no
// letters, or letters in another script.
function sayable(text: string | undefined): string | null {
  const said = text?.trim().replace(/\s+/g, " ") ?? "";
  if (!/\p{L}/u.test(said) || NON_LATIN_LETTER.test(said)) return null;
  return said;
}

// `message` in the speaker's voice, or null when they have no
// catchphrase to end it with.
export function villagerLine(
  speaker: Pick<Speaker, "profile">,
  message: string,
): VillagerLine | null {
  const phrase = sayable(speaker.profile.catchphrase);
  if (phrase === null) return null;
  const lead = message.replace(TRAILING_PUNCTUATION, "");
  if (lead === "") return null;
  const close = CLOSES_ITSELF.test(phrase)
    ? ""
    : /\?\s*$/.test(message)
      ? "?"
      : "!";
  return { lead, tail: `, ${phrase}${close}`, speaker: speaker.profile.name };
}

// ---- moving in and out ----

// Which worktrees appeared and which went between two readings of one
// project's list, by id. The primary checkout is the project itself,
// not a villager's home, so it never counts.
export function worktreeMoves(
  before: readonly Worktree[],
  after: readonly Worktree[],
): { movedIn: Worktree[]; movedOut: Worktree[] } {
  const was = homes(before);
  const is = homes(after);
  return {
    movedIn: [...is.values()].filter((w) => !was.has(w.id)),
    movedOut: [...was.values()].filter((w) => !is.has(w.id)),
  };
}

// The worktrees in a list that are someone's home, by id.
function homes(list: readonly Worktree[]): Map<string, Worktree> {
  return new Map(list.filter((w) => !w.isPrimary).map((w) => [w.id, w]));
}

// A worktree's place in its project, which a relocate keeps.
function keyOf(worktree: Worktree): string {
  return `${worktree.projectId}\u0000${worktree.name}`;
}

// What a gathering of moves on one device comes to. A worktree that went
// and came back didn't move, and nor did one that only changed folders
// (a relocate, a conversion): its id is its path, so it reads as its
// name going and coming in the same project. Each coming cancels one
// going.
export function netMoves(
  movedIn: readonly Worktree[],
  movedOut: readonly Worktree[],
): { movedIn: Worktree[]; movedOut: Worktree[] } {
  const went = new Map<string, number>();
  for (const w of movedOut) went.set(keyOf(w), (went.get(keyOf(w)) ?? 0) + 1);
  const came: Worktree[] = [];
  for (const w of movedIn) {
    const left = went.get(keyOf(w)) ?? 0;
    if (left > 0) went.set(keyOf(w), left - 1);
    else came.push(w);
  }
  // What `went` still counts are the goings nothing came back for.
  const gone = movedOut.filter((w) => {
    const left = went.get(keyOf(w)) ?? 0;
    if (left === 0) return false;
    went.set(keyOf(w), left - 1);
    return true;
  });
  return { movedIn: came, movedOut: gone };
}

export type MoveKind = "in" | "out";

export type MoveSubject = Pick<
  Worktree,
  "id" | "name" | "branch" | "detached" | "mergedIntoPrimary"
>;

export interface MoveNews {
  kind: MoveKind;
  // The worktrees it tells of.
  worktreeIds: string[];
  // Another device the move happened on, by name.
  device: string | null;
  // "Lucha moved out", "Lucha and Raymond moved in". With a device
  // named, "on Thinkpad" follows.
  title: string;
  // The title in the villager's voice, for one common villager with a
  // catchphrase this voice can use.
  line: VillagerLine | null;
  // What a rare or legendary one moving on their own says, in their
  // dialogue box or their letter: their quote, or with none this voice
  // can use, the move in their own words ("I'm moving in!").
  words: string | null;
  // "Held v2-exp/flows", "Landed 2 of 3 branches", or null.
  detail: string | null;
  // The branch named in `detail`, for one villager, set in mono.
  branch: string | null;
  speakers: Speaker[];
  // The rarest among them, which sets how long the news stays.
  rarity: VillagerRarity;
}

const RANK: Record<VillagerRarity, number> = {
  common: 0,
  rare: 1,
  legendary: 2,
};

export function rarest(speakers: readonly Speaker[]): VillagerRarity {
  return speakers.reduce<VillagerRarity>(
    (top, { rarity }) => (RANK[rarity] > RANK[top] ? rarity : top),
    "common",
  );
}

// How long the news stays, by the rarest in it: long enough for a
// dialogue box to finish its line, and for a letter to arrive, write
// itself and be read.
export const MOVE_TOAST_MS: Record<VillagerRarity, number> = {
  common: 6_000,
  rare: 9_000,
  legendary: 14_000,
};

function names(list: readonly string[]): string {
  if (list.length === 1) return list[0];
  if (list.length === 2) return `${list[0]} and ${list[1]}`;
  if (list.length === 3) return `${list[0]}, ${list[1]} and ${list[2]}`;
  return `${list[0]}, ${list[1]} and ${list.length - 2} others`;
}

function landedSummary(worktrees: readonly MoveSubject[]): string | null {
  const branches = worktrees.filter((w) => !w.detached);
  const landed = branches.filter((w) => w.mergedIntoPrimary);
  if (landed.length === 0) return null;
  if (landed.length < branches.length) {
    return `Landed ${landed.length} of ${branches.length} branches`;
  }
  if (branches.length === 1) return "Landed their branch";
  if (branches.length === 2) return "Landed both branches";
  return `Landed all ${branches.length} branches`;
}

// The news for villagers moving in or out of one device at once, or
// null when none of the worktrees is a character's. `speakers` holds
// the speaker for each worktree that has one, by worktree id. `device`
// names another device the move happened on.
export function moveNews(
  kind: MoveKind,
  worktrees: readonly MoveSubject[],
  speakers: ReadonlyMap<string, Speaker>,
  device?: string,
): MoveNews | null {
  const moving = worktrees.filter((w) => speakers.has(w.id));
  if (moving.length === 0) return null;
  // sheldon and sheldon-2 are one villager moving twice.
  const who = [
    ...new Map(
      moving.map((w) => {
        const speaker = speakers.get(w.id)!;
        return [speaker.slug, speaker];
      }),
    ).values(),
  ];
  const verb = kind === "in" ? "moved in" : "moved out";
  const where = device === undefined ? "" : ` on ${device}`;
  const title = `${names(who.map((s) => s.profile.name))} ${verb}${where}`;
  const shared = {
    kind,
    worktreeIds: moving.map((w) => w.id),
    device: device ?? null,
    title,
    speakers: who,
    rarity: rarest(who),
  };

  // Several villagers: one line for all of them. Several worktrees of
  // one villager (sheldon, sheldon-2) are still them talking.
  if (who.length > 1) {
    return {
      ...shared,
      line: null,
      words: null,
      detail: kind === "out" ? landedSummary(moving) : null,
      branch: null,
    };
  }

  // With twins, the branch named is the first one's.
  const [worktree] = moving;
  const [speaker] = who;
  return {
    ...shared,
    line: villagerLine(speaker, title),
    words:
      speaker.rarity === "common"
        ? null
        : (sayable(speaker.profile.quote) ??
          (kind === "in" ? "I'm moving in!" : "I'm moving out!")),
    detail: worktree.detached
      ? null
      : kind === "in"
        ? "Holding"
        : worktree.mergedIntoPrimary
          ? "Landed"
          : "Held",
    branch: worktree.detached ? null : worktree.branch,
  };
}

// All the news for one device's moves of one kind. A rare or legendary
// character's is theirs alone, even in a crowd (their dialogue box, or
// their letter), and every regular villager shares one. In the order to
// show them: rarest last, so it lands on top of the stack.
export function moveNewsFor(
  kind: MoveKind,
  worktrees: readonly MoveSubject[],
  speakers: ReadonlyMap<string, Speaker>,
  device?: string,
): MoveNews[] {
  const special = new Map<string, MoveSubject[]>();
  const regulars: MoveSubject[] = [];
  for (const worktree of worktrees) {
    const speaker = speakers.get(worktree.id);
    if (speaker === undefined) continue;
    if (speaker.rarity === "common") regulars.push(worktree);
    else
      special.set(speaker.slug, [
        ...(special.get(speaker.slug) ?? []),
        worktree,
      ]);
  }
  return [...special.values(), regulars]
    .flatMap((group) => {
      const news = moveNews(kind, group, speakers, device);
      return news === null ? [] : [news];
    })
    .toSorted((a, b) => RANK[a.rarity] - RANK[b.rarity]);
}
