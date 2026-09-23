// The desktop window's entry: build window.api from the preload's
// bridge, then boot the renderer. Order is the whole point of this
// file, as in web/main.tsx: the api must sit on window.api before ANY
// renderer module evaluates, because several of them read it at
// module scope (queryKeys' device id, the remote registry's local
// facts). A static import of the boot would hoist above the install
// call, so it goes through a dynamic import.
import { installElectronApi } from "./electronApi";

installElectronApi();

void import("./electronBoot");
