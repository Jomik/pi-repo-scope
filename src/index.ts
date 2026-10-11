import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  canonicalize,
  isDirectory,
  linePointer,
  markerExists,
  MetadataError,
  readMetadata,
  requireDirectory,
} from "./metadata.js";

export type RepoScope =
  | { status: "found"; identity: string; configDir: string }
  | { status: "none"; canonicalInputDirectory: string }
  | {
      status: "invalid";
      stage: "input" | "metadata";
      reason: "malformed" | "unreadable" | "unsupported";
      path: string;
      code?: string;
      canonicalInputDirectory?: string;
    };

function validInput(path: string): boolean {
  return typeof path === "string" && path.isWellFormed() && !path.includes("\0") && isAbsolute(path);
}

function gitStorage(marker: string): string {
  const gitDir = canonicalize(isDirectory(marker) ? marker : resolve(dirname(marker), linePointer(marker, "gitdir: ")));
  requireDirectory(gitDir);
  const head = join(gitDir, "HEAD");
  if (!/^(?:ref: refs\/[^\s\0]+|[0-9a-fA-F]{40}|[0-9a-fA-F]{64})\r?\n?$/.test(readMetadata(head))) {
    throw new MetadataError(head, "malformed");
  }
  const commonMarker = join(gitDir, "commondir");
  const common = markerExists(commonMarker) ? canonicalize(resolve(gitDir, linePointer(commonMarker))) : gitDir;
  requireDirectory(common);
  requireDirectory(join(common, "objects"));
  requireDirectory(join(common, "refs"));
  return common;
}

/** Resolve physical repository ancestry without creating or inspecting shared config storage. */
export function resolveRepoScope(cwd: string, sharedConfigBase: string): RepoScope {
  for (const input of [cwd, sharedConfigBase]) {
    if (!validInput(input)) {
      return { status: "invalid", stage: "input", reason: "malformed", path: typeof input === "string" ? input : "" };
    }
  }
  const base = resolve(sharedConfigBase);
  let stage: "input" | "metadata" = "input";
  let canonicalInputDirectory: string | undefined;
  try {
    const canonical = canonicalize(cwd);
    requireDirectory(canonical);
    canonicalInputDirectory = canonical;
    stage = "metadata";
    let directory = canonical;
    for (;;) {
      const jj = join(directory, ".jj");
      if (markerExists(jj)) throw new MetadataError(jj, "unsupported");
      const git = join(directory, ".git");
      if (markerExists(git)) {
        const storage = gitStorage(git);
        const identity = createHash("sha256").update(`git\0${storage}`, "utf8").digest("hex");
        return { status: "found", identity, configDir: join(base, identity) };
      }
      const parent = dirname(directory);
      if (parent === directory) return { status: "none", canonicalInputDirectory: canonical };
      directory = parent;
    }
  } catch (error) {
    if (!(error instanceof MetadataError)) throw error;
    return {
      status: "invalid",
      stage,
      reason: error.reason,
      path: error.path,
      ...(error.code === undefined ? {} : { code: error.code }),
      ...(canonicalInputDirectory === undefined ? {} : { canonicalInputDirectory }),
    };
  }
}
