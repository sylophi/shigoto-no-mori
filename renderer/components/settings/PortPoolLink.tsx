import { ExternalLink } from "@/components/ui/external-link";

export function PortPoolLink({ children }: { children?: React.ReactNode }) {
  return (
    <ExternalLink
      href="https://github.com/sylophi/port-pool"
      errorTitle="Couldn't open port-pool"
    >
      {children}
    </ExternalLink>
  );
}
