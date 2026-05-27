import { z } from "zod";
import { invoke } from "@shared/ipc/contract";
import {
  CreateBranchPayloadSchema,
  DeleteBranchPayloadSchema,
  RenameAnyBranchPayloadSchema,
} from "@shared/schemas";

export const branchesContract = {
  create: invoke("branches:create", CreateBranchPayloadSchema, z.void()),
  rename: invoke("branches:rename", RenameAnyBranchPayloadSchema, z.void()),
  delete: invoke("branches:delete", DeleteBranchPayloadSchema, z.void()),
} as const;

export type BranchesContract = typeof branchesContract;
