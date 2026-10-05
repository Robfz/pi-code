import { PlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ProjectPicker } from "@/features/catalog/project-picker";
import { useNewConversationPicker } from "@/features/catalog/use-new-conversation-picker";
import { useIsDesktop } from "@/lib/use-media-query";
import { HomeScreen } from "./home";

/** Desktop `/`: the sidebar lists the conversations, the content area invites to pick one. */
function PickConversationScreen() {
  const [pickerOpen, setPickerOpen] = useNewConversationPicker();
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 px-6 text-center">
      <h1 className="text-sm text-muted-foreground">Pick a conversation or start a new one</h1>
      <Button onClick={() => setPickerOpen(true)}>
        <PlusIcon /> New conversation
      </Button>
      <ProjectPicker open={pickerOpen} onOpenChange={setPickerOpen} />
    </div>
  );
}

/** `/`: Home on phones, the pick-a-conversation screen on desktop. */
export function IndexScreen() {
  return useIsDesktop() ? <PickConversationScreen /> : <HomeScreen />;
}
