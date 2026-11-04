import { deflateSync } from "node:zlib";

/** Synthetic 256x256 RGB red field: a clear visual target, not an image-size limit. */
export function redPng(): Buffer {
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const v of b) {
      c ^= v;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
    }
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const t = Buffer.from(type), length = Buffer.alloc(4), sum = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    sum.writeUInt32BE(crc(Buffer.concat([t, data])));
    return Buffer.concat([length, t, data, sum]);
  };
  const size = 256, ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.alloc(1 + size * 3);
  for (let x = 0; x < size; x++) row[1 + x * 3] = 255;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: size }, () => row)))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Answer mismatch is a stage result, never an account refusal or retry signal. */
export function answerFailure(label: string, text: string): string | undefined {
  if (label.startsWith("effort-") && !/\b323\b/.test(text)) return "Synthetic arithmetic proof failed";
  if (label.startsWith("image-") && !/\bred\b/i.test(text)) return "Synthetic visual proof failed";
}
