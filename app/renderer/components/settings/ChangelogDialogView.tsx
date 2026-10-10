import type { ReactNode } from "react";
import { ExternalLink, ScrollText, Sparkles } from "lucide-react";
import { errorMessageOf } from "@shigomori/contracts/errors";
import type { Release } from "@shigomori/contracts/schemas";
import {
  RELEASES_PAGE_URL,
  changelogFor,
  isBetween,
  releaseVersionOf,
} from "@shared/releases";
import { Button } from "@shigomori/ui/primitives/button.tsx";
import { IconButton } from "@shigomori/ui/primitives/icon-button.tsx";
import { LoadFailure } from "@shigomori/ui/primitives/load-failure.tsx";
import { Markdown } from "@shigomori/ui/primitives/markdown.tsx";
import { RowTag } from "@shigomori/ui/primitives/row-tag.tsx";
import { Skeleton } from "@shigomori/ui/primitives/skeleton.tsx";
import { TONE_PILL } from "@shigomori/ui/primitives/status-dot.tsx";
import { openExternalUrl } from "@/lib/openExternal";
import { pluralize } from "@/lib/pluralize";
import {
  FlowBodyView,
  FlowFooterView,
  FlowHeaderView,
} from "../worktreeDetail/flow/FlowChromeView";

// The update the preview is of: the version it brings, and the notes
// the update feed sent with it when there are any (the stand-in when
// GitHub can't be reached).
export type StagedUpdate = { version: string; notes?: string };

// The app's changelog, read from its GitHub releases and measured
// against one device, whose release is marked. With news it is only
// the news instead: with an update staged, what it brings (every
// release after the device's up to the staged one, however many that
// jumps), with the restart beside it, and right after an update, what
// that one brought. The whole changelog is the Changelog link's.
// The dialog's content (ChangelogDialog puts it in a ModalShell).
export function ChangelogDialogView({
  installed,
  staged,
  updatedFrom,
  restartButton,
  releases,
  onClose,
}: {
  // The device's version in either spelling ("v2.15.0" or "2.15.0"),
  // and "" or "dev" when it has none to measure against.
  installed: string;
  staged: StagedUpdate | null;
  // The release this build just replaced (UpdateNews), for the
  // releases the update brought.
  updatedFrom?: string;
  // The caller's own update action, so the preview updates the same
  // way (and with the same confirm) as the surface it opened from.
  restartButton?: ReactNode;
  // The app's releases on GitHub, as far as they have come.
  releases: {
    data: readonly Release[] | undefined;
    isError: boolean;
    error: unknown;
    onRetry: () => void;
  };
  onClose: () => void;
}) {
  const version = releaseVersionOf(installed);
  // What's new: the releases after `from` up to `to`.
  const news =
    updatedFrom !== undefined
      ? { from: releaseVersionOf(updatedFrom), to: version }
      : staged !== null
        ? { from: version, to: staged.version }
        : null;
  const entries =
    releases.data === undefined
      ? undefined
      : changelogFor(releases.data, version, staged?.version ?? null);
  const shown =
    news === null
      ? entries
      : entries?.filter((entry) =>
          isBetween(entry.version, news.from, news.to),
        );
  // GitHub out of reach, or its list without the release: the preview
  // still has the staged release's own notes, which the update feed
  // delivered with it.
  const fallback: Release[] | undefined =
    news !== null && staged?.notes && (releases.isError || shown?.length === 0)
      ? [
          {
            version: staged.version,
            notes: staged.notes,
            publishedAt: null,
            prerelease: false,
            url: `${RELEASES_PAGE_URL}/tag/v${staged.version}`,
          },
        ]
      : undefined;
  const list = fallback ?? shown;

  return (
    <>
      <FlowHeaderView
        tint={TONE_PILL[news === null ? "slate" : "sky"]}
        icon={news === null ? ScrollText : Sparkles}
        title={news === null ? "Changelog" : "What's new"}
        actions={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="All releases on GitHub"
            onClick={() => openExternalUrl(RELEASES_PAGE_URL)}
          >
            <ExternalLink />
          </Button>
        }
        onClose={onClose}
      >
        <p>{subtitle(version, news, list?.length)}</p>
      </FlowHeaderView>
      <FlowBodyView>
        {list !== undefined ? (
          list.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No release notes to show.
            </p>
          ) : (
            <ol className="space-y-8">
              {list.map((entry) => (
                <ReleaseEntry
                  key={entry.version}
                  entry={entry}
                  installed={entry.version === version}
                />
              ))}
            </ol>
          )
        ) : releases.isError ? (
          <LoadFailure
            message={`Couldn't load the changelog. ${errorMessageOf(releases.error)}`}
            onRetry={releases.onRetry}
          />
        ) : (
          <LoadingEntries />
        )}
      </FlowBodyView>
      {restartButton && <FlowFooterView>{restartButton}</FlowFooterView>}
    </>
  );
}

// Under the title: how far a jump over several releases goes, else the
// device's version.
function subtitle(
  version: string,
  news: { from: string; to: string } | null,
  count: number | undefined,
): string {
  if (news !== null && news.from !== "" && count !== undefined && count > 1) {
    return `${pluralize(count, "release")}, up to v${news.to}`;
  }
  return version === ""
    ? "From the app's releases on GitHub"
    : `Installed: v${version}`;
}

// One release: its version, marked when it is the build the device
// runs (the list is newest first, so everything above it is newer),
// its date and its notes.
function ReleaseEntry({
  entry,
  installed,
}: {
  entry: Release;
  installed: boolean;
}) {
  return (
    <li className="space-y-2">
      <header className="flex items-center gap-2">
        <h3 className="font-mono text-sm font-semibold">v{entry.version}</h3>
        {installed && <RowTag>Installed</RowTag>}
        {entry.prerelease && <RowTag>Prerelease</RowTag>}
        <span className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
          {entry.publishedAt !== null && (
            <time dateTime={entry.publishedAt}>
              {new Date(entry.publishedAt).toLocaleDateString(undefined, {
                dateStyle: "medium",
              })}
            </time>
          )}
          <IconButton
            aria-label={`v${entry.version} on GitHub`}
            onClick={() => openExternalUrl(entry.url)}
          >
            <ExternalLink className="size-3.5" />
          </IconButton>
        </span>
      </header>
      <Markdown
        source={withoutCompareLink(entry.notes)}
        className="text-foreground/90"
      />
    </li>
  );
}

// GitHub's generated notes end on a "**Full Changelog**: <compare
// URL>" line. The entry's own GitHub button already leads there, and
// in a list of releases the line repeats under every one.
function withoutCompareLink(notes: string): string {
  return notes.replace(/\n*\*\*Full Changelog\*\*:\s*\S+\s*$/, "");
}

function LoadingEntries() {
  return (
    <div className="space-y-6">
      {[0, 1].map((index) => (
        <div key={index} className="space-y-2">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-3.5 w-full" />
          <Skeleton className="h-3.5 w-5/6" />
          <Skeleton className="h-3.5 w-2/3" />
        </div>
      ))}
    </div>
  );
}
