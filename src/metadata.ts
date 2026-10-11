import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { TextDecoder } from "node:util";

const maxBytes = 64 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export class MetadataError extends Error {
  constructor(
    readonly path: string,
    readonly reason: "malformed" | "unreadable" | "unsupported",
    readonly code?: string,
  ) {
    super(reason);
  }
}

function inspect<T>(path: string, operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof MetadataError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    throw new MetadataError(path, "unreadable", typeof code === "string" ? code : undefined);
  }
}

function decode(bytes: Uint8Array, path: string): string {
  try {
    return decoder.decode(bytes);
  } catch {
    throw new MetadataError(path, "malformed");
  }
}

export function canonicalize(path: string): string {
  return inspect(path, () => {
    const decoded = decode(realpathSync(path, { encoding: "buffer" }), path);
    const canonical = realpathSync(path);
    if (canonical !== decoded) throw new MetadataError(path, "malformed");
    return canonical;
  });
}

export function requireDirectory(path: string): void {
  inspect(path, () => {
    if (!statSync(path).isDirectory()) throw new MetadataError(path, "malformed");
    readdirSync(path);
  });
}

export function markerExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    return inspect(path, () => {
      throw error;
    });
  }
}

export function isDirectory(path: string): boolean {
  return inspect(path, () => statSync(path).isDirectory());
}

export function readMetadata(path: string): string {
  return inspect(path, () => {
    const before = statSync(path);
    if (!before.isFile() || before.size > maxBytes) throw new MetadataError(path, "malformed");
    const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.size > maxBytes) throw new MetadataError(path, "malformed");
      const bytes = Buffer.alloc(maxBytes + 1);
      let length = 0;
      while (length < bytes.length) {
        const count = readSync(fd, bytes, length, bytes.length - length, null);
        if (count === 0) break;
        length += count;
      }
      if (length > maxBytes) throw new MetadataError(path, "malformed");
      return decode(bytes.subarray(0, length), path);
    } finally {
      closeSync(fd);
    }
  });
}

export function linePointer(path: string, prefix = ""): string {
  const text = readMetadata(path);
  if (!text.startsWith(prefix)) throw new MetadataError(path, "malformed");
  const value = text.slice(prefix.length).replace(/\r?\n$/, "");
  if (!value || /[\r\n\0]/.test(value)) throw new MetadataError(path, "malformed");
  return value;
}
