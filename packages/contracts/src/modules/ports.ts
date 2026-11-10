import { defineContract, invoke, view, ungated } from "../contract.ts";
import {
  WorktreeScopedPayloadSchema,
  WorktreePortsResultSchema,
} from "../schemas/index.ts";

// A worktree's ports, as one host read: port-pool's allocation for the
// directory plus the user-added entries in the worktree's data, each
// probed on the host's loopback so the list says which have a server up.
//
// A read, not a command: it moves nothing and reveals only whether a
// port the worktree itself lists is open on 127.0.0.1. The caller never
// names a port, which is what keeps this from being a loopback scanner
// a read-only peer could drive. The two ways a port gets onto the list
// (port-pool provisioning, a worktreeData write) are the host's own
// doing or a granted peer's.
export const portsContract = defineContract(
  "ports",
  { scope: "host", version: 1 },
  invoke(
    "list",
    WorktreeScopedPayloadSchema,
    WorktreePortsResultSchema,
    ungated,
  ),
  view(
    "watch",
    WorktreeScopedPayloadSchema,
    WorktreePortsResultSchema,
    ungated,
  ),
);
