// Fixture: a "lib" file reaching upward into ipc via a relative path.
// Triggers `lib-upward-import` (relative specifier is resolved first).
import { foo } from "../../main/ipc/register";

export const x = foo;
