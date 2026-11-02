// The one pointer's rest, so a control's warm waits for the pointer to
// stay.
let resting: ReturnType<typeof setTimeout> | undefined;

// Pointer handlers for a way into a page: `warm` starts the reads the
// page opens on once the pointer rests on it, so the page comes up
// whole. A pointer passing over on its way elsewhere warms nothing.
export function warmOnRest(warm: (() => void) | undefined) {
  return {
    onPointerEnter: () => {
      clearTimeout(resting);
      if (warm) resting = setTimeout(warm, 80);
    },
    onPointerLeave: () => clearTimeout(resting),
  };
}

// Click handlers that open on a mouse's press, as a native list
// selects, rather than on the release a click waits for. Keys, touch
// (where a press may start a scroll) and a modified click go by the
// click.
export function opensOnPress(open: () => void) {
  return {
    onPointerDown: (event: PressEvent) => {
      if (plainMousePress(event)) open();
    },
    onClick: (event: { nativeEvent: PressEvent }) => {
      if (!plainMousePress(event.nativeEvent)) open();
    },
  };
}

interface PressEvent {
  pointerType?: string;
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

function plainMousePress(event: PressEvent) {
  return (
    event.pointerType === "mouse" &&
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  );
}
