import { useNavigate } from "@tanstack/react-router";
import { NotFoundPageView } from "@/components/NotFoundPageView";

export function NotFoundPage() {
  const navigate = useNavigate();
  return <NotFoundPageView onHome={() => void navigate({ to: "/" })} />;
}
