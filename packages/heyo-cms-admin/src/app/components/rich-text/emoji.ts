import { Emoji, gitHubEmojis } from "@tiptap/extension-emoji";
import type { Extension } from "@tiptap/core";

/**
 * Emoji, in its own chunk.
 *
 * The shortcode table is around half a megabyte — a third of the whole panel
 * — and nobody types `:tada:` in the first second after a page load. So this
 * module is imported dynamically by the editor and the bundler splits it out:
 * the field is usable immediately and the table arrives behind it, which is
 * the only honest way to keep both the feature and the size budget.
 *
 * The extension is created here rather than exported ready-made so the
 * dataset is only touched when the chunk is actually evaluated.
 */
export function emojiExtension(): Extension {
  return Emoji.configure({
    emojis: gitHubEmojis,
    // `:-)` as it is typed, which is the half of emoji support that needs no
    // table at all — but it lives here anyway, with the rest of the feature.
    enableEmoticons: true,
  }) as unknown as Extension;
}
