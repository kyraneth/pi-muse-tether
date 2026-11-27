import { it, expect } from "vitest";
import { createReadToolDefinition } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { museCatalogModels } from "../src/catalog.js";
import { toolResultReceipt } from "../src/tool-result-receipt.js";

it("native Pi read normalizes a BMP swatch before the Muse receipt, honoring auto-resize", async () => {
  const catalog = JSON.parse(readFileSync(new URL("fixtures/provider-catalog-window.json", import.meta.url), "utf8"));
  const model = museCatalogModels(catalog).find(model => model.id === "muse-spark-1.2")!;
  const maxWidth = model.inputLimits?.images?.resize?.maxWidth;
  expect(maxWidth).toBeGreaterThan(0);
  const width = maxWidth! + 1, height = 2;
  const stride = Math.ceil(width * 3 / 4) * 4;
  const bmp = Buffer.alloc(54 + stride * height, 0);
  bmp.write("BM"); bmp.writeUInt32LE(bmp.length, 2); bmp.writeUInt32LE(54, 10);
  bmp.writeUInt32LE(40, 14); bmp.writeInt32LE(width, 18); bmp.writeInt32LE(height, 22);
  bmp.writeUInt16LE(1, 26); bmp.writeUInt16LE(24, 28); bmp.writeUInt32LE(stride * height, 34);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) bmp.writeUIntBE(x < width / 2 ? 0x0011ee : 0xff2200, 54 + y * stride + x * 3, 3);
  }
  const root = await mkdtemp(join(tmpdir(), "muse-reference-image-"));
  await writeFile(join(root, "swatch.bmp"), bmp);
  const variants: Buffer[] = [];
  for (const autoResizeImages of [true, false]) {
    const nativeRead = createReadToolDefinition(root, { autoResizeImages });
    const sent = await nativeRead.execute("swatch", { path: "swatch.bmp" }, undefined, undefined, { cwd: root, model } as any);
    const [note, image] = sent.content;
    expect(note).toMatchObject({ type: "text", text: expect.stringContaining("Image converted from image/bmp to image/png") });
    expect(image).toMatchObject({ type: "image", mimeType: "image/png" });
    if (note.type !== "text" || image.type !== "image") throw new Error("No normalized image part");
    const bytes = Buffer.from(image.data, "base64");
    variants.push(bytes);
    expect(bytes.readUInt32BE(16)).toBe(autoResizeImages ? maxWidth : width);
    const images: any[] = [];
    expect(toolResultReceipt({ status: "completed",
      visibleOutput: `${note.text}\n[MCP image content: media_type=${image.mimeType}, bytes=${bytes.length}]`,
    }, sent, undefined, undefined, receipt => images.push(...receipt))).toBe(sent);
    expect(images).toEqual([{ partIndex: 1, sha256: createHash("sha256").update(bytes).digest("hex"), byteLen: bytes.length, mimeType: "image/png" }]);
  }
  expect(variants[0]).not.toEqual(variants[1]);
});
