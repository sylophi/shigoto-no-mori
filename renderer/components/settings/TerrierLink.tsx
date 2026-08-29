import { ExternalLink } from "@/components/ui/external-link";

export function TerrierLink({ children }: { children?: React.ReactNode }) {
  return (
    <ExternalLink
      href="https://github.com/sylophi/terrier"
      errorTitle="Couldn't open terrier"
    >
      {children}
    </ExternalLink>
  );
}
