// Which sidebar layout the user picked, stored in the global state.json
// next to the collapse set and the sort preference: it's a display
// choice, not part of the project registry. "projects" is the implicit
// default, so an install that never touches the toggle reads back the
// classic tree without the key ever being written.
import { SidebarViewSchema, type SidebarView } from "@shared/schemas";
import { stateStore } from "../config/store";

const KEY = "sidebarView";

const IMPLICIT_VIEW: SidebarView = "projects";

// state.json is hand-editable, and packaged builds skip the IPC
// output-schema parse -- so an unrecognized value has to degrade to the
// classic tree here rather than reach the renderer's switch.
export function readSidebarView(): SidebarView {
  const raw = stateStore.readHint<unknown>(KEY, IMPLICIT_VIEW);
  const parsed = SidebarViewSchema.safeParse(raw);
  return parsed.success ? parsed.data : IMPLICIT_VIEW;
}

export function writeSidebarView(view: SidebarView): void {
  stateStore.writeKey<SidebarView>(KEY, view);
}
