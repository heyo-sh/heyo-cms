import type { MediaDocument } from "@heyo-sh/heyo-cms/types";
import {
  Button,
  Dialog,
  Empty,
  Input,
  Spinner,
  Text,
  Tooltip,
  cn,
} from "@heyo-sh/heyo-ui";
import { IconPhoto, IconSearch, IconUpload, IconX } from "@tabler/icons-react";
import { useRef, useState } from "react";

import { api } from "../lib/api";
import { useAsync, useDebounced } from "../lib/hooks";
import { altText, isImage, listMedia, previewUrl, uploadMedia } from "../lib/media"; // prettier-ignore
import { usePanel } from "../lib/panel";
import { formatBytes } from "../lib/format";
import { toast } from "../lib/toast";
import { ErrorNote } from "./chrome";
import type { FieldInputProps } from "./field-input";

/**
 * A `media` field: one input, and the picker behind it.
 *
 * The value is an id — that is what makes the whole media lifecycle work — so
 * the control's job is to turn an id into something an editor recognises and
 * back again. It does that as a read-only text input holding the filename,
 * because that is what every other field in the pane is: a label, a control
 * of one height, a value you can read at a glance.
 *
 * There used to be a drop zone here, and a card with a 56px thumbnail and
 * three buttons once a file was chosen. Both were a *second* design inside a
 * column of plain inputs: the field changed height when it had a value, the
 * row stopped lining up with the rows above it, and a property pane turned
 * into a gallery. Uploading is not lost — the picker opens with an Upload
 * button and the whole library — it is simply one click away rather than
 * taking a sixth of the pane forever.
 *
 * The thumbnail survives as the input's leading icon: 16px is enough to
 * confirm you picked the right image, and it costs no layout at all.
 *
 * The input is the trigger, and it is the only one. There used to be a button
 * beside it — "Choose a file", then "Replace" — wired to the same `open()`
 * the input already calls, so the row carried two controls that did one
 * thing and the one you were pointing at was the larger of the two. What is
 * left is the pair that actually differ: the field itself opens the picker,
 * and the cross clears the reference without opening anything.
 */
export function MediaField({
  field,
  value,
  onChange,
  disabled,
  id: controlId,
}: FieldInputProps) {
  const { config, locale } = usePanel();
  const [picking, setPicking] = useState(false);
  const id = typeof value === "string" ? value : null;

  const current = useAsync<MediaDocument | null>(
    async (signal) =>
      id ? api.get<MediaDocument>(`/media/${id}`, { signal }) : null,
    [id],
  );

  const accept =
    typeof field.options.accept === "string" ? field.options.accept : undefined;

  const file = current.data ?? null;
  // The file is gone but the reference is not. The id is still the honest
  // thing to show — it is what will be saved — with the ring saying it is
  // not resolvable any more.
  const missing = id !== null && Boolean(current.error);
  const text =
    id === null ? "" : (file?.filename ?? (current.loading ? "…" : id));

  const open = () => {
    if (disabled !== true) setPicking(true);
  };

  /**
   * The native tooltip, which is also where the control says what it does
   * now that no button beside it says it: the facts about the file first,
   * and then the one thing clicking the field will do.
   */
  const details = file
    ? `${file.filename} · ${formatBytes(file.size)}${file.width ? ` · ${file.width}×${file.height}` : ""}`
    : missing
      ? "The referenced file is missing"
      : null;
  const hint =
    disabled === true
      ? details
      : [details, file ? "click to replace it" : "click to choose a file"]
          .filter(Boolean)
          .join(" — ");

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <Input
        id={controlId}
        readOnly
        value={text}
        placeholder="No file chosen"
        aria-label={field.label}
        disabled={disabled}
        icon={
          file && isImage(file) ? (
            <img
              src={previewUrl(file, config.media.variants)}
              alt={altText(file, locale)}
              className="size-full rounded-xs object-cover"
            />
          ) : (
            IconPhoto
          )
        }
        {...(hint ? { title: hint } : {})}
        className={cn(
          "min-w-0 flex-1",
          // The input is the trigger, so it has to say so — on the wrapper,
          // which is what the pointer is over, and on the field itself,
          // which a read-only input would otherwise give a text caret.
          disabled !== true && "cursor-pointer [&_input]:cursor-pointer",
          missing && "ring-heyo-danger/60",
        )}
        onClick={open}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          open();
        }}
      />

      {id !== null && disabled !== true ? (
        <Tooltip content="Remove">
          <Button
            variant="ghost"
            size="base"
            shape="square"
            icon={IconX}
            aria-label="Remove file"
            onClick={() => onChange(null)}
          />
        </Tooltip>
      ) : null}

      <MediaPicker
        open={picking}
        onOpenChange={setPicking}
        {...(accept === undefined ? {} : { accept })}
        onPick={(picked) => {
          onChange(picked.id);
          setPicking(false);
        }}
      />
    </div>
  );
}

