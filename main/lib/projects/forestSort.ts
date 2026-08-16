// How the user likes to read the forest, stored in the global state.json
// beside the project sort and the sidebar layout -- it's a display
// choice, not part of the project registry. "activity" is the implicit
// default, so an install that never touches the menu reads back the
// recency order without the key ever being written.
import { ForestSortSchema, type ForestSort } from "@shared/schemas";
import { stateStore } from "../config/store";

const KEY = "forestSort";

const IMPLICIT_SORT: ForestSort = "activity";

// state.json is hand-editable, and packaged builds skip the IPC
// output-schema parse -- so an unrecognized value has to degrade to the
// default here rather than reach the renderer's switch.
export function readForestSort(): ForestSort {
  const raw = stateStore.readHint<unknown>(KEY, IMPLICIT_SORT);
  const parsed = ForestSortSchema.safeParse(raw);
  return parsed.success ? parsed.data : IMPLICIT_SORT;
}

export function writeForestSort(sort: ForestSort): void {
  stateStore.writeKey<ForestSort>(KEY, sort);
}
