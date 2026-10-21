/**
 * The types for `hairline-kernel.js`, which is vendored JavaScript and stays
 * byte-identical to the file the Hairline skill ships (see
 * `hairline-LICENSE`). Only the parts the panel's figure calls are declared:
 * the kernel's index lists more, and anything added here has to match it.
 *
 * World space is x/y on the ground and z up; screen space is the 400 × 320
 * viewBox every figure is drawn in.
 */

/** One sample of a rounded footprint: where it is, and which way it faces. */
export interface HairlineSample {
  u: number;
  v: number;
  nu: number;
  nv: number;
}

/** A closed footprint, as the samples that walk it. */
export type HairlineRing = HairlineSample[];

/** A point in the 400 × 320 viewBox. */
export type HairlinePoint = [number, number];

export interface HairlineCamera {
  az: number;
  k: number;
  S: number;
  ox: number;
  oy: number;
}

/** A group holding a silhouette path and the one crease inside it. */
export interface HairlineSolid {
  g: SVGGElement;
  sil: SVGPathElement;
  cr: SVGPathElement;
}

/** The two path strings a standing solid is drawn from. */
export interface HairlinePrism {
  sil: string;
  crease: string;
}

/** One moving number on the continuous clock: write `t` to retarget it. */
export interface HairlineSpring {
  x: number;
  v: number;
  t: number;
}

/** One moving number on the discrete clock: a 700ms ease-out. */
export interface HairlineTween {
  from: number;
  to: number;
  t0: number;
  dur: number;
}

export interface HairlineBoard {
  /** Ask for another frame after input. */
  wake(): void;
  unregister(): void;
}

export interface HairlineDisposer {
  add(fn: () => void): void;
  dispose(): void;
}

export interface HairlinePointerHandlers {
  move(point: HairlinePoint, event?: Event): void;
  leave(event?: Event): void;
}

export interface HairlineKernel {
  Cam(azDeg: number, k: number, S: number): HairlineCamera;
  fit(
    camera: HairlineCamera,
    points: [number, number, number][],
    cx: number,
    cy: number,
  ): void;
  proj(
    camera: HairlineCamera,
  ): (x: number, y: number, z: number) => HairlinePoint;
  /** The world [x, y] under a screen point, on the plane at height z. */
  unproj(
    camera: HairlineCamera,
    sx: number,
    sy: number,
    z: number,
  ): [number, number];
  /** [left, right, nearest] samples: where dashed drops fall from. */
  extremes(
    project: (x: number, y: number, z: number) => HairlinePoint,
    ring: HairlineRing,
  ): HairlineSample[];
  facing(camera: HairlineCamera): (sample: HairlineSample) => boolean;
  rings(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    r: number,
    b: number,
  ): [HairlineRing, HairlineRing];
  prism(
    project: (x: number, y: number, z: number) => HairlinePoint,
    front: (sample: HairlineSample) => boolean,
    ring: HairlineRing,
    inner: HairlineRing | null,
    z0: number,
    z1: number,
  ): HairlinePrism;
  solid(parent: Element): HairlineSolid;
  put(solid: HairlineSolid, paths: HairlinePrism): void;
  mk<K extends keyof SVGElementTagNameMap>(
    tag: K,
    attrs?: Record<string, string | number>,
    parent?: Element,
  ): SVGElementTagNameMap[K];
  place(element: Element, point: HairlinePoint): void;
  poly(points: HairlinePoint[]): string;
  seg(a: HairlinePoint, b: HairlinePoint): string;
  clamp(value: number, a: number, b: number): number;
  spring(
    x: number,
    options?: { k?: number; c?: number; m?: number; eps?: number },
  ): HairlineSpring;
  stepS(spring: HairlineSpring, dt: number): boolean;
  tween(value: number, dur?: number): HairlineTween;
  tset(tween: HairlineTween, to: number, now: number, delay: number): void;
  tval(tween: HairlineTween, now: number): number;
  tdone(tween: HairlineTween, now: number): boolean;
  register(
    stage: Element,
    tick: (dt: number, now: number) => boolean,
  ): HairlineBoard;
  pointer(stage: Element, handlers: HairlinePointerHandlers): () => void;
  disposer(): HairlineDisposer;
  /** Adds the palette's stylesheet to a document or shadow root, once. */
  inject(root: Document | ShadowRoot): void;
  /** An unseen pointer that walks the stops and gives way to a real one. */
  tour(
    stage: Element,
    stops: (HairlinePoint | null)[],
    onStop?: (index: number) => void,
  ): { stop(): void };
}

declare const HL: HairlineKernel;

export default HL;
