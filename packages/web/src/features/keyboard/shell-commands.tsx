import { useNavigate, useParams } from "@tanstack/react-router";
import { useState } from "react";
import { ProjectPicker } from "@/features/catalog/project-picker";
import { usePrReview } from "@/features/pr-review/pr-review-dialog";
import { type ActiveRow, activeRows, buildSidebarGroups } from "@/features/sidebar/sidebar-model";
import { useLiveRegistry } from "@/store/context";
import { useCommand } from "./keyboard-provider";

/**
 * The conversation commands, on every route whether or not the sidebar is mounted: new
 * conversation opens the project picker in place; review PR opens the dialog `PrReviewProvider`
 * hosts; previous, next and go-to walk the sidebar's Active list, unfiltered by its search, and
 * open live agents only.
 */
export function ShellCommands() {
  const { live } = useLiveRegistry();
  const currentId = useParams({ strict: false }).agentId;
  const navigate = useNavigate();
  const [pickerOpen, setPickerOpen] = useState(false);
  const { openPrReview } = usePrReview();

  const open = (row: ActiveRow | undefined) => {
    if (row) void navigate({ to: "/agents/$agentId", params: { agentId: row.agent.id } });
  };
  /** Built when a command runs, so the overview's updates don't re-render this. */
  const activeNow = () => {
    const { agents, sessions, sidebar } = live.getState();
    return activeRows(
      buildSidebarGroups({
        agents: Object.values(agents),
        sessions,
        pinned: sidebar.pinned,
        mains: sidebar.mains,
      }),
    );
  };
  /** From outside the list, as if stepping in from beyond its ends. */
  const step = (by: 1 | -1) => {
    const active = activeNow();
    if (active.length === 0) return;
    const index = active.findIndex((row) => row.agent.id === currentId);
    const from = index === -1 ? (by === 1 ? -1 : active.length) : index;
    open(active[(from + by + active.length) % active.length]);
  };

  useCommand("conversation.new", () => setPickerOpen(true));
  useCommand("pr.review", openPrReview);
  useCommand("conversation.previous", () => step(-1));
  useCommand("conversation.next", () => step(1));
  useCommand("conversation.goTo", (position) => open(activeNow()[position - 1]));

  return <ProjectPicker open={pickerOpen} onOpenChange={setPickerOpen} />;
}
