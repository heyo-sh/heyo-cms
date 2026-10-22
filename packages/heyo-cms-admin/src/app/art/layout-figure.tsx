/**
 * The drawing beside the sign-in form.
 *
 * It is a Hairline figure: one isometric line drawing, built from rounded
 * solids in a single stroke, that answers the pointer. The engine underneath
 * it is `hairline-kernel.js`, vendored unchanged from the skill that draws
 * these (`hairline-LICENSE`); everything in this file is the figure itself,
 * written the way that skill's rules ask for.
 *
 * **Layout.** A page taken apart into the blocks it is made of: a title bar,
 * a media block, two columns of text and a footer, each held over the place
 * it came from by two dashed drops. Which is what a CMS is for — a page is
 * not a file here, it is these pieces — and it is the first thing the panel
 * says to somebody standing at the door. The pointer is projected back onto
 * the page and every block rises by its distance to it, so the answer
 * spreads out from the pointer and falls off instead of being a switch.
 *
 * One clock, because the input is continuous: a spring per block, retargeted
 * every time the pointer moves. The hit test is the page's own plane, which
 * stays where it is however high the blocks go, so a block rising out from
 * under the pointer cannot flip the choice and start a flicker loop.
 *
 * Nothing here sets a colour. The palette is five CSS variables the panel
 * maps onto heyo tokens in `styles.css`, and the only highlight is one
 * stroke: at rest the media block, under the pointer whichever block it is
 * over.
 */

import { useEffect, useRef } from "react";

import HL, {
  type HairlinePoint,
  type HairlineRing,
  type HairlineSample,
  type HairlineSolid,
  type HairlineSpring,
} from "./hairline-kernel.js";

const {
  Cam, extremes, facing, fit, prism, proj, rings, seg, spring, stepS,
  disposer, mk, pointer, put, register, solid, unproj,
} = HL; // prettier-ignore

/** The page, in world units, and how far a block rises right under the pointer. */
const W = 70, D = 58, SHEET = 2.6, LIFT = 11; // prettier-ignore
/** How far the rise reaches from the pointer, in page units. */
const REACH = 24;

/**
 * The composition: a title bar, a media block, two columns of text and a
 * footer. `rest` is where each one floats when nobody is pointing — uneven,
 * so the still frame is already a composition — and `rule` is how many lines
 * of ruling say that the block holds text. The media block has none.
 */
const BLOCKS = [
  { x0: 6, y0: 5, x1: 64, y1: 13, h: 1.8, rest: 3.2, rule: 1 },
  { x0: 6, y0: 17, x1: 35, y1: 40, h: 3, rest: 1, rule: 0 },
  { x0: 39, y0: 17, x1: 64, y1: 27, h: 1.6, rest: 4.6, rule: 3 },
  { x0: 39, y0: 31, x1: 64, y1: 40, h: 1.6, rest: 0.6, rule: 3 },
  { x0: 6, y0: 44, x1: 64, y1: 52, h: 1.6, rest: 2.4, rule: 2 },
];

/** The block the eye starts on at rest, in paint order: the media block. */
const BRIGHT = 1;

/** The lap the figure walks on its own until a pointer arrives, in viewBox points. */
const LAP: (HairlinePoint | null)[] = [
  [240, 167],
  [172, 172],
  [247, 197],
  [162, 206],
  null,
];

/** The share of the full rise u reaches from the pointer: 1 → .31 at 42% → .09 at the edge and beyond. */
const falloff = (u: number) =>
  u <= 0
    ? 1
    : u <= 0.417
      ? 1 - (u / 0.417) * 0.6875
      : u <= 1
        ? 0.3125 - ((u - 0.417) / 0.583) * 0.2185
        : 0.094;

interface Block {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  h: number;
  rest: number;
  rule: number;
  ring: HairlineRing;
  inner: HairlineRing;
  left: HairlineSample;
  right: HairlineSample;
  drops: SVGPathElement;
  plate: HairlineSolid;
  lines: SVGPathElement;
  sp: HairlineSpring;
  drawn: number;
}

/**
 * Draws the figure into `svg` and answers `stage`'s pointer until the handle
 * it returns is destroyed.
 */
