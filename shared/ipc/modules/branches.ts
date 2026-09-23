import { Schema } from "effect";
import { defineContract, invoke } from "@shared/ipc/contract";
import {
  CreateBranchPayloadSchema,
  DeleteBranchPayloadSchema,
  RenameAnyBranchPayloadSchema,
} from "@shared/schemas";

export const branchesContract = defineContract("host", {
  create: invoke(
    "branches:create",
    CreateBranchPayloadSchema,
    Schema.Undefined,
    {
      tracksProjectUsage: true,
      remote: true,
      mutating: true,
    },
  ),
  rename: invoke(
    "branches:rename",
    RenameAnyBranchPayloadSchema,
    Schema.Undefined,
    {
      tracksProjectUsage: true,
      remote: true,
      mutating: true,
    },
  ),
  delete: invoke(
    "branches:delete",
    DeleteBranchPayloadSchema,
    Schema.Undefined,
    {
      tracksProjectUsage: true,
      remote: true,
      mutating: true,
    },
  ),
});
