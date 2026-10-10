// Turn each live frame (Frame.astro's `live`) into the real app over
// the fixture world as it comes near the screen. The app and the
// fixtures load with the first one, in chunks of their own, so a page
// with no live frame near the screen loads neither.
export function liveFramesNearScreen(): void {
  const near = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        near.unobserve(entry.target);
        void goLive(entry.target as HTMLElement);
      }
    },
    { rootMargin: "50% 0px" },
  );
  for (const frame of document.querySelectorAll("[data-live]")) {
    near.observe(frame);
  }
}

async function goLive(root: HTMLElement): Promise<void> {
  const { mountFrame } =
    await import("shigoto-no-mori/lab/fake-host/frames.tsx");
  // A window to use rather than a picture of one.
  root.inert = false;
  root.closest("figure")?.removeAttribute("role");
  await mountFrame(root, root.dataset["live"] ?? "/");
}
