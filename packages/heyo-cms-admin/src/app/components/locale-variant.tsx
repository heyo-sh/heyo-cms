import type { PanelCollection } from "@heyo-sh/heyo-cms/types";
import { Button, Checkbox, Dialog, Text } from "@heyo-sh/heyo-ui";
import { useState } from "react";

import { api, ApiError } from "../lib/api";
import { usePanel } from "../lib/panel";
import { toast } from "../lib/toast";
import { LocaleSwitcher } from "./locale-switcher";

type Doc = Record<string, unknown>;

/** Language selection on an editor is a request to open (or create) a variant,
 * not a request to silently show fallback content as if it were translated. */
export function useLocaleVariant({
  collection,
  id,
  dirty,
  confirmDiscard,
}: {
  collection: PanelCollection;
  id?: string;
  dirty: boolean;
  confirmDiscard: () => Promise<boolean>;
}) {
  const { config, locale, setLocale } = usePanel();
  const [target, setTarget] = useState<string | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [ai, setAi] = useState(false);
  const [busy, setBusy] = useState(false);
  const localized = collection.fields.filter(
    (field) => field.localized && field.access.read,
  );
  const prefix =
    collection.kind === "global"
      ? `/globals/${collection.slug}`
      : `/${collection.slug}/${id}`;

  const read = (code: string) =>
    api.get<Doc>(prefix, {
      query: { locale: code, fallbackLocale: false, depth: 0 },
    });

  const choose = async (next: string) => {
    if (next === locale || busy) return;
    if (dirty && !(await confirmDiscard())) return;
    if ((!id && collection.kind !== "global") || localized.length === 0) {
      setLocale(next);
      return;
    }
    setBusy(true);
    try {
      const variant = await read(next);
      // Any value in the target language means this variant already exists.
      // Partial translations remain editable without a destructive prompt.
      if (
        exists(
          variant,
          localized.map((field) => field.name),
        )
      ) {
        setLocale(next);
        return;
      }
      const current = await read(locale);
      const sourceCode = exists(
        current,
        localized.map((field) => field.name),
      )
        ? locale
        : config.i18n.defaultLocale;
      setSource(sourceCode);
      setAi(false);
      setTarget(next);
    } catch (error) {
      toast.error(error);
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    if (!target || !source || busy) return;
    setBusy(true);
    try {
      // Re-read both languages at submission time. A stale dialog must never
      // overwrite a translation another editor just created.
      const [original, existing, fallback] = await Promise.all([
        read(source),
        read(target),
        source === config.i18n.defaultLocale
          ? Promise.resolve(null)
          : read(config.i18n.defaultLocale),
      ]);
      if (
        exists(
          existing,
          localized.map((field) => field.name),
        )
      ) {
        toast.info(
          "This language already has content. Open it to continue editing.",
        );
        setTarget(null);
        setLocale(target);
        return;
      }
      const data: Doc = {};
      const translationSources = new Map<string, string>();
      for (const field of localized) {
        if (!field.access.update || field.readOnly) continue;
        const fromCurrent =
          (source === config.i18n.defaultLocale ||
            exists(original, [field.name])) &&
          hasValue(original[field.name]);
        const value = fromCurrent
          ? original[field.name]
          : fallback?.[field.name];
        if (!hasValue(value)) continue;
        data[field.name] = value;
        translationSources.set(
          field.name,
          fromCurrent ? source : config.i18n.defaultLocale,
        );
      }
      if (Object.keys(data).length === 0) {
        throw new Error(
          "There is no editable localized content to create this version from.",
        );
      }
      if (ai) {
        const fields = collection.fields
          .filter(
            (field) =>
              field.localized &&
              field.access.read &&
              field.access.update &&
              !field.readOnly &&
              ["text", "textarea", "richText", "email", "url"].includes(
                field.type,
              ) &&
              hasValue(data[field.name]),
          )
          .map((field) => field.name);
        // A partially translated source may show default-language fallback
        // fields. Translate those from their actual language, not from an
        // empty value in the language currently selected in the editor.
        const groups = new Map<string, string[]>();
        for (const name of fields) {
          const code = translationSources.get(name)!;
          groups.set(code, [...(groups.get(code) ?? []), name]);
        }
        for (const [code, names] of groups) {
          const result = await api.post<{ values: Doc }>(
            `${prefix}/ai/translate-variant`,
            { body: { locale: target, sourceLocale: code, fields: names } },
          );
          Object.assign(data, result.values);
        }
      }
      const result = await api.patch<Doc | null>(prefix, {
        query: { locale: target },
        body: {
          data,
          ...(typeof existing.revision === "number"
            ? { revision: existing.revision }
            : {}),
        },
      });
      if (result === null) {
        toast.info("A hook stopped this write.");
        return;
      }
      toast.success(
        ai ? "Language version translated." : "Language version created.",
      );
      setTarget(null);
      setLocale(target);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        toast.info("This document changed. Reopen the language and try again.");
      } else {
        toast.error(error);
      }
    } finally {
      setBusy(false);
    }
  };

  const label =
    config.i18n.locales.find((entry) => entry.code === target)?.name ?? target;
  return {
    switcher: (
      <LocaleSwitcher
        onValueChange={(next) => void choose(next)}
        disabled={busy}
      />
    ),
    dialog: (
      <Dialog
        open={target !== null}
        onOpenChange={(open) => !open && !busy && setTarget(null)}
      >
        <Dialog.Content>
          <Dialog.Header>
            <Dialog.Title>Create {label} version?</Dialog.Title>
            <Dialog.Description>
              This language version does not exist yet. Create it from the{" "}
              {config.i18n.locales.find((entry) => entry.code === source)
                ?.name ?? source}{" "}
              content. Shared fields stay unchanged. With AI enabled, localized
              text is translated; non-text values are copied.
            </Dialog.Description>
          </Dialog.Header>
          <Dialog.Body>
            <label className="flex items-center gap-2">
              <Checkbox
                checked={ai}
                disabled={busy || !config.ai.configured || !config.ai.runtime}
                onCheckedChange={(checked) => setAi(Boolean(checked))}
              />
              <Text size="sm">Translate localized content with AI</Text>
            </label>
            {!config.ai.configured || !config.ai.runtime ? (
              <Text size="xs" tone="subtle">
                AI is not configured for this deployment.
              </Text>
            ) : null}
          </Dialog.Body>
          <Dialog.Footer>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => setTarget(null)}
            >
              Cancel
            </Button>
            <Button
              loading={busy}
              disabled={busy}
              onClick={() => void create()}
            >
              {ai ? "Create and translate" : "Create version"}
            </Button>
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog>
    ),
  };
}

function exists(document: Doc, fields: string[]): boolean {
  const present = document._localeFields;
  return (
    Array.isArray(present) && present.some((name) => fields.includes(name))
  );
}

function hasValue(value: unknown): boolean {
  return value !== null && value !== undefined && value !== "";
}
