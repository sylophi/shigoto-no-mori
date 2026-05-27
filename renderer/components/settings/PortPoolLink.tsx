import { notifyError } from "@/lib/toast";

export function PortPoolLink({ children }: { children?: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        window.api.shell
          .openExternal("https://github.com/sylophi/port-pool")
          .catch((err) => notifyError("Couldn't open port-pool", err));
      }}
      className="underline underline-offset-2 hover:text-foreground"
    >
      {children ?? "Learn more"}
    </button>
  );
}
