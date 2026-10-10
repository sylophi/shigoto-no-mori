// The Settings page's frame and its few lines of its own, drawn
// (SettingsForm.tsx binds them).
import type { ReactNode } from "react";
import { ScrollText } from "lucide-react";
import { PageHeaderView } from "../shared/PageHeaderView.tsx";
import { PAGE_BODY } from "../shared/PageShellView.tsx";
import { ErrorBanner } from "../../primitives/error-banner.tsx";
import { SectionHeading } from "../../primitives/section-heading.tsx";
import {
  BuildVersionLineView,
  ChangelogButtonView,
} from "./VersionSectionView.tsx";

// The header names the section the sidebar picked. A section that is a
// room of its own (Visitors) also names the watermark and the
// wallpaper (data-doubutsu-page) it wears in place of the settings
// ones.
export type SettingsHeading = {
  eyebrow: string;
  title: string;
  watermark?: string;
  page?: string;
};

export function SettingsPageView({
  heading,
  tabs,
  chips,
  saveError,
  footer,
  children,
}: {
  heading: SettingsHeading;
  // The device tab bar, on a host section.
  tabs: ReactNode;
  // The phone layout's section chips.
  chips: ReactNode;
  // The local save's failure. It spans several sections, so it shows
  // above the footer where every section can see it. Peer saves report
  // inside their own section.
  saveError: string | null;
  footer: ReactNode;
  // The sections' panels.
  children: ReactNode;
}) {
  return (
    // The page marker picks the settings wallpaper (doubutsu.css), the
    // same one the loading skeleton wears. Visitors wears its own.
    <div
      data-doubutsu-page={heading.page ?? "settings"}
      className="flex h-full flex-col"
    >
      <PageHeaderView
        eyebrow={heading.eyebrow}
        title={heading.title}
        watermark={heading.watermark ?? "設定"}
        tabs={tabs}
      />
      {chips}
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      {saveError !== null && (
        <div className="px-6 pb-3">
          <ErrorBanner message={saveError} title="Couldn't save settings" />
        </div>
      )}
      {footer}
    </div>
  );
}

// A host section with no machine to show.
export function NoDevicesView() {
  return (
    <div className={PAGE_BODY}>
      <p className="text-sm text-muted-foreground">
        No devices on this account yet.
      </p>
    </div>
  );
}

// The build this hostless client runs, and the changelog measured
// against it.
export function ClientVersionSectionView({
  version,
  commit,
  onOpenChangelog,
  changelog,
}: {
  // This build's version and commit.
  version: string;
  commit: string;
  onOpenChangelog: () => void;
  changelog: ReactNode;
}) {
  return (
    <section className="space-y-3">
      <SectionHeading className="mb-1">Web client</SectionHeading>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="font-mono text-sm select-text">
          <BuildVersionLineView version={version} commit={commit} />
        </div>
        <ChangelogButtonView
          icon={ScrollText}
          label="Changelog"
          onOpen={onOpenChangelog}
        />
      </div>
      {changelog}
    </section>
  );
}
