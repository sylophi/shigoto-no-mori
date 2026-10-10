// Village life over the fixtures: the Visitors album with its guest
// book, and the pieces villagers appear in elsewhere: a birthday on a
// worktree page, a move's toast, a rare villager's dialogue box and a
// legend's letter. Faces are the scenes' stand-in (world.ts FACE): the
// villager data is a download the fixtures don't hold.
import type { ReactNode } from "react";
import { SettingsPageView } from "@/components/settings/SettingsFormView";
import { VISITORS_TAB } from "@/components/settings/settingsSections";
import { BirthdayBadgeView } from "@shigomori/ui/views/villagers/BirthdayBadgeView.tsx";
import {
  BirthdayFaceView,
  PartyFaceView,
} from "@shigomori/ui/views/villagers/BirthdayFaceView.tsx";
import { BirthdayPartyView } from "@shigomori/ui/views/villagers/BirthdayPartyView.tsx";
import {
  BalloonsView,
  BuntingView,
  ConfettiView,
} from "@shigomori/ui/views/villagers/CelebrationView.tsx";
import { MovingBoxView } from "@shigomori/ui/views/villagers/MovingBoxView.tsx";
import { NextArrowView } from "@shigomori/ui/views/villagers/NextArrowView.tsx";
import { ResidentFaceView } from "@shigomori/ui/views/villagers/ResidentFaceView.tsx";
import { StationeryPrintView } from "@shigomori/ui/views/villagers/StationeryPrintView.tsx";
import { TypedWordsView } from "@shigomori/ui/views/villagers/TypedWordsView.tsx";
import {
  MoveDetailView,
  MovingBoxBadgeView,
  SuccessBadgeView,
  TickingTitleView,
  ToastFacesView,
  VillageToasterView,
} from "@shigomori/ui/views/villagers/VillageToastsView.tsx";
import {
  DialogueFrameView,
  MoveCaptionView,
  NameplateView,
  VillagerDialogueView,
} from "@shigomori/ui/views/villagers/VillagerDialogueView.tsx";
import {
  FaceStampView,
  VillagerLetterView,
} from "@shigomori/ui/views/villagers/VillagerLetterView.tsx";
import { GuestBookView } from "@shigomori/ui/views/visitors/GuestBookView.tsx";
import { VisitorSlotView } from "@shigomori/ui/views/visitors/VisitorStickerView.tsx";
import {
  AlbumSectionView,
  AlbumSkeletonView,
  NobodyYetView,
  StartOverView,
  VisitorsSectionView,
} from "@shigomori/ui/views/visitors/VisitorsSectionView.tsx";
import type { MoveNews, Speaker } from "@shigomori/ui/lib/villagerVoice.ts";
import { stationeryFor } from "@shigomori/ui/lib/villagers/stationery.ts";
import { buildAlbum, sortAlbum } from "@shigomori/ui/lib/villagers/visitors.ts";
import { villagerRarity } from "@shigomori/ui/lib/villagers/rarity.ts";
import {
  FAKE_VILLAGER_PROFILES,
  fakeVisitTally,
} from "../fake-host/villagerFixtures";
import { SceneWindowFrame } from "./frame";
import { settingsSidebar } from "./settings";
import { FACE } from "./world";

const noop = () => {};
const ALBUM = buildAlbum(FAKE_VILLAGER_PROFILES, fakeVisitTally());

const SECTIONS = [
  { rarity: "legendary", title: "Legends" },
  { rarity: "rare", title: "Special guests" },
  { rarity: "common", title: "Villagers" },
] as const;

// The Visitors album: who has come, sorted by visits, and who is still
// to meet in the sections that fold.
export function VisitorsScene() {
  return (
    <SceneWindowFrame
      sidebar={settingsSidebar(VISITORS_TAB)}
      pathname="/settings"
    >
      <SettingsPageView
        heading={{
          eyebrow: "Village life",
          title: "Visitors",
          watermark: "来客",
          page: "visitors",
        }}
        tabs={null}
        chips={null}
        saveError={null}
        footer={null}
      >
        <div className="flex flex-col gap-10 p-6">
          <VisitorsSectionView
            metTotal={ALBUM.metTotal}
            guestBook={
              <GuestBookView
                album={ALBUM}
                bestFriendFace={FACE}
                newestFace={FACE}
              />
            }
            sort="visits"
            onSort={noop}
            folding
            everyone={false}
            onToggleEveryone={noop}
            sections={SECTIONS.map(({ rarity, title }) => {
              const entries = sortAlbum(ALBUM.sections[rarity], "visits");
              const met = ALBUM.met[rarity];
              const open = rarity === "legendary" ? null : false;
              const shown = open === false ? entries.slice(0, met) : entries;
              return (
                <AlbumSectionView
                  key={rarity}
                  title={title}
                  total={entries.length}
                  met={met}
                  open={open}
                  onOpen={noop}
                  slots={shown.map((entry, index) => (
                    <VisitorSlotView
                      key={entry.slug}
                      entry={entry}
                      index={index}
                      bestFriend={entry.slug === ALBUM.bestFriend?.slug}
                      face={entry.visits === null ? null : FACE}
                    />
                  ))}
                />
              );
            })}
            startOver={<StartOverView armed={false} onReset={noop} />}
          />
        </div>
      </SettingsPageView>
    </SceneWindowFrame>
  );
}

