// The app frames (components/AppFrame.astro): scales each scene from
// its natural size to the frame's width, and places the pins over a
// frame on the parts of the scene they point at. Without this script a
// scene shows at its natural size, cut to the frame, and pins stay
// hidden.

// Where a pin sits on the element it points at.
type Side = "top" | "bottom" | "left";

// How far off its element a pin sits, in the frame's pixels, so it
// doesn't cover what it points at.
const PIN_GAP = 6;

function placePins(figure: HTMLElement, surface: HTMLElement): void {
  const root = surface.shadowRoot;
  const view = figure.querySelector<HTMLElement>(".app-frame-view");
  if (!root || !view) return;
  const box = view.getBoundingClientRect();
  for (const pin of figure.querySelectorAll<HTMLElement>("[data-pin]")) {
    const target = root.querySelector(pin.dataset["pin"] ?? "");
    if (!target) continue;
    const rect = target.getBoundingClientRect();
    const side = (pin.dataset["side"] ?? "top") as Side;
    const x =
      side === "left" ? rect.left - PIN_GAP : rect.left + rect.width / 2;
    const y =
      side === "left"
        ? rect.top + rect.height / 2
        : side === "top"
          ? rect.top - PIN_GAP
          : rect.bottom + PIN_GAP;
    pin.style.setProperty("--x", `${((x - box.left) / box.width) * 100}%`);
    pin.style.setProperty("--y", `${((y - box.top) / box.height) * 100}%`);
    pin.classList.add("pin-placed");
  }
}

export function fitAppFrames(): void {
  for (const figure of document.querySelectorAll<HTMLElement>(".app-frame")) {
    const view = figure.querySelector<HTMLElement>(".app-frame-view");
    const surface = figure.querySelector<HTMLElement>(".app-surface");
    const width = Number(figure.dataset["width"]);
    if (!view || !surface || !width) continue;
    const fit = () => {
      surface.style.zoom = String(view.clientWidth / width);
      placePins(figure, surface);
    };
    new ResizeObserver(fit).observe(view);
  }
}
