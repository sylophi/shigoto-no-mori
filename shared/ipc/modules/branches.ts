import { z } from "zod";
import { defineContract, invoke } from "@shared/ipc/contract";
import {
  CreateBranchPayloadSchema,
  DeleteBranchPayloadSchema,
  RenameAnyBranchPayloadSchema,
} from "@shared/schemas";

export const branchesContract = defineContract("host", {
  create: invoke("branches:create", CreateBranchPayloadSchema, z.void(), {
    tracksProjectUsage: true,
    remote: true,
  }),
  rename: invoke("branches:rename", RenameAnyBranchPayloadSchema, z.void(), {
    tracksProjectUsage: true,
    remote: true,
  }),
  delete: invoke("branches:delete", DeleteBranchPayloadSchema, z.void(), {
    tracksProjectUsage: true,
    remote: true,
  }),
});
