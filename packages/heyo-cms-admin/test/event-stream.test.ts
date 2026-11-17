import { describe, expect, test } from "bun:test";

import type { AiAssistantEvent } from "@heyo-sh/heyo-cms/types";

import { readEventStream } from "../src/app/lib/event-stream";

/**
 * The panel's reader for the assistant's stream.
 *
 * A network delivers bytes, not frames: a frame arrives in pieces, several
 * arrive in one piece, and a multi-byte character can be cut in half at a
 * chunk boundary. The server also interleaves keep-alive comments. None of
 * that may change what the editor sees.
 */

const encoder = new TextEncoder();

function frame(event: AiAssistantEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

function body(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

async function read(chunks: Uint8Array[]): Promise<AiAssistantEvent[]> {
  const events: AiAssistantEvent[] = [];
  await readEventStream(body(chunks), (event) => events.push(event));
  return events;
}

/** The same bytes, cut every `size` bytes — mid-frame, mid-character. */
function cut(bytes: Uint8Array, size: number): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let start = 0; start < bytes.length; start += size) {
    chunks.push(bytes.slice(start, start + size));
  }
  return chunks;
}

const events: AiAssistantEvent[] = [
  { type: "tool-start", id: "t1", label: "Search documents" },
  { type: "tool-end", id: "t1", summary: "Searched documents" },
  { type: "text-delta", text: "Zażółć gęślą jaźń — płatność się nie powiodła. 🐾" }, // prettier-ignore
  { type: "done", runId: "air_1", usage: { input: 1, output: 2, total: 3, cost: 0 } }, // prettier-ignore
];
const wire = events.map(frame).join("");

describe("readEventStream", () => {
  test("whole, in one chunk", async () => {
    expect(await read([encoder.encode(wire)])).toEqual(events);
  });

  test("cut at every possible size, including inside multi-byte characters", async () => {
    const bytes = encoder.encode(wire);
    for (const size of [1, 2, 3, 5, 7, 13, 64]) {
      expect(await read(cut(bytes, size))).toEqual(events);
    }
  });

  test("keep-alive comments between and inside the run are ignored", async () => {
    const withComments = [
      ": keep-alive\n\n",
      frame(events[0]!),
      ": keep-alive\n\n: keep-alive\n\n",
      ...events.slice(1).map(frame),
      ": keep-alive\n\n",
    ].join("");
    expect(await read(cut(encoder.encode(withComments), 4))).toEqual(events);
  });

  test("a frame that is not JSON is skipped, the rest of the conversation is not", async () => {
    const broken = frame(events[0]!) + "data: {not json\n\n" + events.slice(1).map(frame).join(""); // prettier-ignore
    expect(await read([encoder.encode(broken)])).toEqual(events);
  });

  test("the last frame is read even when the connection ends without its blank line", async () => {
    const truncated = wire.slice(0, -2);
    expect(await read([encoder.encode(truncated)])).toEqual(events);
  });

  test("a frame split over several data lines is joined", async () => {
    const json = JSON.stringify(events[2]);
    const split = `data: ${json.slice(0, 20)}\ndata: ${json.slice(20)}\n\n`;
    expect(await read([encoder.encode(split)])).toEqual([events[2]!]);
  });
});
