import { ExternalLink } from "@/components/ui/external-link";

export function PortPoolLink({ children }: { children?: React.ReactNode }) {
  return (
    <ExternalLink
      href="https://github.com/dittofleet/port-pool"
      errorTitle="Couldn't open port-pool"
    >
      {children}
    </ExternalLink>
  );
}
