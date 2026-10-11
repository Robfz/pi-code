import type { RpcSessionState, ThinkingLevel } from "@pi-code/protocol";
import { useQuery } from "@tanstack/react-query";
import { Command as CommandPrimitive } from "cmdk";
import { ChevronDownIcon, LoaderIcon, SearchIcon } from "lucide-react";
import { useState } from "react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { errorMessage, rpc } from "@/lib/api";
import { queryKeys } from "@/lib/query-client";
import { useIsDesktop } from "@/lib/use-media-query";
import { useConversation } from "@/store/context";
import { groupModels, ThinkingLevelControl, useOpenSheet } from "./action-sheets";
import { useSessionActions } from "./session-actions";

type Model = NonNullable<RpcSessionState["model"]>;

/** "No thinking" for `off`, "XHigh" for `xhigh`, otherwise the level capitalized. */
export function thinkingLabel(level: ThinkingLevel): string {
  if (level === "off") return "No thinking";
  if (level === "xhigh") return "XHigh";
  return level.charAt(0).toUpperCase() + level.slice(1);
}

const modelName = (model: Model) => model.name || model.id;

/** `{model name} · {level}`, or the name alone for models without reasoning. */
export function pickerLabel(
  model: Model | undefined,
  level: ThinkingLevel | undefined,
): { name: string; level?: string } {
  if (!model) return { name: "Select model" };
  if (!model.reasoning || level === undefined) return { name: modelName(model) };
  return { name: modelName(model), level: thinkingLabel(level) };
}

/** The desktop popover: searchable models by provider, then the thinking level. */
function ModelMenu({ onChosen }: { onChosen(): void }) {
  const agentId = useConversation((s) => s.agentId);
  const current = useConversation((s) => s.state?.model);
  const actions = useSessionActions();
  const models = useQuery({
    queryKey: queryKeys.models(agentId),
    queryFn: () => rpc(agentId, { type: "get_available_models" }),
    staleTime: 60_000,
  });
  const currentValue = current ? `${current.provider}/${current.id}` : undefined;
  return (
    <>
      <Command
        label="Search models"
        defaultValue={currentValue}
        className="rounded-none! bg-transparent p-0"
      >
        <div className="flex h-10 items-center gap-2 border-b px-3 text-faint-foreground">
          <SearchIcon className="size-3.5 shrink-0" />
          <CommandPrimitive.Input
            placeholder="Search models"
            className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-faint-foreground"
          />
          <kbd className="rounded border px-1 py-0.5 text-[11.5px] leading-none">esc</kbd>
        </div>
        <CommandList aria-label="Models" className="max-h-[340px] px-[5px] pt-1 pb-1.5">
          {models.isPending && (
            <p className="flex items-center gap-2 px-2 py-3 text-xs text-muted-foreground">
              <LoaderIcon className="size-3.5 animate-spin" /> Loading…
            </p>
          )}
          {models.isError && (
            <p role="alert" className="px-2 py-3 text-xs text-destructive">
              {errorMessage(models.error)}
            </p>
          )}
          {models.data && (
            <CommandEmpty className="py-6 text-xs text-muted-foreground">No models.</CommandEmpty>
          )}
          {groupModels(models.data?.models ?? []).map(([provider, list]) => (
            <CommandGroup
              key={provider}
              heading={provider}
              className="p-0 **:[[cmdk-group-heading]]:px-2 **:[[cmdk-group-heading]]:pt-2 **:[[cmdk-group-heading]]:pb-[3px] **:[[cmdk-group-heading]]:font-normal **:[[cmdk-group-heading]]:text-faint-foreground"
            >
              {list.map((model) => {
                const value = `${model.provider}/${model.id}`;
                return (
                  <CommandItem
                    key={value}
                    value={value}
                    keywords={[model.name]}
                    data-checked={value === currentValue}
                    onSelect={() => {
                      onChosen();
                      if (value !== currentValue) void actions.setModel(model.provider, model.id);
                    }}
                    className="h-8 rounded-[7px] py-0 text-subtle-foreground data-selected:bg-accent"
                  >
                    <span className="min-w-0 flex-1 truncate">{modelName(model)}</span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          ))}
        </CommandList>
      </Command>
      {current?.reasoning && (
        <div className="border-t px-3 pt-2.5 pb-3">
          <div className="mb-2 flex justify-between gap-3 text-xs text-muted-foreground">
            <span>Thinking</span>
            <span className="min-w-0 truncate text-faint-foreground">{modelName(current)}</span>
          </div>
          <ThinkingLevelControl />
        </div>
      )}
    </>
  );
}

/**
 * The composer's model and thinking button (`docs/design/09-ui-overhaul.md`, "Model picker"):
 * a popover on desktop, the model sheet on phone.
 */
export function ModelPicker() {
  const desktop = useIsDesktop();
  const ready = useConversation((s) => s.hydrated && s.agent.status === "ready");
  const model = useConversation((s) => s.state?.model);
  const level = useConversation((s) => s.state?.thinkingLevel);
  const openSheet = useOpenSheet();
  const [open, setOpen] = useState(false);
  const label = pickerLabel(model, level);

  const trigger = (
    <button
      type="button"
      aria-label={label.level ? `${label.name} · ${label.level}` : label.name}
      title="Model and thinking"
      disabled={!ready}
      onClick={desktop ? undefined : () => openSheet("model")}
      className="inline-flex h-7 min-w-0 items-center gap-[5px] rounded-lg pr-2 pl-2.5 text-sm whitespace-nowrap text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-expanded:bg-accent aria-expanded:text-foreground"
    >
      <span className="min-w-0 truncate">{label.name}</span>
      {label.level && (
        <>
          <span className="text-faint-foreground">·</span>
          <span className="shrink-0">{label.level}</span>
        </>
      )}
      <ChevronDownIcon className="size-[13px] shrink-0 text-faint-foreground" />
    </button>
  );

  if (!desktop) return trigger;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={8}
        data-testid="model-picker"
        className="w-[300px] gap-0 overflow-hidden rounded-[14px] border border-input p-0 shadow-[0_16px_48px_-12px_oklch(0_0_0/0.25),0_2px_8px_oklch(0_0_0/0.08)] ring-0 dark:shadow-[0_16px_48px_-12px_oklch(0_0_0/0.7),0_2px_8px_oklch(0_0_0/0.3)]"
      >
        <ModelMenu onChosen={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}
