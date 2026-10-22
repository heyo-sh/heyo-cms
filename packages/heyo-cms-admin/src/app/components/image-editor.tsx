import type { MediaDocument } from "@heyo-sh/heyo-cms/types";
import { Badge, Button, Text, Tooltip, cn } from "@heyo-sh/heyo-ui";
import {
  IconArrowBackUp,
  IconCrop,
  IconFocusCentered,
  IconPhoto,
} from "@tabler/icons-react";
import { useRef, useState } from "react";

import { mediaUrl } from "../lib/api";

/**
 * The focal point and the crop, made legible.
 *
 * Both features existed and neither was usable: two toggle buttons put the
 * panel into a mode, a sentence underneath explained what clicking would do,
 * and nothing on screen ever showed what either one had achieved. "I don't
 * know whether it works" was the correct reading of that interface.
 *
 * What it does now, in the order it says it:
 *
 * - **It shows the consequence, not the coordinate.** Under the picture are
 *   three example cover frames — square, wide, portrait — using the same
 *   framing as cover variants: the crop decides which pixels exist, and the
 *   focal point decides what stays in frame when they are cut to a shape.
 *   Drag the point and the three frames move with it. That is the whole
 *   feature, and it is now visible in one glance instead of described.
 * - **The point is a handle.** It is dragged, not clicked-at-and-hoped,
 *   with a crosshair so it can be lined up against something in the picture.
 * - **The crop is a rectangle you can fix.** It can be drawn, moved,
 *   resized from any corner, snapped to a ratio, and cleared — rather than
 *   being redrawn from scratch every time it comes out wrong by ten pixels.
 * - **Nothing is written until Save.** Changing either one discards the
 *   variants rendered from the old values, which is the server's business
 *   and the reason this is a draft until somebody means it.
 */

export interface Focal {
  x: number;
  y: number;
}

export interface Crop {
  x: number;
  y: number;
  width: number;
  height: number;
}

type Mode = "view" | "focal" | "crop";
type Handle = "nw" | "ne" | "sw" | "se" | "move" | null;

