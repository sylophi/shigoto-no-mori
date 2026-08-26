// The web entry. Order is the whole point of this file: the bridge must
// sit on window.api before ANY renderer module evaluates, because
// several of them read the bridge at module scope (queryKeys' device
// id, the remote registry's local facts). A static import of the app
// would hoist above the install call, so the app boots through a
// dynamic import instead.
import { installWebBridge } from "./bridge/install";

installWebBridge();

void import("./app/boot");
