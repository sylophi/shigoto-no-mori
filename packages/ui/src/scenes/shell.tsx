// The window's frame and the pages that are only the frame's: a fresh
// install's home, the forest on a phone, an address with nothing at it,
// a crash.
import { PhoneBackBarView } from "../views/AppShellView.tsx";
import { ErrorFallbackView } from "../views/ErrorFallbackView.tsx";
import { FirstRunView } from "../views/FirstRunView.tsx";
import { ForestPageView } from "../views/ForestPageView.tsx";
import { NotFoundPageView } from "../views/NotFoundPageView.tsx";
import { WhatsNewLinkView } from "../views/WhatsNewLinkView.tsx";
import { SceneWindowFrame } from "./frame.tsx";
import { SceneSidebar } from "./sidebar.tsx";

const noop = () => {};

// A fresh window with no project yet.
export function FirstRunScene() {
  return (
    <SceneWindowFrame>
      <FirstRunView onAdd={noop} />
    </SceneWindowFrame>
  );
}

// The forest's tab on a wide window, which points at the sidebar.
export function ForestPageScene() {
  return (
    <SceneWindowFrame sidebar={<SceneSidebar view="projects" />}>
      <ForestPageView phone={false} sidebar={null} />
    </SceneWindowFrame>
  );
}

// The web shell on a phone: the inbox tab, every forest a peer of the
// browser, over the tab bar.
export function PhoneInboxScene() {
  return (
    <SceneWindowFrame window="phone">
      <ForestPageView
        phone
        sidebar={<SceneSidebar shell="web" view="inbox" footer={false} />}
      />
    </SceneWindowFrame>
  );
}

// A page stacked over the forest on a phone, with the way back to it,
// at an address with nothing there.
export function PhoneNotFoundScene() {
  return (
    <SceneWindowFrame
      window="phone"
      pathname="/nowhere"
      backBar={<PhoneBackBarView label="Inbox" onBack={noop} />}
    >
      <NotFoundPageView onHome={noop} />
    </SceneWindowFrame>
  );
}

// A view that crashed, and the update toast's link beside it.
export function CrashScene() {
  return (
    <div className="flex h-full flex-col bg-background">
      <ErrorFallbackView
        error={new Error("Cannot read properties of undefined (reading 'id')")}
        scope="view"
        action={{ label: "Reload", onClick: noop }}
      />
      <p className="p-4 text-xs text-muted-foreground">
        v2.1.0 is available. <WhatsNewLinkView onOpen={noop} />
      </p>
    </div>
  );
}