function speaker(slug: string, color: string | null = "#c27a3e"): Speaker {
  const profile = FAKE_VILLAGER_PROFILES[slug];
  if (profile === undefined) throw new Error(`no fixture villager ${slug}`);
  return {
    slug,
    profile,
    rarity: villagerRarity(slug, profile),
    face: FACE,
    color,
  };
}

const RAYMOND = speaker("raymond");
const LEIF = speaker("leif", "#5aa05a");
const ISABELLE = speaker("isabelle", "#e8c27a");

function news(who: Speaker, words: string | null): MoveNews {
  return {
    kind: "in",
    worktreeIds: ["wt_sm_hum"],
    device: null,
    title: `${who.profile.name} moved in`,
    line: null,
    words,
    detail: "Held",
    branch: "v2-exp/remote-ui-flows",
    speakers: [who],
    rarity: who.rarity,
  };
}

function Part({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-3">
      <h2 className="text-xs text-muted-foreground">{label}</h2>
      {children}
    </section>
  );
}

// Where villagers show up: a birthday party on a worktree page, the
// toasts their moves send, a rare villager's dialogue box, a legend's
// letter, and the album empty and loading.
export function VillagersPartsScene() {
  const resident = { ...RAYMOND, birthday: true };
  return (
    <div className="grid h-full grid-cols-2 gap-8 overflow-hidden bg-background p-6 text-foreground">
      <div className="flex min-w-0 flex-col gap-8">
        <Part label="A birthday">
          <div className="relative h-40 overflow-hidden rounded-xl border border-border">
            <BuntingView color={RAYMOND.color} />
            <BalloonsView />
            <ConfettiView />
            <div className="flex items-center gap-3 p-6 pt-8">
              <ResidentFaceView resident={resident} party />
              <BirthdayBadgeView resident={resident} />
              <BirthdayPartyView villager={resident} />
            </div>
          </div>
          <div className="flex items-center gap-4">
            <BirthdayFaceView face={FACE} className="size-10" />
            <PartyFaceView face={FACE} rarity="rare" className="size-10" />
            <FaceStampView
              face={FACE}
              tint={stationeryFor("isabelle").color}
              className="size-14"
            />
            <MovingBoxView className="w-10" />
            <NextArrowView />
          </div>
        </Part>
        <Part label="A move's toast">
          <VillageToasterView onDismiss={noop}>
            <div className="flex w-80 items-start gap-3 rounded-lg border border-border bg-popover p-3">
              <ToastFacesView
                faces={[
                  { ...RAYMOND, face: FACE },
                  { ...speaker("judy"), face: FACE },
                ]}
                badge={<SuccessBadgeView />}
                joined={new Set(["judy"])}
              />
              <div className="min-w-0 flex-1 text-sm">
                <TickingTitleView>Raymond and Judy moved in</TickingTitleView>
                <MoveDetailView
                  detail="Held v2-exp/remote-ui-flows"
                  branch={null}
                />
              </div>
            </div>
          </VillageToasterView>
          <ToastFacesView
            faces={[{ ...speaker("sherb"), face: FACE }]}
            badge={<MovingBoxBadgeView />}
            joined={new Set()}
          />
        </Part>
        <Part label="The album, empty and loading">
          <NobodyYetView face={FACE} />
          <AlbumSkeletonView />
        </Part>
      </div>
      <div className="flex min-w-0 flex-col gap-8">
        <Part label="A special guest moves in">
          <VillagerDialogueView
            news={news(LEIF, "I'm here to help the place grow!")}
            speaker={LEIF}
            words="I'm here to help the place grow!"
          />
          <DialogueFrameView name="Isabelle" color={null}>
            <p className="text-sm font-medium">
              <TypedWordsView words="Good morning! Here's today's news." />
            </p>
          </DialogueFrameView>
          <NameplateView>Raymond</NameplateView>
          <MoveCaptionView news={news(RAYMOND, null)} ink="#c27a3e" />
        </Part>
        <Part label="A legend writes">
          <VillagerLetterView
            news={news(ISABELLE, "Welcome to the island!")}
            speaker={ISABELLE}
            words="Welcome to the island!"
          />
          <div className="relative h-24 overflow-hidden rounded-lg">
            <StationeryPrintView paper={stationeryFor("raymond")} still />
          </div>
        </Part>
      </div>
    </div>
  );
}
