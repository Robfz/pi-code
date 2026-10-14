/**
 * The Changes tab's base branch picker: a searchable list of the project's branches in a popover,
 * since a repository can have hundreds of them.
 */

import { ChevronsUpDownIcon, GitBranchIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

export function BranchPicker({
  value,
  branches,
  disabled,
  onChange,
}: {
  value: string | undefined;
  /** Most recent first. */
  branches: string[];
  disabled?: boolean;
  onChange(branch: string): void;
}) {
  const [open, setOpen] = useState(false);
  // A stored base that is no longer listed (deleted, or not fetched yet) stays pickable.
  const options = value === undefined || branches.includes(value) ? branches : [value, ...branches];
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          role="combobox"
          aria-label="Base branch"
          aria-expanded={open}
          disabled={disabled}
          className="max-w-56 min-w-0 justify-start font-normal"
        >
          <GitBranchIcon className="text-muted-foreground" />
          <span className={value === undefined ? "truncate text-muted-foreground" : "truncate"}>
            {value ?? "Pick a branch"}
          </span>
          <ChevronsUpDownIcon className="ml-auto text-faint-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-0">
        <Command label="Base branch">
          <CommandInput placeholder="Search branches" aria-label="Search branches" />
          <CommandList aria-label="Branches">
            <CommandEmpty className="py-4 text-xs text-muted-foreground">
              No matching branches
            </CommandEmpty>
            {options.map((branch) => (
              <CommandItem
                key={branch}
                value={branch}
                data-checked={branch === value}
                onSelect={() => {
                  setOpen(false);
                  if (branch !== value) onChange(branch);
                }}
                className="font-mono text-xs"
              >
                <span className="min-w-0 truncate">{branch}</span>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
