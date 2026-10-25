/**
 * URL slugs, in every script a CMS is likely to be written in.
 *
 * ASCII on purpose: an ASCII slug survives being pasted into a chat or an
 * e-mail, never turns into `%D0%B1…` in a link, and reads the same in every
 * browser. Unicode normalisation takes care of the accents it can decompose
 * (é, ü, ç, ą…); the letters it cannot (ł, ß, ø…) and the Cyrillic and Greek
 * alphabets are transliterated from the tables below. A character with no
 * transliteration is dropped rather than percent-encoded, which is why a
 * title written entirely in such a script produces an empty slug — the
 * caller decides what to do then, usually by falling back to the id.
 */

/** Latin letters NFKD does not decompose. */
const latin: Record<string, string> = {
  ß: "ss",
  æ: "ae",
  œ: "oe",
  ø: "o",
  ð: "d",
  þ: "th",
  đ: "d",
  ł: "l",
  ı: "i",
  ĸ: "k",
  ŋ: "n",
  ŧ: "t",
};

/**
 * Cyrillic, after the Ukrainian national system (resolution No. 55) with the
 * Russian and Belarusian letters it lacks. One table rather than one per
 * language: a slug has no locale, and a reader cannot tell the difference.
 */
const cyrillic: Record<string, string> = {
  а: "a",
  б: "b",
  в: "v",
  г: "h",
  ґ: "g",
  д: "d",
  е: "e",
  є: "ie",
  ж: "zh",
  з: "z",
  и: "y",
  і: "i",
  ї: "i",
  й: "i",
  к: "k",
  л: "l",
  м: "m",
  н: "n",
  о: "o",
  п: "p",
  р: "r",
  с: "s",
  т: "t",
  у: "u",
  ў: "u",
  ф: "f",
  х: "kh",
  ц: "ts",
  ч: "ch",
  ш: "sh",
  щ: "shch",
  ь: "",
  ю: "iu",
  я: "ia",
  ъ: "",
  ы: "y",
  э: "e",
  ё: "e",
};

/** Greek, as ELOT 743 spells it for passports and road signs. */
const greek: Record<string, string> = {
  α: "a",
  β: "v",
  γ: "g",
  δ: "d",
  ε: "e",
  ζ: "z",
  η: "i",
  θ: "th",
  ι: "i",
  κ: "k",
  λ: "l",
  μ: "m",
  ν: "n",
  ξ: "x",
  ο: "o",
  π: "p",
  ρ: "r",
  σ: "s",
  ς: "s",
  τ: "t",
  υ: "y",
  φ: "f",
  χ: "ch",
  ψ: "ps",
  ω: "o",
};

/** What a slug looks like: lowercase ASCII words joined by single hyphens. */
export const slugPattern = "^[a-z0-9]+(?:-[a-z0-9]+)*$";

const slugExpression = new RegExp(slugPattern);

export function isSlug(value: string): boolean {
  return slugExpression.test(value);
}

export interface SlugifyOptions {
  /**
   * The longest slug produced. Longer input is cut at the last hyphen that
   * keeps at least half of it, so a slug never ends in the middle of a word.
   */
  maxLength?: number;
}

/**
 * Turns any text into a slug: `"Łódź & Kraków — 2024"` → `"lodz-krakow-2024"`.
 *
 * Idempotent: a slug passed through it comes back unchanged, which is what
 * lets the engine run every incoming slug through it without second-guessing
 * one an editor typed on purpose.
 */
export function slugify(input: string, options: SlugifyOptions = {}): string {
  const max = options.maxLength ?? 96;
  const transliterated = Array.from(input.toLowerCase())
    .map(
      (char) =>
        latin[char] ??
        cyrillic[char] ??
        // Greek accents (έ, ΐ) come off before the lookup; Cyrillic ones may
        // not, because й and ї are letters of their own, not и and і.
        greek[char.normalize("NFD").replace(/[\u0300-\u036f]/g, "")] ??
        char,
    )
    .join("");

  const slug = transliterated
    .normalize("NFKD")
    // The combining marks NFKD separated from their letters.
    .replace(/[\u0300-\u036f]/g, "")
    // An apostrophe joins rather than separates: "don't" is "dont".
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (slug.length <= max) return slug;
  const cut = slug.slice(0, max);
  const boundary = cut.lastIndexOf("-");
  return boundary >= max / 2 ? cut.slice(0, boundary) : cut.replace(/-+$/, "");
}
