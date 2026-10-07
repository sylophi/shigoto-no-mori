import { defineContract, invoke } from "@shared/ipc/contract";
import {
  CreateBranchPayloadSchema,
  DeleteBranchPayloadSchema,
  RenameAnyBranchPayloadSchema,
  VoidSchema,
} from "@shared/schemas";

export const branchesContract = defineContract("host", {
  create: invoke("branches:create", CreateBranchPayloadSchema, VoidSchema, {
    tracksProjectUsage: true,
    remote: true,
    gated: true,
  }),
  rename: invoke("branches:rename", RenameAnyBranchPayloadSchema, VoidSchema, {
    tracksProjectUsage: true,
    remote: true,
    gated: true,
  }),
  delete: invoke("branches:delete", DeleteBranchPayloadSchema, VoidSchema, {
    tracksProjectUsage: true,
    remote: true,
    gated: true,
  }),
});
