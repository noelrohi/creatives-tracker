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

  it("caps the fitted width at maxWidth of the output", async () => {
    const rgba = new Uint8Array(4 * 4 * 4);
    for (let i = 0; i < 16; i += 1) rgba.set([255, 0, 0, 255], i * 4);
    const patch = encodePng(4, 4, rgba);
    const output = solid(40, 40, [0, 255, 0]);
    // Box is 20x20 at (10,10); a 4x4 patch would fit to 20 wide; the cap 0.25 allows 10.
    const { box } = await pastePatch({ output, patch, region: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, align: "bottom", maxWidth: 0.25 });
    expect(box).toEqual({ left: 15, top: 20, width: 10, height: 10 });
  });

  it("draws a soft shadow under the patch when asked and leaves the output alone otherwise", async () => {
    const rgba = new Uint8Array(4 * 4 * 4);
    for (let i = 0; i < 16; i += 1) rgba.set([255, 0, 0, 255], i * 4);
    const patch = encodePng(4, 4, rgba);
    const output = solid(60, 60, [240, 240, 240]);
    const region = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };
    const plain = await pastePatch({ output, patch, region, align: "bottom" });
    const shaded = await pastePatch({ output, patch, region, align: "bottom", shadow: true });
    // Just below the patch's bottom edge, in the ellipse's blur skirt: darker with the shadow.
    const below = shaded.box.top + shaded.box.height + 1;
    const [r] = await pixel(shaded.bytes, 30, below);
    const [plainR] = await pixel(plain.bytes, 30, below);
    expect(plainR).toBe(240);
    expect(plain.blend).toEqual({ lightGain: 1, shadowOpacity: 0, channelGains: [1, 1, 1] });
    // Measured 199 with libvips' blur kernel; assert a clear darkening, not the exact value.
    expect(r).toBeLessThan(plainR - 20);
    // Far from the patch: untouched.
    expect(await pixel(shaded.bytes, 2, 2)).toEqual([240, 240, 240]);
    expect(shaded.blend.shadowOpacity).toBeGreaterThan(0.4); // light surface => visible shadow
  });

  it("brightens or darkens the patch toward the surrounding light within bounds", async () => {
    const rgba = new Uint8Array(4 * 4 * 4);
    for (let i = 0; i < 16; i += 1) rgba.set([200, 200, 200, 255], i * 4);
    const patch = encodePng(4, 4, rgba);
    const dark = await pastePatch({ output: solid(60, 60, [20, 20, 20]), patch, region: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, matchLight: true });
    const [darkR] = await pixel(dark.bytes, 30, 30);
    expect(darkR).toBeLessThan(200);
    expect(darkR).toBeGreaterThanOrEqual(100); // 0.5 floor
    expect(dark.blend.lightGain).toBeCloseTo(0.5, 2);
    const bright = await pastePatch({ output: solid(60, 60, [255, 255, 255]), patch, region: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, matchLight: true });
    const [brightR] = await pixel(bright.bytes, 30, 30);
    expect(brightR).toBeGreaterThan(200);
    expect(brightR).toBeLessThanOrEqual(250); // 1.25 ceiling
  });

  it("picks up a mild colour cast from the surroundings without changing the product's hue", async () => {
    const rgba = new Uint8Array(4 * 4 * 4);
    for (let i = 0; i < 16; i += 1) rgba.set([200, 200, 200, 255], i * 4);
    const patch = encodePng(4, 4, rgba);
    const warm = await pastePatch({ output: solid(60, 60, [200, 150, 100]), patch, region: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, matchLight: true });
    const [r, , b] = await pixel(warm.bytes, 30, 30);
    expect(r).toBeGreaterThan(b); // warmer
    expect(r - b).toBeLessThan(40); // but only mildly (15% of the way)
  });

  it("clips the shadow at the canvas edge instead of failing", async () => {
    const rgba = new Uint8Array(4 * 4 * 4);
    for (let i = 0; i < 16; i += 1) rgba.set([255, 0, 0, 255], i * 4);
    const patch = encodePng(4, 4, rgba);
    const output = solid(120, 120, [240, 240, 240]);
    // The box hugs the top-left corner, so the padded shadow canvas hangs off it.
    const { bytes, box, blend } = await pastePatch({ output, patch, region: { x: 0, y: 0, w: 0.3, h: 0.3 }, align: "bottom", shadow: true });
    expect(box).toEqual({ left: 0, top: 0, width: 36, height: 36 });
    expect(blend.shadowOpacity).toBeGreaterThan(0.4);
    const [r] = await pixel(bytes, 4, box.top + box.height + 1);
    expect(r).toBeLessThan(240);
  });

  it("keeps every channel inside the cast envelope when the surroundings are extreme", async () => {
    const rgba = new Uint8Array(4 * 4 * 4);
    for (let i = 0; i < 16; i += 1) rgba.set([200, 200, 200, 255], i * 4);
    const patch = encodePng(4, 4, rgba);
    const region = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };
    // A black ring: every channel's cast ratio is 0, and the floor 0.5 * 0.85 holds.
    const black = await pastePatch({ output: solid(60, 60, [0, 0, 0]), patch, region, matchLight: true });
    const dark = await pixel(black.bytes, 30, 30);
    for (const channel of dark) expect(channel).toBeGreaterThanOrEqual(Math.floor(200 * 0.5 * 0.85));
    expect(black.blend.lightGain).toBeCloseTo(0.5, 2);
    // A saturated blue ring: blue's ratio is huge, and the ceiling 1.25 * 1.15 holds.
    const blue = await pastePatch({ output: solid(60, 60, [0, 0, 255]), patch, region, matchLight: true });
    expect(blue.blend.channelGains[2]).toBeLessThanOrEqual(1.25 * 1.15);
  });

  it("matches the light on a greyscale patch, which decodes to a single band", async () => {
    const rgba = new Uint8Array(4 * 4 * 4);
    for (let i = 0; i < 16; i += 1) rgba.set([200, 200, 200, 255], i * 4);
    const grey = new Uint8Array(await sharp(encodePng(4, 4, rgba)).toColourspace("b-w").png().toBuffer());
    expect((await sharp(grey).metadata()).channels).toBeLessThan(3);
    const lit = await pastePatch({ output: solid(60, 60, [20, 20, 20]), patch: grey, region: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, matchLight: true });
    expect(lit.blend.lightGain).toBeCloseTo(0.5, 2);
    const [r] = await pixel(lit.bytes, 30, 30);
    expect(r).toBeLessThan(200);
    expect(r).toBeGreaterThanOrEqual(Math.floor(200 * 0.5 * 0.85));
  });

  it("leaves the output showing through the patch's transparent half while matching light", async () => {
    const rgba = new Uint8Array(4 * 4 * 4);
    for (let y = 0; y < 4; y += 1) for (let x = 0; x < 4; x += 1) rgba.set(x < 2 ? [200, 200, 200, 255] : [0, 0, 0, 0], (y * 4 + x) * 4);
    const patch = encodePng(4, 4, rgba);
    const lit = await pastePatch({ output: solid(60, 60, [20, 20, 20]), patch, region: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, matchLight: true });
    expect(await pixel(lit.bytes, 40, 30)).toEqual([20, 20, 20]); // transparent half: the room shows through
    const [r] = await pixel(lit.bytes, 20, 30);
    expect(r).toBeLessThan(200); // opaque half: darkened toward the room
  });
});