/**
 * The picker dialog.
 *
 * `accept` is the field's hint and is applied to the file input and the
 * listing filter. It is deliberately not enforcement — the server checks the
 * bytes, and a picker that lied about what is allowed would be worse than
 * one that offers too much.
 */
export function MediaPicker({
  open,
  onOpenChange,
  onPick,
  accept,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (file: MediaDocument) => void;
  accept?: string;
}) {
  const { config, locale } = usePanel();
  const [search, setSearch] = useState("");
  const [uploading, setUploading] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const debounced = useDebounced(search);

  const files = useAsync(
    (signal) =>
      listMedia(
        {
          status: "active",
          limit: 24,
          ...(debounced ? { search: debounced } : {}),
          ...(accept ? { mimeType: accept } : {}),
        },
        signal,
      ),
    [debounced, accept, open],
  );

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    try {
      const stored = await uploadMedia(file, { locale });
      toast.success(`${stored.filename} uploaded.`);
      onPick(stored);
    } catch (error) {
      toast.error(error);
    } finally {
      setUploading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <Dialog.Content size="xl">
        <Dialog.Header>
          <Dialog.Title>Media</Dialog.Title>
          <Dialog.Description>
            {accept ? `Showing ${accept}` : "Everything in the library."}
          </Dialog.Description>
        </Dialog.Header>

        <Dialog.Body className="space-y-3">
          <div className="flex gap-2">
            <Input
              size="sm"
              icon={IconSearch}
              value={search}
              placeholder="Search filenames…"
              aria-label="Search filenames"
              className="flex-1"
              onChange={(event) => setSearch(event.target.value)}
            />
            <input
              ref={input}
              type="file"
              hidden
              {...(accept ? { accept } : {})}
              onChange={(event) => void upload(event.target.files?.[0])}
            />
            <Button
              size="sm"
              variant="outline"
              icon={IconUpload}
              loading={uploading}
              onClick={() => input.current?.click()}
            >
              Upload
            </Button>
          </div>

          <ErrorNote error={files.error} />

          {files.loading && !files.data ? (
            <div className="flex justify-center py-10">
              <Spinner size="sm" />
            </div>
          ) : files.data && files.data.docs.length > 0 ? (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
              {files.data.docs.map((file) => (
                <button
                  key={file.id}
                  type="button"
                  onClick={() => onPick(file)}
                  className={cn(
                    "overflow-hidden rounded-lg text-left ring-1 ring-heyo-line transition-shadow heyo-focus",
                    "hover:ring-2 hover:ring-heyo-focus",
                  )}
                >
                  <div className="flex aspect-square items-center justify-center bg-heyo-recessed">
                    {isImage(file) ? (
                      <img
                        src={previewUrl(file, config.media.variants)}
                        alt={altText(file, locale)}
                        loading="lazy"
                        className="size-full object-cover"
                      />
                    ) : (
                      <Text size="xs" tone="inactive" as="span">
                        {file.mimeType.split("/").at(-1)?.toUpperCase()}
                      </Text>
                    )}
                  </div>
                  <Text size="xs" truncate className="px-1.5 py-1">
                    {file.filename}
                  </Text>
                </button>
              ))}
            </div>
          ) : (
            <Empty
              icon={IconPhoto}
              title="Nothing here yet"
              description="Upload a file, or drop the search term."
              hint="Everything uploaded anywhere in the panel shows up here."
            />
          )}
        </Dialog.Body>
      </Dialog.Content>
    </Dialog>
  );
}
