import type { PanelField } from "@heyo-sh/heyo-cms/types";
import { Button, Spinner } from "@heyo-sh/heyo-ui";
import { IconWand } from "@tabler/icons-react";
import { useState } from "react";

import { api } from "../lib/api";
import { ErrorNote } from "./chrome";
import { AiMenu } from "./ai-menu";

/** Two separate capabilities: deterministic generation first, AI suggestion second. */
export function FieldActions({
  field,
  collection,
  documentId,
  document,
  locale,
  onInsert,
  disabled,
}: {
  field: PanelField;
  collection: string;
  documentId?: string;
  document: Record<string, unknown>;
  locale: string;
  onInsert: (value: unknown) => void;
  disabled?: boolean;
}) {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const generate = async () => {
    setRunning(true);
    setError(null);
    try {
      const path = documentId
        ? `/${collection}/${documentId}/generate/${field.name}`
        : `/${collection}/generate/${field.name}`;
      const result = await api.post<{ value: unknown }>(path, {
        body: { document, locale },
      });
      onInsert(result.value);
    } catch (cause) {
      setError(cause);
    } finally {
      setRunning(false);
    }
  };
  if (!field.generate && field.ai.length === 0) return null;
  return (
    <div className="flex shrink-0 items-center gap-1.5">
      {field.generate ? (
        <Button
          type="button"
          size="base"
          shape="square"
          variant="outline"
          icon={running ? undefined : IconWand}
          aria-label={`Generate ${field.label}`}
          disabled={disabled || running}
          onClick={() => void generate()}
        >
          {running ? <Spinner size="sm" /> : null}
        </Button>
      ) : null}
      <AiMenu
        field={field}
        collection={collection}
        {...(documentId ? { documentId } : {})}
        document={document}
        locale={locale}
        onInsert={onInsert}
        disabled={disabled}
      />
      {error ? <ErrorNote error={error} /> : null}
    </div>
  );
}
