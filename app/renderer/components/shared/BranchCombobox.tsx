// The branch picker (BranchComboboxView) over a project's branches,
// listed afresh each time it opens.
import { useQueryClient } from "@tanstack/react-query";
import {
  BranchComboboxView,
  type BranchComboboxProps,
} from "@shigomori/ui/views/shared/BranchComboboxView.tsx";
import { useBranches } from "@/hooks/git/useBranches";
import { useHostScope } from "@/hooks/remote/useHostScope";

export function BranchCombobox({
  projectId,
  ...props
}: BranchComboboxProps & { projectId: string | null }) {
  const { data: branches, isFetching } = useBranches(projectId);
  const queryClient = useQueryClient();
  const { keys } = useHostScope();
  return (
    <BranchComboboxView
      {...props}
      branches={branches}
      fetching={isFetching}
      onOpen={() => {
        if (projectId) {
          void queryClient.invalidateQueries({
            queryKey: keys.branches(projectId),
          });
        }
      }}
    />
  );
}
