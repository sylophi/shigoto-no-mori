import { defineContract, invoke, trackedCodeChange } from "../contract.ts";
import {
  CreateBranchPayloadSchema,
  DeleteBranchPayloadSchema,
  RenameAnyBranchPayloadSchema,
  VoidSchema,
} from "../schemas/index.ts";

export const branchesContract = defineContract(
  "branches",
  "host",
  invoke("create", CreateBranchPayloadSchema, VoidSchema, trackedCodeChange),
  invoke("rename", RenameAnyBranchPayloadSchema, VoidSchema, trackedCodeChange),
  invoke("delete", DeleteBranchPayloadSchema, VoidSchema, trackedCodeChange),
);
