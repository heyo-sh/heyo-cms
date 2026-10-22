import { describe, expect, test } from "bun:test";

import { sourceRegion } from "../src/media/sharp";

describe("crop and focal point on the original", () => {
  test("centres a cover variant on the focal point inside a crop", () => {
    const region = sourceRegion(1000, 800, {
      crop: { x: 200, y: 100, width: 600, height: 400 },
      position: { x: 0.55, y: 0.375 },
      fit: "cover",
      width: 200,
      height: 200,
    });
    // The square can move horizontally between x=200 and x=400.
    // x=.55 means 550px on the original, not 55% of the cropped 600px.
    expect(region).toEqual({ left: 350, top: 100, width: 400, height: 400 });
  });

  test("a point outside the selected crop clamps to the crop edge", () => {
    expect(
      sourceRegion(1000, 800, {
        crop: { x: 200, y: 100, width: 600, height: 400 },
        position: { x: 0, y: 1 },
        fit: "cover",
        width: 200,
        height: 200,
      }),
    ).toEqual({ left: 200, top: 100, width: 400, height: 400 });
  });

  test("without a focal point the crop is preserved; without a crop the point uses the whole image", () => {
    expect(
      sourceRegion(1000, 800, {
        crop: { x: 200, y: 100, width: 600, height: 400 },
        fit: "cover",
        width: 200,
        height: 200,
      }),
    ).toEqual({ left: 200, top: 100, width: 600, height: 400 });
    expect(
      sourceRegion(1000, 800, {
        position: { x: 0.65, y: 0.4 },
        fit: "cover",
        width: 200,
        height: 200,
      }),
    ).toEqual({ left: 200, top: 0, width: 800, height: 800 });
  });
});
