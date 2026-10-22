/**
 * Minimal, real files.
 *
 * Every fixture below is a valid container with a correct header, built byte
 * by byte rather than checked in as base64: the probe and the metadata
 * stripper are parsers, and a parser tested against one opaque blob is tested
 * against one opaque blob. Here a test can say "a 1200x800 JPEG that carries
 * GPS coordinates" and mean exactly that.
 */

export function pngFixture(
  width: number,
  height: number,
  options: { text?: string } = {},
): Uint8Array {
  const parts: Uint8Array[] = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", concat([be32(width), be32(height), new Uint8Array([8, 6, 0, 0, 0])])), // prettier-ignore
  ];
  if (options.text !== undefined) {
    parts.push(chunk("tEXt", new TextEncoder().encode(`Comment\0${options.text}`))); // prettier-ignore
    parts.push(chunk("eXIf", new TextEncoder().encode("exif-payload")));
  }
  parts.push(chunk("IDAT", new Uint8Array([0x78, 0x9c, 0x63, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01])), chunk("IEND", new Uint8Array(0))); // prettier-ignore
  return concat(parts);
}

export function jpegFixture(
  width: number,
  height: number,
  options: { exif?: string } = {},
): Uint8Array {
  const parts: Uint8Array[] = [new Uint8Array([0xff, 0xd8])];

  // APP0/JFIF, which is structure rather than metadata and has to survive.
  parts.push(segment(0xe0, concat([new TextEncoder().encode("JFIF\0"), new Uint8Array([1, 1, 0, 0, 1, 0, 1, 0, 0])]))); // prettier-ignore

  if (options.exif !== undefined) {
    parts.push(
      segment(
        0xe1,
        concat([
          new TextEncoder().encode("Exif\0\0"),
          new TextEncoder().encode(options.exif),
        ]),
      ),
    );
  }

  // SOF0: precision, height, width, components.
  parts.push(
    segment(
      0xc0,
      concat([
        new Uint8Array([8]),
        be16(height),
        be16(width),
        new Uint8Array([1, 1, 0x11, 0]),
      ]),
    ),
  );
  parts.push(segment(0xda, new Uint8Array([1, 1, 0, 0, 63, 0])));
  parts.push(new Uint8Array([0x00, 0x01, 0x02, 0xff, 0xd9]));
  return concat(parts);
}

export function gifFixture(width: number, height: number): Uint8Array {
  return concat([
    new TextEncoder().encode("GIF89a"),
    le16(width),
    le16(height),
    new Uint8Array([0xf0, 0x00, 0x00, 0x3b]),
  ]);
}

export function webpFixture(
  width: number,
  height: number,
  options: { exif?: boolean } = {},
): Uint8Array {
  const vp8x = riffChunk(
    "VP8X",
    concat([
      new Uint8Array([0x08, 0, 0, 0]),
      le24(width - 1),
      le24(height - 1),
    ]),
  );
  const payload = options.exif
    ? concat([
        vp8x,
        riffChunk("EXIF", new TextEncoder().encode("exif-payload")),
      ])
    : vp8x;

  const body = concat([new TextEncoder().encode("WEBP"), payload]);
  return concat([
    new TextEncoder().encode("RIFF"),
    le32(body.byteLength),
    body,
  ]);
}

export function svgFixture(width: number, height: number): Uint8Array {
  return new TextEncoder().encode(
    `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%"/></svg>`,
  );
}

export function pdfFixture(): Uint8Array {
  return new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n");
}

// ---------------------------------------------------------------------------

function chunk(type: string, data: Uint8Array): Uint8Array {
  // The CRC is not computed: nothing in the engine validates it, and a fixture
  // that pretended to would be claiming to test something it does not.
  return concat([
    be32(data.byteLength),
    new TextEncoder().encode(type),
    data,
    new Uint8Array([0, 0, 0, 0]),
  ]);
}

function segment(marker: number, data: Uint8Array): Uint8Array {
  return concat([
    new Uint8Array([0xff, marker]),
    be16(data.byteLength + 2),
    data,
  ]);
}

function riffChunk(type: string, data: Uint8Array): Uint8Array {
  const padded = data.byteLength % 2 === 1 ? concat([data, new Uint8Array(1)]) : data; // prettier-ignore
  return concat([
    new TextEncoder().encode(type),
    le32(data.byteLength),
    padded,
  ]);
}

function be16(value: number): Uint8Array {
  return new Uint8Array([(value >> 8) & 0xff, value & 0xff]);
}

function be32(value: number): Uint8Array {
  return new Uint8Array([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

function le16(value: number): Uint8Array {
  return new Uint8Array([value & 0xff, (value >> 8) & 0xff]);
}

function le24(value: number): Uint8Array {
  return new Uint8Array([
    value & 0xff,
    (value >> 8) & 0xff,
    (value >> 16) & 0xff,
  ]);
}

function le32(value: number): Uint8Array {
  return new Uint8Array([
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 24) & 0xff,
  ]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.byteLength;
  }
  return merged;
}
