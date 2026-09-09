import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { encodePng } from "./image-mask";
import { pastePatch, pasteSourceRegion } from "./image-composite";

function solid(
  width: number,
  height: number,
  rgb: [number, number, number],
  patch?: { box: [number, number, number, number]; rgb: [number, number, number] },
) {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const inPatch =
        patch &&
        x >= patch.box[0] &&
        x < patch.box[0] + patch.box[2] &&
        y >= patch.box[1] &&
        y < patch.box[1] + patch.box[3];
      const c = inPatch ? patch.rgb : rgb;
      rgba.set([c[0], c[1], c[2], 255], (y * width + x) * 4);
    }
  }
  return encodePng(width, height, rgba);
}

async function pixel(png: Uint8Array, x: number, y: number) {
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * info.channels;
  return [data[i], data[i + 1], data[i + 2]];
}

describe("pasteSourceRegion", () => {
  it("pastes the source's region over the output at the same normalized box, scaled to the output", async () => {
    // 40x40 blue source with a red 20x20 block at (10,10); 20x20 green output.
    const source = solid(40, 40, [0, 0, 255], { box: [10, 10, 20, 20], rgb: [255, 0, 0] });
    const output = solid(20, 20, [0, 255, 0]);
    const { bytes, box } = await pasteSourceRegion({
      source,
      output,
      region: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 },
    });
    expect(box).toEqual({ left: 5, top: 5, width: 10, height: 10 });
    expect(await pixel(bytes, 10, 10)).toEqual([255, 0, 0]); // inside: red from the source
    expect(await pixel(bytes, 2, 2)).toEqual([0, 255, 0]); // outside: untouched output
    expect(await pixel(bytes, 14, 14)).toEqual([255, 0, 0]);
    expect(await pixel(bytes, 15, 15)).toEqual([0, 255, 0]);
    const meta = await sharp(bytes).metadata();
    expect([meta.width, meta.height, meta.format]).toEqual([20, 20, "png"]);
  });

  it("clamps an out-of-range region and rejects an empty one", async () => {
    const source = solid(10, 10, [0, 0, 255]);
    const output = solid(10, 10, [0, 255, 0]);
    const { box } = await pasteSourceRegion({
      source,
      output,
      region: { x: 0.8, y: 0.8, w: 1, h: 1 },
    });
    expect(box).toEqual({ left: 8, top: 8, width: 2, height: 2 });
    await expect(
      pasteSourceRegion({ source, output, region: { x: 2, y: 2, w: 0.1, h: 0.1 } }),
    ).rejects.toThrow(/empty/);
  });

  it("maps a non-square region onto a non-square output without transposing or stretching", async () => {
    const source = solid(40, 20, [0, 0, 255], { box: [4, 6, 12, 8], rgb: [255, 0, 0] });
    const output = solid(15, 25, [0, 255, 0]);
    const { bytes, box } = await pasteSourceRegion({
      source,
      output,
      region: { x: 0.1, y: 0.3, w: 0.3, h: 0.4 },
    });
    expect(box).toEqual({ left: 2, top: 12, width: 4, height: 3 });
    expect(await pixel(bytes, box.left, box.top)).toEqual([255, 0, 0]);
    expect(await pixel(bytes, box.left + box.width - 1, box.top + box.height - 1)).toEqual([255, 0, 0]);
    expect(await pixel(bytes, box.left - 1, box.top)).toEqual([0, 255, 0]);
    expect(await pixel(bytes, box.left, box.top - 1)).toEqual([0, 255, 0]);
    expect(await pixel(bytes, box.left, box.top + box.height)).toEqual([0, 255, 0]);
  });
});

describe("pastePatch", () => {
  it("uniform-fits an alpha patch into the output box and keeps the output visible where the patch is transparent", async () => {
    // 4x4 patch: opaque red left half, fully transparent right half.
    const rgba = new Uint8Array(4 * 4 * 4);
    for (let y = 0; y < 4; y += 1) for (let x = 0; x < 4; x += 1) rgba.set(x < 2 ? [255, 0, 0, 255] : [0, 0, 0, 0], (y * 4 + x) * 4);
    const patch = encodePng(4, 4, rgba);
    const output = solid(20, 20, [0, 255, 0]);
    const { bytes, box } = await pastePatch({ output, patch, region: { x: 0.5, y: 0.5, w: 0.4, h: 0.2 } });
    // Output box is 8x4; a 4x4 patch fits uniformly as 4x4 centred: left 10+2, top 10.
    expect(box).toEqual({ left: 12, top: 10, width: 4, height: 4 });
    expect(await pixel(bytes, 12, 11)).toEqual([255, 0, 0]); // opaque half
    expect(await pixel(bytes, 15, 11)).toEqual([0, 255, 0]); // transparent half shows the output
    expect(await pixel(bytes, 10, 11)).toEqual([0, 255, 0]); // band left of the centred patch
  });

  it("bottom-aligns the patch inside the box when asked, so the product rests on the surface", async () => {
    const rgba = new Uint8Array(4 * 4 * 4);
    for (let i = 0; i < 16; i += 1) rgba.set([255, 0, 0, 255], i * 4);
    const patch = encodePng(4, 4, rgba);
    const output = solid(20, 20, [0, 255, 0]);
    // Box is 4 wide by 8 tall at (10, 6); a 4x4 patch fits at width 4 and sits at the bottom: top 6+8-4.
    const { bytes, box } = await pastePatch({ output, patch, region: { x: 0.5, y: 0.3, w: 0.2, h: 0.4 }, align: "bottom" });
    expect(box).toEqual({ left: 10, top: 10, width: 4, height: 4 });
    expect(await pixel(bytes, 11, 12)).toEqual([255, 0, 0]);
    expect(await pixel(bytes, 11, 7)).toEqual([0, 255, 0]); // empty band above the bottom-aligned patch
  });
});
