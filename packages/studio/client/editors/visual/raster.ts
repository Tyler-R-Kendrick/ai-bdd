/** Removes only color-connected edge pixels. This is a deterministic matte, not AI segmentation. */
export function removeEdgeColor(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  tolerance: number,
): Uint8ClampedArray {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width * height > 16_000_000 ||
    data.length !== width * height * 4
  )
    throw new Error("Raster editing supports images up to 16 megapixels.");
  if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > 128)
    throw new Error("Color tolerance must be between 0 and 128.");
  const output = new Uint8ClampedArray(data),
    seen = new Uint8Array(width * height),
    queue = new Uint32Array(width * height),
    background = [data[0]!, data[1]!, data[2]!];
  let head = 0,
    tail = 0;
  const threshold = tolerance * tolerance * 3;
  const push = (index: number) => {
    if (seen[index]) return;
    seen[index] = 1;
    const p = index * 4,
      distance =
        (data[p]! - background[0]!) ** 2 +
        (data[p + 1]! - background[1]!) ** 2 +
        (data[p + 2]! - background[2]!) ** 2;
    if (data[p + 3] === 0 || distance <= threshold) queue[tail++] = index;
  };
  for (let x = 0; x < width; x++) {
    push(x);
    push((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    push(y * width);
    push(y * width + width - 1);
  }
  while (head < tail) {
    const index = queue[head++]!;
    output[index * 4 + 3] = 0;
    const x = index % width,
      y = Math.floor(index / width);
    if (x > 0) push(index - 1);
    if (x + 1 < width) push(index + 1);
    if (y > 0) push(index - width);
    if (y + 1 < height) push(index + width);
  }
  return output;
}
