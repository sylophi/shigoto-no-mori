import { isBirthdayOn } from "@shigomori/ui/lib/villagers/birthdays.ts";
import {
  VillagerFaceView,
  VillagerSaysView,
} from "@shigomori/ui/views/shared/VillagerSaysView.tsx";
import { BirthdayFaceView } from "@shigomori/ui/views/villagers/BirthdayFaceView.tsx";
import { useToday } from "@shigomori/ui/hooks/useToday.ts";
import {
  useVillagerFace,
  useVillagerProfiles,
} from "@/hooks/villagers/useVillagers";
import { cn } from "@shigomori/ui/lib/utils.ts";
import { speakerFor, villagerLine } from "@shigomori/ui/lib/villagerVoice.ts";

// The New Worktree form's hello while the folder it will create is a
// character's name, after the destination line: "Sheldon is moving in,
// cardio!", with their face. On their birthday they say so, in a party
// hat. Nothing for any other name, or without Village life on in this
// window.
export function VillagerMovingIn({ folderName }: { folderName: string }) {
  const profiles = useVillagerProfiles();
  const speaker =
    profiles === undefined ? null : speakerFor(folderName, profiles);
  const face = useVillagerFace(speaker?.slug ?? null);
  const today = useToday();
  if (speaker === null) return null;
  const birthday = isBirthdayOn(speaker.profile.birthday, today);
  const message = birthday
    ? `It's ${speaker.profile.name}'s birthday, and ${
        speaker.profile.gender === "Female"
          ? "she's"
          : speaker.profile.gender === "Male"
            ? "he's"
            : "they're"
      } moving in`
    : `${speaker.profile.name} is moving in`;
  const line = villagerLine(speaker, message);
  const faceClass = "-my-1 mr-1 size-5 align-middle";
  return (
    <>
      {" "}
      {face &&
        (birthday ? (
          <BirthdayFaceView face={face} className={cn(faceClass, "mt-1")} />
        ) : (
          <VillagerFaceView face={face} className={faceClass} />
        ))}
      {line === null ? `${message}!` : <VillagerSaysView line={line} />}
    </>
  );
}