function mountLayout(stage: Element, svg: SVGSVGElement) {
  const bag = disposer();
  let over: [number, number] | null = null;
  let act = -1;

  const camera = Cam(45, 0.5, 2.8);
  fit(
    camera,
    [
      [0, 0, 0],
      [W, D, 0],
      [W, 0, 0],
      [0, D, 0],
      [0, 0, SHEET + 20],
      [W, D, SHEET + 20],
    ],
    200,
    166,
  );
  const P = proj(camera);
  const front = facing(camera);
  const g = mk("g", {}, svg);

  const [page, pageIn] = rings(0, 0, W, D, 3, 1.6);
  put(solid(g), prism(P, front, page, pageIn, 0, SHEET));

  // Back to front: the farthest block (the smallest x + y) is drawn first, so
  // a nearer one covers it, and each block's dashed drops go in before it.
  const blocks: Block[] = BLOCKS.slice()
    .sort((a, b) => a.x0 + a.y0 - (b.x0 + b.y0))
    .map((b) => {
      const [ring, inner] = rings(b.x0, b.y0, b.x1, b.y1, 1.4, 0.7);
      const [left, right] = extremes(P, ring) as [
        HairlineSample,
        HairlineSample,
        HairlineSample,
      ];
      const drops = mk("path", { class: "dash nf" }, g);
      const plate = solid(g);
      return {
        ...b,
        ring,
        inner,
        left,
        right,
        drops,
        plate,
        lines: mk("path", { class: "nf" }, plate.g),
        sp: spring(b.rest, { eps: 0.03 }),
        drawn: NaN,
      };
    });

  /** Block b floating `off` above the page: its two drops, its solid, and the ruling that says it holds text. */
  function draw(b: Block, off: number) {
    if (off === b.drawn) return;
    b.drawn = off;
    const z0 = SHEET + off;
    const z1 = z0 + b.h;
    b.drops.setAttribute(
      "d",
      [b.left, b.right]
        .map((q) => seg(P(q.u, q.v, SHEET), P(q.u, q.v, z0)))
        .join(""),
    );
    put(b.plate, prism(P, front, b.ring, b.inner, z0, z1));
    const step = (b.y1 - b.y0) / (b.rule + 1);
    b.lines.setAttribute(
      "d",
      Array.from({ length: b.rule }, (_, i) =>
        seg(
          P(b.x0 + 3, b.y0 + step * (i + 1), z1),
          P(b.x1 - (i === b.rule - 1 ? 9 : 3), b.y0 + step * (i + 1), z1),
        ),
      ).join(""),
    );
  }

  const clock = register(stage, (dt) => {
    let moving = false;
    for (const b of blocks) {
      if (stepS(b.sp, dt)) moving = true;
      draw(b, b.sp.x);
    }
    return moving;
  });
  bag.add(clock.unregister);

  const centre = (b: Block): [number, number] => [
    (b.x0 + b.x1) / 2,
    (b.y0 + b.y1) / 2,
  ];
  const holds = (b: Block, p: [number, number]) =>
    p[0] >= b.x0 && p[0] <= b.x1 && p[1] >= b.y0 && p[1] <= b.y1;

  function retarget() {
    let want = -1;
    let near = Infinity;
    blocks.forEach((b, i) => {
      if (!over) return;
      const c = centre(b);
      const away = Math.hypot(c[0] - over[0], c[1] - over[1]);
      // The block the pointer is over, or, in the margins, the nearest one.
      if (holds(b, over)) {
        want = i;
        near = -1;
      } else if (near >= 0 && away < near) {
        near = away;
        want = i;
      }
      b.sp.t = b.rest + LIFT * falloff(away / REACH);
    });
    if (!over) for (const b of blocks) b.sp.t = b.rest;
    if (want !== act) {
      act = want;
      const lit = want < 0 ? BRIGHT : want;
      blocks.forEach((b, i) => b.plate.sil.classList.toggle("hi", i === lit));
    }
    clock.wake();
  }
  blocks[BRIGHT]?.plate.sil.classList.add("hi");
  retarget();

  bag.add(
    pointer(stage, {
      move: (point) => {
        // The page's own plane is the hit test: it is where the blocks came
        // from, and it stays there however high they rise.
        over = unproj(camera, point[0], point[1], SHEET);
        retarget();
      },
      leave: () => {
        over = null;
        retarget();
      },
    }),
  );
  bag.add(() => svg.replaceChildren());

  return { destroy: bag.dispose };
}

/**
 * The figure, as a React element.
 *
 * It is decorative: the label is what the drawing is, not what the panel
 * does, and the animation is the engine's one frame loop, which sleeps when
 * the figure is off screen and lands everything at once under
 * `prefers-reduced-motion`. Where the browser has no `IntersectionObserver`
 * — a server render, or the DOM the tests run on — nothing mounts and the
 * panel keeps an empty plate rather than throwing.
 */
export function LayoutFigure({ className }: { className?: string }) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const stage = host.current;
    if (!stage) return;
    if (
      typeof IntersectionObserver === "undefined" ||
      typeof window.matchMedia !== "function"
    ) {
      return;
    }

    HL.inject(stage.ownerDocument);
    const svg = mk(
      "svg",
      { viewBox: "0 0 400 320", "aria-hidden": "true" },
      stage,
    );
    const figure = mountLayout(stage, svg);
    const lap = HL.tour(stage, LAP);

    return () => {
      lap.stop();
      figure.destroy();
      svg.remove();
    };
  }, []);

  return (
    <div
      aria-label="A page taken apart into the blocks it is made of"
      className={className}
      data-hairline="layout"
      ref={host}
      role="img"
    />
  );
}
