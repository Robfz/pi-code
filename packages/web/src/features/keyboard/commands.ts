/**
 * The commands shortcuts run (`docs/design/10-keyboard.md`, "Keymap"), listed by the help screen
 * in this order. Their keys are in `keymap.ts`.
 */

export type CommandId =
  | "conversation.new"
  | "conversation.previous"
  | "conversation.next"
  | "conversation.goTo"
  | "help.toggle";

export interface Command {
  id: CommandId;
  title: string;
  section: "Conversations" | "Help";
}

export const COMMANDS: readonly Command[] = [
  { id: "conversation.new", title: "New conversation", section: "Conversations" },
  { id: "conversation.previous", title: "Previous conversation", section: "Conversations" },
  { id: "conversation.next", title: "Next conversation", section: "Conversations" },
  { id: "conversation.goTo", title: "Go to conversation 1–9", section: "Conversations" },
  { id: "help.toggle", title: "Keyboard shortcuts", section: "Help" },
];
