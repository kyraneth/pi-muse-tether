import { it, expect } from "vitest";
import { inflateSync } from "node:zlib";
import { redPng, answerFailure } from "../scripts/verification-support.js";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

it("Verification image has valid PNG CRCs and decodes entirely red at 256x256", () => {
  const png = redPng();
  expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const chunks: Buffer[] = [];
  let offset = 8, width = 0, height = 0;
  // Recompute CRC from the serialized chunks, not the producer's result.
  function checksum(b: Buffer) {
    let c = 0xffffffff;
    for (const v of b) {
      c ^= v;
      for (let n = 0; n < 8; n++) c = (c & 1) ? ((c >>> 1) ^ 0xedb88320) : c >>> 1;
    }
    return (~c) >>> 0;
  }
  while (offset < png.length) {
    const n = png.readUInt32BE(offset), type = png.toString("ascii", offset + 4, offset + 8);
    const body = png.subarray(offset + 8, offset + 8 + n);
    expect(png.readUInt32BE(offset + 8 + n)).toBe(checksum(png.subarray(offset + 4, offset + 8 + n)));
    if (type === "IHDR") {
      width = body.readUInt32BE(0); height = body.readUInt32BE(4);
      expect([...body.subarray(8)]).toEqual([8, 2, 0, 0, 0]);
    }
    if (type === "IDAT") chunks.push(body);
    offset += n + 12;
  }
  expect([width, height]).toEqual([256, 256]);
  const pixels = inflateSync(Buffer.concat(chunks));
  expect(pixels.length).toBe(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3);
    expect(pixels[row]).toBe(0);
    for (let x = 0; x < width; x++) {
      const p = row + 1 + x * 3;
      if (pixels[p] !== 255 || pixels[p + 1] !== 0 || pixels[p + 2] !== 0) throw new Error("Not solid red");
    }
  }
});
it("expected answers retain the red check, and mismatch is not a refusal", () => {
  expect(answerFailure("image-current", "gray")).toMatch(/visual proof failed/);
  expect(answerFailure("image-import", "RED")).toBeUndefined();
  expect(answerFailure("effort-max", "322")).toMatch(/arithmetic proof failed/);
  expect(answerFailure("effort-max", "323")).toBeUndefined();
});
it("native offline verification mismatches fail overall AFTER read, cache and ledger", async () => {
  const parent = await mkdtemp(join(tmpdir(), "verification-mismatch-")), out = join(parent, "proof");
  const env = { ...process.env }; delete env.META_API_KEY; delete env.PI_MUSE_TETHER_LIVE;
  const child = spawn(process.execPath, ["--import", "tsx", "scripts/live-verification.mts", "--offline", "--check-answers", out], { cwd: resolve("."), env, stdio: ["ignore", "pipe", "pipe"] });
  let diagnostics = "";
  child.stdout.on("data", b => diagnostics += b); child.stderr.on("data", b => diagnostics += b);
  const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  const rows = (await readFile(join(out, "telemetry.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  expect(code, diagnostics).toBe(1);
  expect(rows.some(r => r.type === "proof-failure" && r.label === "image-current")).toBe(true);
  for (const label of ["image-current", "image-import", "ledger-tool", "cache-warm"])
    expect(rows.some(r => r.type === "measurement" && r.label === label)).toBe(true);
  expect(rows.at(-1).type).toBe("ledger-readback");
  expect(rows.find(r => r.type === "finished").forbidden).toBe(false);
});
