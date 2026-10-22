import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "http://cms.test/api/heyo-cms/admin" });

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { MediaDocument } from "@heyo-sh/heyo-cms/types";
import type { Root } from "react-dom/client";
import type { Crop, Focal } from "../src/app/components/image-editor";

let root: Root;
let host: HTMLElement;
let act: typeof import("react").act;
let ImageEditor: typeof import("../src/app/components/image-editor").ImageEditor;
let previewRegion: typeof import("../src/app/components/image-editor").previewRegion;

const file = {
  id: "photo",
  width: 1000,
  height: 800,
  mimeType: "image/png",
} as MediaDocument;

beforeAll(async () => {
  ({ act } = await import("react"));
  ({ ImageEditor, previewRegion } =
    await import("../src/app/components/image-editor"));
  const { createRoot } = await import("react-dom/client");
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterAll(async () => {
  await act(async () => root.unmount());
  host.remove();
  await GlobalRegistrator.unregister();
});

describe("media image editor", () => {
  test("square and wide previews use the crop AND the focal point", async () => {
    const crop = { x: 200, y: 100, width: 600, height: 400 };
    expect(previewRegion(1000, 800, crop, 1, { x: 0.55, y: 0.375 })).toEqual({
      x: 350,
      y: 100,
      width: 400,
      height: 400,
    });
    expect(previewRegion(1000, 800, crop, 1, { x: 0, y: 1 })).toEqual({
      x: 200,
      y: 100,
      width: 400,
      height: 400,
    });
    // With no focal point, cover is centred on the crop, not the original.
    expect(previewRegion(1000, 800, crop, 1, null)).toEqual({
      x: 300,
      y: 100,
      width: 400,
      height: 400,
    });

    await render({ x: 0.55, y: 0.375 }, crop);
    const square = preview("Square");
    expect(square.style.width).toBe("250%");
    expect(square.style.height).toBe("200%");
    expect(square.style.left).toBe("-87.5%");
    expect(square.style.top).toBe("-25%");
    const wide = preview("Wide");
    expect(wide.style.left).not.toBe(square.style.left);

    // Moving the focal point changes the visible part without moving the crop.
    await render({ x: 0.2, y: 0.375 }, crop);
    expect(preview("Square").style.left).toBe("-50%");
    expect(preview("Square").style.width).toBe("250%");
  });

  test("resizing a crop that starts at x=0 keeps the original corner anchored", async () => {
    let changed: Crop | null = null;
    await act(async () =>
      root.render(
        <ImageEditor
          file={file}
          focal={null}
          crop={{ x: 0, y: 100, width: 600, height: 400 }}
          onFocalChange={() => {}}
          onCropChange={(value) => {
            changed = value;
          }}
          allowFocal
          allowCrop
        />,
      ),
    );
    await act(async () => {
      [...host.querySelectorAll("button")]
        .find((button) => button.textContent?.includes("Crop"))
        ?.click();
    });
    const frame = host.querySelector("img.block.w-full")?.parentElement;
    if (!frame) throw new Error("Missing image frame");
    frame.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 100, height: 80 }) as DOMRect;
    const handle = [...frame.querySelectorAll("span")].find((node) =>
      node.className.includes("-right-1.5 -bottom-1.5"),
    );
    if (!handle) throw new Error("Missing southeast crop handle");
    await act(async () => {
      handle.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          pointerId: 1,
          clientX: 60,
          clientY: 50,
        }),
      );
      frame.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          pointerId: 1,
          clientX: 80,
          clientY: 60,
        }),
      );
    });
    expect(changed).toEqual({ x: 0, y: 100, width: 800, height: 500 });
  });

  test("the crop interior is visible, and its overlay remains visible while placing a focal point", async () => {
    await render(
      { x: 0.65, y: 0.375 },
      { x: 200, y: 100, width: 600, height: 400 },
    );
    const frame = host.querySelector("img.block.w-full")?.parentElement;
    expect(frame?.querySelectorAll(".bg-heyo-scrim")).toHaveLength(4);
    await act(async () => {
      [...host.querySelectorAll("button")]
        .find((button) => button.textContent?.includes("Focal point"))
        ?.click();
    });
    expect(frame?.querySelectorAll(".bg-heyo-scrim")).toHaveLength(4);
  });
});

async function render(focal: Focal | null, crop: Crop | null) {
  await act(async () =>
    root.render(
      <ImageEditor
        file={file}
        focal={focal}
        crop={crop}
        onFocalChange={() => {}}
        onCropChange={() => {}}
        allowFocal
        allowCrop
      />,
    ),
  );
}

function preview(label: string): HTMLImageElement {
  const caption = [...host.querySelectorAll("span")].find(
    (node) => node.textContent === label,
  );
  const image = caption?.previousElementSibling?.querySelector("img");
  if (!image) throw new Error(`Missing ${label} preview`);
  return image;
}
