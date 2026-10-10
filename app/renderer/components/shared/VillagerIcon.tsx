// A villager's bare face (VillagerIconView) by name slug.
import type { ComponentProps } from "react";
import { VillagerIconView } from "@shigomori/ui/views/shared/VillagerIconView.tsx";
import { useVillagerFace } from "@/hooks/villagers/useVillagers";

export function VillagerIcon({
  slug,
  ...props
}: { slug: string } & Omit<ComponentProps<typeof VillagerIconView>, "src">) {
  return <VillagerIconView src={useVillagerFace(slug)} {...props} />;
}
