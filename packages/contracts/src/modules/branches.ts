import { defineContract, invoke } from "../contract.ts";
import {
  CreateBranchPayloadSchema,
  DeleteBranchPayloadSchema,
  RenameAnyBranchPayloadSchema,
  VoidSchema,
} from "../schemas/index.ts";

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
