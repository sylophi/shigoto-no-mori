import { BackButton } from "@/components/ui/back-button";

export function DiffNotFound({
  onBack,
  message,
}: {
  onBack: () => void;
  message: string;
}) {
  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-border px-6 pt-7 pb-4">
        <BackButton onClick={onBack} label="Back" />
      </header>
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        {message}
      </div>
    </div>
  );
}
