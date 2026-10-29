import {
  checkCodeProject,
  CODE_SOURCE_LIMIT,
  validCodePath,
  entryFile,
  type CodeProject,
} from "./code-project.ts";
const encoder = new TextEncoder(),
  decoder = new TextDecoder("utf-8", { fatal: true });
const table = Array.from({ length: 256 }, (_, i) => {
  let value = i;
  for (let bit = 0; bit < 8; bit++)
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = table[(crc ^ byte) & 255]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function concat(parts: Uint8Array[]) {
  const result = new Uint8Array(
    parts.reduce((size, part) => size + part.length, 0),
  );
  let at = 0;
  for (const part of parts) {
    result.set(part, at);
    at += part.length;
  }
  return result;
}
function header(length: number, signature: number) {
  const bytes = new Uint8Array(length);
  new DataView(bytes.buffer).setUint32(0, signature, true);
  return { bytes, view: new DataView(bytes.buffer) };
}
/** Standards-compliant ZIP/STORE export; no server files, scripts, or package installation. */
export function exportCodeZip(project: CodeProject): Uint8Array {
  checkCodeProject(project);
  const files = project.files;
  const local: Uint8Array[] = [],
    central: Uint8Array[] = [];
  let offset = 0;
  for (const [path, source] of Object.entries(files)) {
    const name = encoder.encode(path),
      data = encoder.encode(source),
      crc = crc32(data);
    const entry = header(30, 0x04034b50);
    entry.view.setUint16(4, 20, true);
    entry.view.setUint16(6, 0x800, true);
    entry.view.setUint32(14, crc, true);
    entry.view.setUint32(18, data.length, true);
    entry.view.setUint32(22, data.length, true);
    entry.view.setUint16(26, name.length, true);
    local.push(entry.bytes, name, data);
    const record = header(46, 0x02014b50);
    record.view.setUint16(4, 20, true);
    record.view.setUint16(6, 20, true);
    record.view.setUint16(8, 0x800, true);
    record.view.setUint32(16, crc, true);
    record.view.setUint32(20, data.length, true);
    record.view.setUint32(24, data.length, true);
    record.view.setUint16(28, name.length, true);
    record.view.setUint32(42, offset, true);
    central.push(record.bytes, name);
    offset += entry.bytes.length + name.length + data.length;
  }
  const directory = concat(central),
    end = header(22, 0x06054b50),
    count = Object.keys(files).length;
  end.view.setUint16(8, count, true);
  end.view.setUint16(10, count, true);
  end.view.setUint32(12, directory.length, true);
  end.view.setUint32(16, offset, true);
  const metadata = encoder.encode(
    JSON.stringify({ studioProject: 1, entry: project.entry }),
  );
  end.view.setUint16(20, metadata.length, true);
  return concat([...local, directory, end.bytes, metadata]);
}
async function inflate(bytes: Uint8Array, expected: number) {
  const stream = new Blob([new Uint8Array(bytes).buffer])
    .stream()
    .pipeThrough(new DecompressionStream("deflate-raw"));
  const reader = stream.getReader(),
    parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > expected || size > CODE_SOURCE_LIMIT)
        throw new Error("ZIP entry exceeds its declared size");
      parts.push(next.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  return concat(parts);
}
/** Reads bounded UTF-8 STORE/DEFLATE project archives; verifies path, size, duplicate and CRC integrity. */
export async function importCodeZip(bytes: Uint8Array): Promise<CodeProject> {
  if (bytes.length > 4_000_000 || bytes.length < 22)
    throw new Error("Choose a project ZIP smaller than 4 MB");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (
    let at = bytes.length - 22;
    at >= Math.max(0, bytes.length - 65557);
    at--
  )
    if (
      view.getUint32(at, true) === 0x06054b50 &&
      at + 22 + view.getUint16(at + 20, true) === bytes.length
    ) {
      end = at;
      break;
    }
  if (end < 0) throw new Error("The ZIP central directory is missing");
  if (
    view.getUint16(end + 4, true) ||
    view.getUint16(end + 6, true) ||
    view.getUint16(end + 8, true) !== view.getUint16(end + 10, true)
  )
    throw new Error("Multi-volume ZIP archives are unsupported");
  const count = view.getUint16(end + 10, true),
    directorySize = view.getUint32(end + 12, true),
    directoryOffset = view.getUint32(end + 16, true);
  if (count > 150 || directoryOffset + directorySize !== end)
    throw new Error("Invalid or oversized ZIP directory");
  let at = directoryOffset,
    total = 0;
  const files: Record<string, string> = {},
    seen = new Set<string>();
  let entry: string | undefined;
  try {
    const metadata = JSON.parse(decoder.decode(bytes.subarray(end + 22)));
    if (metadata.studioProject === 1 && typeof metadata.entry === "string")
      entry = metadata.entry;
  } catch {
    /* Generic ZIP comments are not project metadata. */
  }
  for (let index = 0; index < count; index++) {
    if (at + 46 > end || view.getUint32(at, true) !== 0x02014b50)
      throw new Error("Invalid ZIP directory entry");
    const flags = view.getUint16(at + 8, true),
      method = view.getUint16(at + 10, true),
      crc = view.getUint32(at + 16, true),
      packed = view.getUint32(at + 20, true),
      size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true),
      extra = view.getUint16(at + 30, true),
      comment = view.getUint16(at + 32, true),
      local = view.getUint32(at + 42, true),
      attributes = view.getUint32(at + 38, true);
    if (at + 46 + nameLength + extra + comment > end)
      throw new Error("Truncated ZIP entry");
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extra + comment;
    if (name.endsWith("/")) {
      if (!validCodePath(name.slice(0, -1)))
        throw new Error("Unsafe ZIP directory path");
      continue;
    }
    if (
      !validCodePath(name) ||
      seen.has(name) ||
      ((attributes >>> 16) & 0xf000) === 0xa000
    )
      throw new Error("Unsafe or duplicate ZIP file path");
    seen.add(name);
    total += size;
    if (
      size > 500_000 ||
      total > CODE_SOURCE_LIMIT + 10_000 ||
      seen.size > 51 ||
      flags & 1 ||
      ![0, 8].includes(method)
    )
      throw new Error("Unsupported, encrypted, or oversized ZIP entry");
    if (
      local + 30 > directoryOffset ||
      view.getUint32(local, true) !== 0x04034b50
    )
      throw new Error("Invalid ZIP local header");
    const localName = view.getUint16(local + 26, true),
      localExtra = view.getUint16(local + 28, true),
      start = local + 30 + localName + localExtra;
    if (
      view.getUint16(local + 8, true) !== method ||
      start + packed > directoryOffset ||
      decoder.decode(bytes.subarray(local + 30, local + 30 + localName)) !==
        name
    )
      throw new Error("ZIP local header does not match directory");
    const data =
      method === 0
        ? bytes.subarray(start, start + packed)
        : await inflate(bytes.subarray(start, start + packed), size);
    if (data.length !== size || crc32(data) !== crc)
      throw new Error("ZIP file integrity check failed");
    const source = decoder.decode(data);
    files[name] = source;
  }
  if (at !== end) throw new Error("Unexpected ZIP directory data");
  entry ??= [
    "index.html",
    "src/main.tsx",
    "src/main.jsx",
    "src/App.tsx",
    "src/App.jsx",
    "main.tsx",
    "App.tsx",
    "index.js",
  ].find((name) => Object.hasOwn(files, name));
  entry ??= Object.keys(files).find(entryFile);
  if (!entry)
    throw new Error(
      "ZIP has no HTML, JavaScript, JSX, or TypeScript entry file.",
    );
  return checkCodeProject({ files, entry });
}
