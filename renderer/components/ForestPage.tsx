// "/forest": the phone layout's home tab, the sidebar's forest as a
// page of its own. The very same Sidebar component the wide layout
// keeps beside the routed page, minus its footer (the tab bar carries
// that cluster), so a worktree row reads the same whichever layout
// draws it. The page marker lets doubutsu lift the rail's mint off it
// (doubutsu.css), so the page wears the canvas and its leaves like
// every other room. On a wide viewport the forest is the sidebar, so
// the page has nothing to show but a pointer to it. It stays put
// rather than redirecting: a phone turned to landscape crosses the
// breakpoint, and turning back should find the forest where it was.
import { Sidebar } from "@/components/sidebar/Sidebar";
import { CenteredMessage } from "@/components/ui/centered-message";
import { usePhoneLayout } from "@/hooks/ui/useViewport";

export function ForestPage() {
  const phone = usePhoneLayout();
  if (!phone) {
    return <CenteredMessage>Pick a worktree from the sidebar.</CenteredMessage>;
  }
  return (
    <div data-doubutsu-page="forest" className="flex h-full flex-col">
      <Sidebar footer={false} />
    </div>
  );
}
