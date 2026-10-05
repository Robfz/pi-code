import { useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useState } from "react";

/**
 * Open state of `/`'s project picker. `/?new` (the manifest's "New conversation" shortcut) opens
 * it, also when `/` is already on screen, and drops the param so a reload doesn't reopen it.
 */
export function useNewConversationPicker(): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(false);
  const requested = useSearch({ strict: false, select: (search) => search.new === true });
  const navigate = useNavigate();
  useEffect(() => {
    if (!requested) return;
    setOpen(true);
    void navigate({ to: "/", search: {}, replace: true });
  }, [requested, navigate]);
  return [open, setOpen];
}
