import { useNavigate, useRouter } from "@tanstack/react-router";

// Back to wherever the page was opened from, for a page's Back or
// Cancel. A window that opened straight onto the page has nothing
// behind it and goes to "/", the same place a fresh window opens.
export function useGoBack(): () => void {
  const navigate = useNavigate();
  const router = useRouter();
  return () =>
    router.history.canGoBack()
      ? router.history.back()
      : void navigate({ to: "/" });
}
