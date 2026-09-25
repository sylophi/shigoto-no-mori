// Contact sheet for VillagerIcon (renderer/components/shared/
// VillagerIcon.tsx), a standalone lab page over the fixture bridge:
// http://localhost:<lab port>/villager-icons.html
//   default       the doubutsu overlay (one panel, in ?theme)
//   ?doubutsu=0   v1 light and dark side by side, since v1's dark
//                 tokens also apply under a nested .dark
// The faces come from lab/villager-data (lab/villagerData.ts), a
// download that never enters the repo. Without it the sheet says so,
// and every face renders nothing.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { VillagerIcon } from "@/components/shared/VillagerIcon";
import { cn } from "@/lib/utils";
import { villagerManifest } from "@shared/villagers/manifest";
import { labHasVillagerData } from "./villagerData";

const doubutsu = document.documentElement.classList.contains("doubutsu");
const posedDark = document.documentElement.classList.contains("dark");

const slugs = Object.keys(villagerManifest.villagers);
// The icons picked by hand (the fetch script's overrides), every eighth
// icon, the special characters, the two slugs two characters share, and
// a New Leaf (64x64) one.
const SHEET = [
  ...new Set([
    "kk-slider",
    "zipper-t-bunny",
    "dr-shrunk",
    "serena",
    "frillard",
    "snowmam",
    ...slugs.filter((_, i) => i % 8 === 0),
    "tom-nook",
    "isabelle",
    "timmy",
    "tommy",
    "carmen",
    "epona",
  ]),
];
const SIZES = [16, 24, 48, 96];

function Panel({ dark }: { dark: boolean }) {
  return (
    <section
      className={cn(
        "flex flex-col gap-4 rounded-lg border bg-background p-4 text-foreground",
        dark && "dark",
      )}
    >
      <h2 className="text-sm font-medium">
        {doubutsu ? "doubutsu" : "v1"} {dark ? "dark" : "light"}
      </h2>
      <div className="grid grid-cols-10 gap-x-1 gap-y-2">
        {SHEET.map((slug) => (
          <figure key={slug} className="flex flex-col items-center gap-0.5">
            <VillagerIcon slug={slug} size={48} alt={slug} />
            <figcaption className="max-w-full truncate text-3xs text-muted-foreground">
              {slug}
            </figcaption>
          </figure>
        ))}
      </div>
      <div className="flex flex-col gap-2 text-2xs text-muted-foreground">
        {[
          { slug: "isabelle", note: "NH 128px" },
          { slug: "epona", note: "New Leaf 64px" },
          { slug: "kk-slider", note: "NH question 256px" },
          { slug: "serena", note: "City Folk 128px" },
          { slug: "snowmam", note: "Happy Home Designer 64px" },
        ].map(({ slug, note }) => (
          <div key={slug} className="flex items-end gap-3">
            {SIZES.map((size) => (
              <VillagerIcon key={size} slug={slug} size={size} />
            ))}
            <span>
              {slug} ({note})
            </span>
          </div>
        ))}
        <div className="flex items-center gap-3">
          <VillagerIcon slug="apple" className="size-8 rounded-full bg-muted" />
          <span className="flex size-8 items-center justify-center border border-dashed">
            <VillagerIcon slug="not-a-villager" />
          </span>
          <span>
            className sizing (size-8), and a name that isn't a villager (renders
            nothing)
          </span>
        </div>
      </div>
    </section>
  );
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient()}>
    <main className="flex flex-col gap-4 bg-muted p-4">
      {!labHasVillagerData && (
        <p className="text-sm text-muted-foreground">
          No villager data in lab/villager-data, so no faces. Run{" "}
          <span className="font-mono">pnpm villagers:fetch</span> to download
          it.
        </p>
      )}
      <div className="flex gap-4">
        {doubutsu ? (
          <Panel dark={posedDark} />
        ) : (
          <>
            <Panel dark={false} />
            <Panel dark />
          </>
        )}
      </div>
    </main>
  </QueryClientProvider>,
);
