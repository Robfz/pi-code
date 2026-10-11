import { useMemo } from "react";
import { useConversation } from "@/store/context";
import { selectLabels, selectPendingUser } from "@/store/selectors";
import { selectTurns, type Turn } from "@/store/turns";
import { TurnView } from "./turn";

/** Hosts live state on a transcript with no turn yet. */
const EMPTY_TURN: Turn = { id: "start", entries: [], steps: [] };

/**
 * The active branch as turns. A pending user message starts a new turn after them; the last
 * turn also shows what's in flight.
 */
export function Transcript() {
  const turns = useConversation(selectTurns);
  const labels = useConversation(selectLabels);
  const pendingUser = useConversation(selectPendingUser);
  const pendingTurn = useMemo<Turn | undefined>(
    () => pendingUser && { id: "pending", user: pendingUser, entries: [], steps: [] },
    [pendingUser],
  );
  const shown = pendingTurn ? [...turns, pendingTurn] : turns.length > 0 ? turns : [EMPTY_TURN];
  return (
    <div data-testid="transcript" className="flex min-w-0 flex-col gap-10">
      {shown.map((turn, index) => (
        <TurnView
          key={turn.id}
          turn={turn}
          last={index === shown.length - 1}
          pending={turn === pendingTurn}
          labels={labels}
        />
      ))}
    </div>
  );
}
