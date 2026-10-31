import { GithubMark } from "../../primitives/svgs/github-mark.tsx";
import { IconButton } from "../../primitives/icon-button.tsx";
import { SimpleTooltip } from "../../primitives/tooltip.tsx";
import { useOutside } from "../../outside.tsx";

// The repo's page on GitHub, on the header's branch line, opened on the
// device the page is viewed from.
export function GithubLinkView({ url }: { url: string }) {
  const { openUrl } = useOutside();
  return (
    <SimpleTooltip tip="Open on GitHub">
      <IconButton
        onClick={() => openUrl(url, "Couldn't open GitHub")}
        aria-label="Open on GitHub"
      >
        <GithubMark aria-hidden className="size-3.5" />
      </IconButton>
    </SimpleTooltip>
  );
}
