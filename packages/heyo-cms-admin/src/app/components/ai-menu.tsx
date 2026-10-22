import type { AiRunResult, PanelField } from "@heyo-sh/heyo-cms/types";
import {
  Button,
  Dialog,
  Dropdown,
  Spinner,
  Text,
  Tooltip,
} from "@heyo-sh/heyo-ui";
import { IconSparkles } from "@tabler/icons-react";
import { useState } from "react";

import { api } from "../lib/api";
import { usePanel } from "../lib/panel";
import { ErrorNote } from "./chrome";

/**
 * The AI menu next to one field.
 *
 * One entry per key in `field.ai` — AI lives on the field that can do it, so
 * the menu is the configuration, not a feature flag. A field with no `ai` key
 * has no button at all.
 *
 * Two things are deliberate:
 *
 * - **Nothing is written silently.** A result is shown and inserted on
 *   request. An editor who asked for a suggestion did not ask for an edit.
 * - **A disabled button says why.** When there is no `ai` section the menu
 *   still lists what the field declares and states what is missing, because
 *   a greyed-out control with no explanation reads as a bug.
 *
 * The draft travels with the request. The engine merges it over the stored
 * document, so a suggestion is about what is on the screen rather than what
 * was saved before lunch — and a document that has never been saved works
 * the same way, through the route without an id.
 */
export function AiMenu({
  field,
  collection,
  documentId,
  document,
  locale,
  onInsert,
  disabled,
}: {
  field: PanelField;
  /** Slug, and `globals/<slug>` for a singleton: the route prefix. */
  collection: string;
  documentId?: string | undefined;
  document: Record<string, unknown>;
  locale: string;
  onInsert: (value: unknown) => void;
  disabled?: boolean;
}) {
  const { config } = usePanel();
  const [running, setRunning] = useState<string | null>(null);
  const [result, setResult] = useState<{
    action: string;
    text: string;
    value: unknown;
  } | null>(null);
  const [error, setError] = useState<unknown>(null);

  if (field.ai.length === 0) return null;

  const onlyGenerate = field.ai.length === 1 && field.ai[0]?.key === "generate";
  const unavailable = !config.ai.configured
    ? "No `ai` section in this deployment's configuration."
    : !config.ai.runtime
      ? "The AI endpoints are not answering in this deployment."
      : null;

  const run = async (action: string) => {
    setRunning(action);
    setError(null);
    try {
      const path = documentId
        ? `/${collection}/${documentId}/ai/${field.name}/${action}`
        : `/${collection}/ai/${field.name}/${action}`;
      const response = await api.post<AiRunResult>(path, {
        body: { document, locale },
      });
      // `value` is shaped for the field — a string, a ProseMirror document,
      // an array — and `preview` is the human-readable form of the same
      // thing. The dialog shows one and inserts the other.
      setResult({ action, text: response.preview, value: response.value });
    } catch (cause) {
      setError(cause);
    } finally {
      setRunning(null);
    }
  };

  return (
    <>
      {onlyGenerate ? (
        <Tooltip content={unavailable ?? `AI generate ${field.label}`}>
          <span className="inline-flex">
            <Button
              type="button"
              size="base"
              variant="outline"
              shape="square"
              aria-label={`AI generate ${field.label}`}
              disabled={disabled || unavailable !== null || running !== null}
              icon={running ? undefined : IconSparkles}
              onClick={() => void run("generate")}
            >
              {running ? <Spinner size="sm" /> : null}
            </Button>
          </span>
        </Tooltip>
      ) : (
        <Dropdown>
          <Dropdown.Trigger
            render={
              <Button
                size="base"
                variant="outline"
                shape="square"
                aria-label={`AI actions for ${field.label}`}
                disabled={disabled}
                icon={running ? undefined : IconSparkles}
              >
                {running ? <Spinner size="sm" /> : null}
              </Button>
            }
          />
          <Dropdown.Content align="end" className="w-52">
            <Dropdown.Group>
              <Dropdown.Label>{field.label}</Dropdown.Label>
              {field.ai.map((action) => (
                <Dropdown.Item
                  key={action.key}
                  disabled={unavailable !== null}
                  onClick={() => void run(action.key)}
                >
                  {action.label}
                </Dropdown.Item>
              ))}
            </Dropdown.Group>
            {unavailable ? (
              <Text size="xs" tone="subtle" className="px-2 py-1.5">
                {unavailable}
              </Text>
            ) : null}
          </Dropdown.Content>
        </Dropdown>
      )}

      <ErrorNote error={error} className="mt-1" />

      <Dialog
        open={result !== null}
        onOpenChange={(open) => !open && setResult(null)}
      >
        <Dialog.Content size="lg">
          <Dialog.Header>
            <Dialog.Title>Suggestion</Dialog.Title>
            <Dialog.Description>
              Nothing is written until you insert it.
            </Dialog.Description>
          </Dialog.Header>
          <Dialog.Body>
            <Text size="sm" className="whitespace-pre-wrap">
              {result?.text}
            </Text>
          </Dialog.Body>
          <Dialog.Footer>
            <Button variant="ghost" onClick={() => setResult(null)}>
              Discard
            </Button>
            <Button
              onClick={() => {
                if (result) onInsert(result.value);
                setResult(null);
              }}
            >
              Insert
            </Button>
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog>
    </>
  );
}
