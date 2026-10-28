import { codeSignIn } from "@/hooks/account/useEnrollment";
import { useExternalStore } from "@shigomori/ui/lib/externalStore.ts";
import { ModalShell } from "@shigomori/ui/primitives/modal-shell.tsx";
import { CodeSignInDialogView } from "@shigomori/ui/views/account/CodeSignInDialogView.tsx";

const close = () => codeSignIn.publish(null);

// Up while a sign-in with a code waits on its approval. Closing it
// drops the sign-in.
export function CodeSignInDialog() {
  const code = useExternalStore(codeSignIn);
  if (code === null) return null;
  return (
    <ModalShell label="Sign in with a code" onClose={close}>
      <CodeSignInDialogView
        code={code.userCode}
        url={code.verificationUriComplete ?? code.verificationUri}
        onCancel={close}
      />
    </ModalShell>
  );
}
