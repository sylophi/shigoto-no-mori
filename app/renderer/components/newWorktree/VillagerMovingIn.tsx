import { VillagerFace, VillagerSays } from "@/components/shared/VillagerSays";
import {
  useVillagerFace,
  useVillagerProfiles,
} from "@/hooks/villagers/useVillagers";
import { speakerFor, villagerLine } from "@/lib/villagerVoice";

// The New Worktree form's hello while the folder it will create is a
// character's name, after the destination line: "Sheldon is moving in,
// cardio!", with their face. Nothing for any other name, or without
// Village life on the device the form creates on.
export function VillagerMovingIn({ folderName }: { folderName: string }) {
  const profiles = useVillagerProfiles();
  const speaker =
    profiles === undefined ? null : speakerFor(folderName, profiles);
  const face = useVillagerFace(speaker?.slug ?? null);
  if (speaker === null) return null;
  const message = `${speaker.profile.name} is moving in`;
  const line = villagerLine(speaker, message);
  return (
    <>
      {" "}
      {face && (
        <VillagerFace face={face} className="-my-1 mr-1 size-5 align-middle" />
      )}
      {line === null ? `${message}!` : <VillagerSays line={line} />}
    </>
  );
}
