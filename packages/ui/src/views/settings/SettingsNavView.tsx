// The Settings page's navigation, drawn (SettingsSidebarNav.tsx and
// SettingsSectionChips.tsx bind it): the sidebar's list and the phone
// layout's chip row.
import type { ReactNode } from "react";
import { ChipButton } from "../../primitives/chip-button.tsx";
import { SectionHeading } from "../../primitives/section-heading.tsx";
import { UpdateMark } from "../../primitives/status-dot.tsx";
import { cn } from "../../lib/utils.ts";
import type { SettingsSection } from "./settingsSections.ts";

export type SettingsSectionLists = {
  client: SettingsSection[];
  host: SettingsSection[];
};

// A row leading to a page beside Settings (the account, Tidy).
export type SettingsPageRow = {
  section: SettingsSection;
  active: boolean;
  onSelect: () => void;
};

// The Settings page's navigation, drawn in the app sidebar in place of
// the project tree while Settings or one of its pages is open
// (SidebarTakeover, which also draws the Back row above it). On a
// desktop the account leads, on a row of its own, then two labelled
// groups: "Client" holds what this window shows and nothing else ever
// sees, and "Host" what each machine stores (its device, worktree and
// integration settings) and what spans its projects (Tidy). Every host
// page picks its machine with the device tab bar in its header, one
// pick for them all (settingsNav), so the list never grows with the
// account. The split is the page's whole point, so the list shows it
// rather than a panel explaining it. The sections come from
// settingsSections, which the phone layout's chip row draws too.
//
// The account and Tidy are pages of their own (the account's sign-in
// and device registry, Tidy's removals) rather than forms, so they
// keep their routes and share this list (SettingsPages). Stepping
// between them and Settings replaces the entry rather than pushing
// one, so one step back still leaves Settings, whichever of them it
// lands on. A hostless client offers neither: its account page is its
// home, and it has no forest of its own to tidy.
export function SettingsSidebarNavView({
  sections,
  activeId,
  controls,
  onSelect,
  account,
  tidy,
}: {
  sections: SettingsSectionLists;
  // The section showing, null while a page beside Settings is open.
  activeId: string | null;
  // The panel a section's row shows.
  controls: (id: string) => string | undefined;
  onSelect: (id: string) => void;
  // The pages beside Settings, a desktop's only.
  account: SettingsPageRow | null;
  tidy: SettingsPageRow | null;
}) {
  const row = (section: SettingsSection) => (
    <NavRow
      key={section.id}
      section={section}
      active={activeId === section.id}
      controls={controls(section.id)}
      onSelect={() => onSelect(section.id)}
    />
  );
  return (
    <nav aria-label="Settings sections" className="flex flex-col px-2 pb-2">
      {account && (
        <div className="pt-3">
          <NavRow {...account} />
        </div>
      )}

      <NavGroup label="Client">{sections.client.map(row)}</NavGroup>

      <NavGroup label="Host">
        {sections.host.map(row)}
        {tidy && <NavRow {...tidy} />}
      </NavGroup>
    </nav>
  );
}

// The same sections as one row of chips under the page header, for the
// phone layout, where no sidebar holds the list, scrolling sideways
// past the edge.
export function SettingsSectionChipsView({
  sections,
  activeId,
  controls,
  onSelect,
}: {
  sections: SettingsSectionLists;
  activeId: string;
  controls: (id: string) => string | undefined;
  onSelect: (id: string) => void;
}) {
  const chip = (section: SettingsSection) => {
    const active = activeId === section.id;
    return (
      <ChipButton
        key={section.id}
        aria-current={active ? "true" : undefined}
        aria-controls={controls(section.id)}
        onClick={() => onSelect(section.id)}
        className={cn(
          "max-w-48 shrink-0 py-1.5",
          active && "bg-accent text-foreground",
        )}
      >
        <SectionLabelView section={section} />
      </ChipButton>
    );
  };
  return (
    <nav
      aria-label="Settings sections"
      className="flex shrink-0 [scrollbar-width:none] gap-1.5 overflow-x-auto border-b border-border px-4 py-2"
    >
      {sections.client.map(chip)}
      {sections.host.map(chip)}
    </nav>
  );
}

// A section's icon and its name, the same in a sidebar row and in a
// phone chip. The General section, while a device holds a staged
// update, trails the sidebar Settings dot's own mark, so the dot that
// brought the visitor here points at the row it meant (and the tab bar
// there at the device).
function SectionLabelView({ section }: { section: SettingsSection }) {
  const Icon = section.icon;
  return (
    <>
      <Icon aria-hidden className="size-3.5 shrink-0" />
      <span className="truncate">{section.label}</span>
      {section.update && <UpdateMark className="ml-auto" />}
    </>
  );
}

// A labelled group of rows: the eyebrow is the scope, the page's own
// section heading at the sidebar's size so it reads as structure
// rather than as another row.
function NavGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <SectionHeading className="px-2 pt-3 pb-1 text-3xs text-muted-foreground/80">
        {label}
      </SectionHeading>
      {children}
    </div>
  );
}

// One row, with the sidebar rows' selection fill, so the list reads as
// the sidebar's rather than a foreign widget dropped in.
function NavRow({
  section,
  active,
  controls,
  onSelect,
}: {
  section: SettingsSection;
  active: boolean;
  // The settings panel the row shows. Tidy's and the account's rows
  // lead to pages.
  controls?: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-current={active ? "true" : undefined}
      aria-controls={controls}
      onClick={onSelect}
      className={cn(
        "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent/60",
        active
          ? "bg-accent font-medium text-accent-foreground"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      <SectionLabelView section={section} />
    </button>
  );
}
