import { useNavigate, useRouter } from "@tanstack/react-router";

// Back to wherever the page was opened from, for a page's Back or
// Cancel. A window that opened straight onto the page has nothing
// behind it and goes to "/", the same place a fresh window opens, and
// so does `home`: a page whose work may have removed the page behind
// it (a batch that deleted or moved worktrees).
export function useGoBack({ home = false } = {}): () => void {
  const navigate = useNavigate();
  const router = useRouter();
  return () =>
    !home && router.history.canGoBack()
      ? router.history.back()
      : void navigate({ to: "/" });
}