export function ImageEditor({
  file,
  focal,
  crop,
  onFocalChange,
  onCropChange,
  allowFocal,
  allowCrop,
}: {
  file: MediaDocument;
  focal: Focal | null;
  crop: Crop | null;
  onFocalChange: (focal: Focal | null) => void;
  onCropChange: (crop: Crop | null) => void;
  allowFocal: boolean;
  allowCrop: boolean;
}) {
  const [mode, setMode] = useState<Mode>("view");
  const frame = useRef<HTMLDivElement>(null);
  const drag = useRef<{ handle: Handle; start: Focal; origin: Crop } | null>(
    null,
  );

  // The stored rectangle is in the pixels of the original, which is the only
  // frame of reference that survives a rerender at a different display size.
  const width = file.width ?? 0;
  const height = file.height ?? 0;
  const sized = width > 0 && height > 0;

  /** Pointer position as a fraction of the rendered image. */
  const at = (event: { clientX: number; clientY: number }): Focal => {
    const bounds = frame.current?.getBoundingClientRect();
    if (!bounds) return { x: 0, y: 0 };
    return {
      x: clamp((event.clientX - bounds.left) / bounds.width),
      y: clamp((event.clientY - bounds.top) / bounds.height),
    };
  };

  const toPixels = (rect: {
    x: number;
    y: number;
    width: number;
    height: number;
  }): Crop => ({
    x: Math.round(rect.x * width),
    y: Math.round(rect.y * height),
    width: Math.round(rect.width * width),
    height: Math.round(rect.height * height),
  });

  const fraction =
    crop && sized && crop.width > 0 && crop.height > 0
      ? {
          x: crop.x / width,
          y: crop.y / height,
          width: crop.width / width,
          height: crop.height / height,
        }
      : null;

  const onPointerDown = (event: React.PointerEvent, handle: Handle) => {
    if (mode === "view") return;
    event.preventDefault();
    event.stopPropagation();
    // Capture on the stable frame, not a handle that can disappear on rerender.
    frame.current?.setPointerCapture?.(event.pointerId);

    const point = at(event);

    if (mode === "focal") {
      onFocalChange(point);
      drag.current = { handle: "move", start: point, origin: emptyCrop };
      return;
    }

    if (handle === null) {
      // A fresh rectangle: it starts as a point and grows under the pointer.
      drag.current = {
        handle: "se",
        start: point,
        origin: toPixels({ ...point, width: 0, height: 0 }),
      };
      onCropChange(toPixels({ ...point, width: 0, height: 0 }));
      return;
    }

    drag.current = {
      handle,
      start: point,
      origin: crop ?? emptyCrop,
    };
  };

  const onPointerMove = (event: React.PointerEvent) => {
    const active = drag.current;
    if (!active || mode === "view") return;
    const point = at(event);

    if (mode === "focal") {
      onFocalChange(point);
      return;
    }
    if (!sized) return;

    if (active.handle === "move") {
      const dx = (point.x - active.start.x) * width;
      const dy = (point.y - active.start.y) * height;
      onCropChange({
        ...active.origin,
        x: Math.round(
          Math.min(Math.max(0, active.origin.x + dx), width - active.origin.width), // prettier-ignore
        ),
        y: Math.round(
          Math.min(Math.max(0, active.origin.y + dy), height - active.origin.height), // prettier-ignore
        ),
      });
      return;
    }

    // Every corner resolves to "the rectangle between two points", so one
    // expression covers all four rather than four near-identical branches.
    const anchor =
      active.handle === "se"
        ? { x: active.origin.x / width, y: active.origin.y / height }
        : active.handle === "nw"
          ? { x: (active.origin.x + active.origin.width) / width, y: (active.origin.y + active.origin.height) / height } // prettier-ignore
          : active.handle === "ne"
            ? { x: active.origin.x / width, y: (active.origin.y + active.origin.height) / height } // prettier-ignore
            : {
                x: (active.origin.x + active.origin.width) / width,
                y: active.origin.y / height,
              }; // sw

    onCropChange(
      toPixels({
        x: Math.min(anchor.x, point.x),
        y: Math.min(anchor.y, point.y),
        width: Math.abs(point.x - anchor.x),
        height: Math.abs(point.y - anchor.y),
      }),
    );
  };

  const onPointerUp = () => {
    const active = drag.current;
    drag.current = null;
    if (!active || mode !== "crop" || !crop) return;
    // A stray click is a zero-sized rectangle, which would store a crop that
    // renders nothing. Treat it as "no crop" rather than as a broken one.
    if (crop.width < 8 || crop.height < 8) onCropChange(null);
  };

  const setRatio = (ratio: number | null) => {
    if (!sized) return;
    if (ratio === null) {
      onCropChange(null);
      return;
    }
    // The largest rectangle of that shape that fits, centred on the focal
    // point when there is one — which is what the point is for.
    const full = width / height;
    const size =
      ratio > full
        ? { width, height: Math.round(width / ratio) }
        : { width: Math.round(height * ratio), height };
    const centre = focal ?? { x: 0.5, y: 0.5 };
    onCropChange({
      ...size,
      x: Math.round(
        Math.min(Math.max(0, centre.x * width - size.width / 2), width - size.width), // prettier-ignore
      ),
      y: Math.round(
        Math.min(Math.max(0, centre.y * height - size.height / 2), height - size.height), // prettier-ignore
      ),
    });
  };

  const source = mediaUrl(file.id);

  return (
    <div className="space-y-2">
      <div
        ref={frame}
        className={cn(
          "relative overflow-hidden rounded-lg bg-heyo-recessed ring-1 ring-heyo-line select-none",
          mode === "focal" && "cursor-crosshair",
          mode === "crop" && "cursor-crosshair",
        )}
        onPointerDown={(event) => onPointerDown(event, null)}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <img
          src={source}
          alt=""
          className="block w-full"
          draggable={false}
          // The browser would otherwise start its own image drag the moment a
          // crop handle is pulled, and the rectangle would be left behind.
          onDragStart={(event) => event.preventDefault()}
        />

        {fraction ? (
          <>
            {/* Dim only the discarded pixels, including while moving the focal point. */}
            <div
              className="pointer-events-none absolute inset-x-0 top-0 bg-heyo-scrim"
              style={{ height: `${fraction.y * 100}%` }}
            />
            <div
              className="pointer-events-none absolute inset-x-0 bottom-0 bg-heyo-scrim"
              style={{ height: `${(1 - fraction.y - fraction.height) * 100}%` }}
            />
            <div
              className="pointer-events-none absolute left-0 bg-heyo-scrim"
              style={{
                top: `${fraction.y * 100}%`,
                height: `${fraction.height * 100}%`,
                width: `${fraction.x * 100}%`,
              }}
            />
            <div
              className="pointer-events-none absolute right-0 bg-heyo-scrim"
              style={{
                top: `${fraction.y * 100}%`,
                height: `${fraction.height * 100}%`,
                width: `${(1 - fraction.x - fraction.width) * 100}%`,
              }}
            />
            <div
              className={cn(
                "absolute ring-2 ring-heyo-focus",
                mode !== "crop" && "pointer-events-none",
              )}
              style={box(fraction)}
              onPointerDown={(event) => onPointerDown(event, "move")}
            >
              <div className="absolute inset-0 bg-heyo-base/0" />
              {mode === "crop"
                ? (["nw", "ne", "sw", "se"] as const).map((handle) => (
                    <span
                      key={handle}
                      onPointerDown={(event) => onPointerDown(event, handle)}
                      className={cn(
                        "absolute size-3 rounded-full bg-heyo-focus ring-2 ring-heyo-base",
                        handle === "nw" &&
                          "-top-1.5 -left-1.5 cursor-nwse-resize",
                        handle === "ne" &&
                          "-top-1.5 -right-1.5 cursor-nesw-resize",
                        handle === "sw" &&
                          "-bottom-1.5 -left-1.5 cursor-nesw-resize",
                        handle === "se" &&
                          "-right-1.5 -bottom-1.5 cursor-nwse-resize",
                      )}
                    />
                  ))
                : null}
            </div>
          </>
        ) : null}

        {focal ? (
          <span
            className={cn(
              "absolute -translate-x-1/2 -translate-y-1/2",
              mode === "focal" ? "cursor-grab" : "pointer-events-none",
            )}
            style={{ left: `${focal.x * 100}%`, top: `${focal.y * 100}%` }}
            onPointerDown={(event) => onPointerDown(event, "move")}
          >
            <span className="block size-4 rounded-full bg-heyo-brand ring-2 ring-heyo-on-brand" />
            {mode === "focal" ? (
              <>
                <span className="pointer-events-none absolute top-1/2 left-1/2 h-px w-screen -translate-x-1/2 bg-heyo-brand/40" />
                <span className="pointer-events-none absolute top-1/2 left-1/2 h-screen w-px -translate-y-1/2 bg-heyo-brand/40" />
              </>
            ) : null}
          </span>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {allowFocal ? (
          <Button
            size="xs"
            icon={IconFocusCentered}
            variant={mode === "focal" ? "primary" : "outline"}
            onClick={() => {
              const next = mode === "focal" ? "view" : "focal";
              setMode(next);
              // Entering the mode with nothing placed yet starts in the
              // middle, so there is a handle to drag instead of an empty
              // picture and an instruction.
              if (next === "focal" && !focal) onFocalChange({ x: 0.5, y: 0.5 });
            }}
          >
            Focal point
          </Button>
        ) : null}

        {allowCrop ? (
          <Button
            size="xs"
            icon={IconCrop}
            variant={mode === "crop" ? "primary" : "outline"}
            disabled={!sized}
            onClick={() => setMode(mode === "crop" ? "view" : "crop")}
          >
            Crop
          </Button>
        ) : null}

        {focal || crop ? (
          <Tooltip content="Back to the whole picture, centred">
            <Button
              size="xs"
              variant="ghost"
              shape="square"
              icon={IconArrowBackUp}
              aria-label="Reset framing"
              onClick={() => {
                onFocalChange(null);
                onCropChange(null);
                setMode("view");
              }}
            />
          </Tooltip>
        ) : null}
      </div>

      {mode === "crop" ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <Text size="xs" tone="subtle" as="span">
            Snap:
          </Text>
          {(
            [
              ["1:1", 1],
              ["16:9", 16 / 9],
              ["4:3", 4 / 3],
              ["3:4", 3 / 4],
            ] as const
          ).map(([label, ratio]) => (
            <Button
              key={label}
              size="xs"
              variant="ghost"
              onClick={() => setRatio(ratio)}
            >
              {label}
            </Button>
          ))}
          {crop ? (
            <Badge variant="neutral" size="sm">
              {crop.width}×{crop.height} at {crop.x},{crop.y}
            </Badge>
          ) : null}
        </div>
      ) : null}

      {mode !== "view" ? (
        <Text size="xs" tone="subtle">
          {mode === "focal"
            ? "Drag the dot inside the crop to frame cover variants. A point outside the crop uses the nearest edge."
            : "Drag on the picture to draw a rectangle, or pull a corner. Only these pixels reach a variant."}
        </Text>
      ) : null}

      <Previews file={file} focal={focal} crop={crop} source={source} />
    </div>
  );
}

/**
 * What the thing is for, as three pictures.
 *
 * The panel is told the *names* of the configured sizes and not their shapes,
 * so these are the three shapes a layout asks for rather than this
 * deployment's exact variants — these illustrate cover framing, not variants
 * configured for other fits or with only one dimension.
 */
function Previews({
  file,
  focal,
  crop,
  source,
}: {
  file: MediaDocument;
  focal: Focal | null;
  crop: { x: number; y: number; width: number; height: number } | null;
  source: string;
}) {
  // One height for the row, so the three labels sit on one line and the
  // shapes are compared by shape rather than by size.
  const shapes = [
    { label: "Square", className: "aspect-square" },
    { label: "Wide", className: "aspect-video" },
    { label: "Portrait", className: "aspect-3/4" },
  ];

  return (
    <div className="mt-4 space-y-2">
      <div className="flex min-w-0 flex-wrap items-end justify-center gap-3">
        {shapes.map((shape) => {
          const ratio =
            shape.label === "Square"
              ? 1
              : shape.label === "Wide"
                ? 16 / 9
                : 3 / 4;
          const region =
            file.width && file.height
              ? previewRegion(file.width, file.height, crop, ratio, focal)
              : null;
          return (
            <div key={shape.label} className="flex flex-col items-center gap-1">
              <div
                className={cn(
                  "relative h-16 overflow-hidden rounded-md bg-heyo-recessed ring-1 ring-heyo-hairline xl:h-20",
                  shape.className,
                )}
              >
                {region && file.width && file.height ? (
                  <img
                    src={source}
                    alt=""
                    draggable={false}
                    className="absolute max-w-none"
                    style={{
                      width: `${(file.width / region.width) * 100}%`,
                      height: `${(file.height / region.height) * 100}%`,
                      left: `${(-region.x / region.width) * 100}%`,
                      top: `${(-region.y / region.height) * 100}%`,
                    }}
                  />
                ) : (
                  <img
                    src={source}
                    alt=""
                    draggable={false}
                    className="size-full object-cover"
                  />
                )}
              </div>
              <Text size="xs" tone="subtle" as="span">
                {shape.label}
              </Text>
            </div>
          );
        })}
      </div>
      {file.width ? null : (
        <div className="flex items-center gap-2">
          <IconPhoto className="size-3.5 text-heyo-inactive" />
          <Text size="xs" tone="subtle">
            This file has no stored dimensions, so a crop cannot be expressed in
            its pixels.
          </Text>
        </div>
      )}
    </div>
  );
}

// Same cover geometry as sharp's sourceRegion: both inputs refer to the
// original image, then the focal point centres the requested shape INSIDE the
// selected crop (or the full image when there is no crop).
export function previewRegion(
  width: number,
  height: number,
  crop: { x: number; y: number; width: number; height: number } | null,
  ratio: number,
  focal: Focal | null,
): Crop {
  const x = crop ? Math.min(Math.max(0, Math.round(crop.x)), width - 1) : 0;
  const y = crop ? Math.min(Math.max(0, Math.round(crop.y)), height - 1) : 0;
  const bounds =
    crop && crop.width > 0 && crop.height > 0
      ? {
          x,
          y,
          width: Math.min(Math.max(1, Math.round(crop.width)), width - x),
          height: Math.min(Math.max(1, Math.round(crop.height)), height - y),
        }
      : { x: 0, y: 0, width, height };
  const wide = bounds.width / bounds.height > ratio;
  const visibleWidth = wide
    ? Math.min(bounds.width, Math.max(1, Math.round(bounds.height * ratio)))
    : bounds.width;
  const visibleHeight = wide
    ? bounds.height
    : Math.min(bounds.height, Math.max(1, Math.round(bounds.width / ratio)));
  const centreX = focal ? focal.x * width : bounds.x + bounds.width / 2;
  const centreY = focal ? focal.y * height : bounds.y + bounds.height / 2;
  return {
    x:
      bounds.x +
      Math.min(
        Math.max(0, Math.round(centreX - bounds.x - visibleWidth / 2)),
        bounds.width - visibleWidth,
      ),
    y:
      bounds.y +
      Math.min(
        Math.max(0, Math.round(centreY - bounds.y - visibleHeight / 2)),
        bounds.height - visibleHeight,
      ),
    width: visibleWidth,
    height: visibleHeight,
  };
}

const emptyCrop: Crop = { x: 0, y: 0, width: 0, height: 0 };

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function box(rect: { x: number; y: number; width: number; height: number }) {
  return {
    left: `${rect.x * 100}%`,
    top: `${rect.y * 100}%`,
    width: `${rect.width * 100}%`,
    height: `${rect.height * 100}%`,
  };
}
