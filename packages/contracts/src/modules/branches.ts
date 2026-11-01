import { defineContract, invoke, projectChange } from "../contract.ts";
import {
  CreateBranchPayloadSchema,
  DeleteBranchPayloadSchema,
  RenameAnyBranchPayloadSchema,
  VoidSchema,
} from "../schemas/index.ts";

export const branchesContract = defineContract(
  "branches",
  "host",
  invoke("create", CreateBranchPayloadSchema, VoidSchema, projectChange),
  invoke("rename", RenameAnyBranchPayloadSchema, VoidSchema, projectChange),
  invoke("delete", DeleteBranchPayloadSchema, VoidSchema, projectChange),
);
