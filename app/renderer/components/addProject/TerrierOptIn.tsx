import { useOffersTerrier } from "@/hooks/terrier/useOffersTerrier";
import { TerrierOptInView } from "@shigomori/ui/views/addProject/TerrierOptInView.tsx";

// The box that adds the project to terrier too, shown only on a device
// that lists terrier's repos. The choice is the dialog's, so it outlives
// a change of mode or device.
export function TerrierOptIn({
  checked,
  onCheckedChange,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const offered = useOffersTerrier();
  if (!offered) return null;
  return (
    <TerrierOptInView checked={checked} onCheckedChange={onCheckedChange} />
  );
}
