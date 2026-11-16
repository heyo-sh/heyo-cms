import type { AiAssistantEvent } from "@heyo-sh/heyo-cms/types";

/**
 * The SSE body, one `AiAssistantEvent` per `data:` frame.
 *
 * Frames can arrive split across chunks, several to a chunk, or split inside
 * a multi-byte character; a frame without `data:` (the server's keep-alive
 * comment) and a frame that is not JSON are skipped rather than ending a
 * conversation that is otherwise fine.
 */
export async function readEventStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: AiAssistantEvent) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const flush = (final: boolean) => {
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1 || (final && buffer.trim().length > 0)) {
      const end = boundary === -1 ? buffer.length : boundary;
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(boundary === -1 ? buffer.length : boundary + 2);
      const payload = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("");
      if (payload.length > 0) {
        try {
          onEvent(JSON.parse(payload) as AiAssistantEvent);
        } catch {
          // A frame we cannot parse is a frame from a newer server. Dropping
          // it is better than ending a conversation that is otherwise fine.
        }
      }
      boundary = buffer.indexOf("\n\n");
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    flush(false);
  }
  buffer += decoder.decode();
  flush(true);
}
