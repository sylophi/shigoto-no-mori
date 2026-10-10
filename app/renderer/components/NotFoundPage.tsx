import { useNavigate } from "@tanstack/react-router";
import { NotFoundPageView } from "@shigomori/ui/views/NotFoundPageView.tsx";

export function NotFoundPage() {
  const navigate = useNavigate();
  return <NotFoundPageView onHome={() => void navigate({ to: "/" })} />;
}
