// The transplant dialog at its review step, as "Transplant to..." opens
// it on brave-badger (fix-stale-locks on the Studio Mac): bound for the
// Thinkpad, the one peer that is connected, with Mini and Work PC
// listed off. The dialog's box alone, at the live one's width. A
// backdrop (TransplantDialogView's) draws it over a window instead.
import { TransplantDialogView } from "@/components/worktreeDetail/transplant/TransplantDialogView";
import { THINKPAD_ID } from "../fixtures";
import { transplantReviewOf } from "./world";

export function TransplantScene() {
  return (
    <div data-slot="transplant-dialog" className="w-4xl">
      <TransplantDialogView
        {...transplantReviewOf("5a0000000003", THINKPAD_ID)}
      />
    </div>
  );
}
