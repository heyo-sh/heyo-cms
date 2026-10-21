import { useState } from "react";

import { useAssistant } from "./assistant";

/**
 * A right-hand pane and the AI drawer share the same edge. Fold the pane on
 * opening AI and restore it on closing AI, but only on those transitions: its
 * own trigger must still be usable while the conversation is open.
 *
 * Synchronise during render, not in an effect. The shell moves the page as
 * the drawer slides; updating the pane one committed frame later makes the
 * content column shrink and then grow again. Keeping this hook in both the
 * document editor and the media library prevents their behaviour drifting.
 */
export function useAssistantPane() {
  const assistant = useAssistant();
  const [open, setOpen] = useState(() => !assistant.open);
  const [assistantWasOpen, setAssistantWasOpen] = useState(assistant.open);
  if (assistantWasOpen !== assistant.open) {
    setAssistantWasOpen(assistant.open);
    setOpen(!assistant.open);
  }
  return { open, setOpen, assistantOpen: assistant.open };
}
