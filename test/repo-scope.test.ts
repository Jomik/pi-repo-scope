import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveRepoScope } from "../src/index.js";
import { MetadataError, readMetadata } from "../src/metadata.js";

let temp: string;
let base: string;

beforeEach(() => {
  temp = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "repo-scope-")));
  base = join(temp, "absent", "config");
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(temp, { recursive: true, force: true });
});

function directory(path: string): string {
  fs.mkdirSync(path, { recursive: true });
  return path;
}

function gitStorage(path: string, head = "ref: refs/heads/main\n"): string {
  directory(join(path, "objects"));
  directory(join(path, "refs"));
  fs.writeFileSync(join(path, "HEAD"), head);
  return path;
}

function repository(name = "repo", head?: string): string {
  const root = directory(join(temp, name));
  gitStorage(join(root, ".git"), head);
  return root;
}

function expected(storage: string) {
  // Independent byte construction of the git + NUL + canonical-path hash vector.
  const identity = createHash("sha256")
    .update(Buffer.concat([Buffer.from("git"), Buffer.from([0]), Buffer.from(fs.realpathSync(storage), "utf8")]))
    .digest("hex");
  return { status: "found", identity, configDir: join(resolve(base), identity) };
}

function invalid(path: string, reason = "malformed", canonicalInputDirectory?: string) {
  return {
    status: "invalid",
    stage: canonicalInputDirectory === undefined ? "input" : "metadata",
    reason,
    path,
    ...(canonicalInputDirectory === undefined ? {} : { canonicalInputDirectory }),
  };
}

describe("resolveRepoScope", () => {
  it.each(["ref: refs/heads/main\n", "a".repeat(40), `${"A".repeat(64)}\r\n`])(
    "resolves ordinary/unborn and detached repositories: %s",
    (head) => {
      const root = repository("repo", head);
      const cwd = directory(join(root, "nested", "deep"));
      const result = resolveRepoScope(cwd, base);
      expect(result).toEqual(expected(join(root, ".git")));
      expect(Object.keys(result).sort()).toEqual(["configDir", "identity", "status"]);
      expect(fs.existsSync(dirname(base))).toBe(false);
    },
  );

  it("walks physical ancestry through aliases without normalizing case", () => {
    const root = repository("MixedCase");
    const nested = directory(join(root, "nested"));
    const alias = join(temp, "alias");
    fs.symlinkSync(nested, alias, "dir");
    expect(resolveRepoScope(alias, join(base, "..", "config"))).toEqual(expected(join(root, ".git")));
  });

  it("returns only canonical input for no repository and does not touch the base", () => {
    const empty = directory(join(temp, "empty"));
    const result = resolveRepoScope(empty, base);
    expect(result).toEqual({ status: "none", canonicalInputDirectory: empty });
    expect(Object.keys(result).sort()).toEqual(["canonicalInputDirectory", "status"]);
    const fileBase = join(temp, "file-base");
    fs.writeFileSync(fileBase, "untouched");
    expect(resolveRepoScope(empty, join(fileBase, "child"))).toEqual(result);
    expect(fs.readFileSync(fileBase, "utf8")).toBe("untouched");
    expect(fs.existsSync(dirname(base))).toBe(false);
  });

  it.each(["", "relative", "relative/../path", "/bad\0path", "/bad\ud800path", "/bad\udfffpath"])(
    "rejects invalid cwd and base strings: %s",
    (input) => {
      expect(resolveRepoScope(input, base)).toEqual(invalid(input));
      expect(resolveRepoScope(temp, input)).toEqual(invalid(input));
    },
  );

  it("classifies nonexistent and non-directory cwd as input failures", () => {
    const missing = join(temp, "missing");
    expect(resolveRepoScope(missing, base)).toEqual({ ...invalid(missing, "unreadable"), code: "ENOENT" });
    const file = join(temp, "file");
    fs.writeFileSync(file, "contents");
    expect(resolveRepoScope(file, base)).toEqual(invalid(file));
  });

  it.each(["relative", "absolute"])("accepts %s gitdir line pointers with preserved spaces", (kind) => {
    const root = directory(join(temp, "work"));
    const storage = gitStorage(join(temp, " storage "));
    fs.writeFileSync(join(root, ".git"), `gitdir: ${kind === "relative" ? "../ storage " : storage}\r\n`);
    expect(resolveRepoScope(root, base)).toEqual(expected(storage));
  });

  it("groups linked worktrees by common storage and keeps clones and submodules separate", () => {
    const root = repository();
    const common = join(root, ".git");
    const work = directory(join(temp, "work"));
    const privateDir = directory(join(common, "worktrees", "work"));
    fs.writeFileSync(join(privateDir, "HEAD"), "ref: refs/heads/work\n");
    fs.writeFileSync(join(privateDir, "commondir"), "../..\n");
    fs.writeFileSync(join(work, ".git"), `gitdir: ${privateDir}\n`);
    expect(resolveRepoScope(work, base)).toEqual(resolveRepoScope(root, base));
    fs.writeFileSync(join(privateDir, "commondir"), `${common}\r\n`);
    expect(resolveRepoScope(work, base)).toEqual(expected(common));
    const clone = repository("clone");
    expect(resolveRepoScope(clone, base)).not.toEqual(resolveRepoScope(root, base));
    const submodule = directory(join(root, "submodule"));
    const subStorage = gitStorage(join(common, "modules", "submodule"));
    fs.writeFileSync(join(submodule, ".git"), "gitdir: ../.git/modules/submodule\n");
    expect(resolveRepoScope(submodule, base)).toEqual(expected(subStorage));
    expect(resolveRepoScope(submodule, base)).not.toEqual(resolveRepoScope(root, base));
  });

  it.each([
    "gitdir: \n",
    "gitdir: target\n\n",
    "gitdir: target\r",
    "gitdir: target\0",
    "gitdir:target",
    "\ufeffgitdir: target",
  ])("stops at malformed nested pointers without parent fallback: %s", (text) => {
    const root = repository();
    const nested = directory(join(root, "nested"));
    const marker = join(nested, ".git");
    fs.writeFileSync(marker, text);
    expect(resolveRepoScope(nested, base)).toEqual(invalid(marker, "malformed", nested));
  });

  it("distinguishes absent markers from broken symlinks and target failures", () => {
    const root = repository();
    const nested = directory(join(root, "nested"));
    const marker = join(nested, ".git");
    fs.symlinkSync(join(temp, "missing"), marker);
    expect(resolveRepoScope(nested, base)).toEqual({ ...invalid(marker, "unreadable", nested), code: "ENOENT" });
    fs.unlinkSync(marker);
    fs.writeFileSync(marker, "gitdir: ../missing\n");
    expect(resolveRepoScope(nested, base)).toEqual({
      ...invalid(join(root, "missing"), "unreadable", nested),
      code: "ENOENT",
    });
  });

  it.each(["directory", "file", "broken"])("gives same-level jj %s markers precedence", (kind) => {
    const root = repository();
    const marker = join(root, ".jj");
    if (kind === "directory") directory(marker);
    else if (kind === "file") fs.writeFileSync(marker, "not supported yet");
    else fs.symlinkSync(join(temp, "missing"), marker);
    expect(resolveRepoScope(root, base)).toEqual(invalid(marker, "unsupported", root));
  });

  it("stops at nested jj instead of an ancestor Git repository", () => {
    const root = repository();
    const nested = directory(join(root, "nested"));
    directory(join(nested, ".jj"));
    expect(resolveRepoScope(nested, base)).toEqual(invalid(join(nested, ".jj"), "unsupported", nested));
  });

  it.each([
    "ref: heads/main\n",
    "ref: refs/heads/a b\n",
    "a".repeat(41),
    "ref: refs/heads/main\nextra",
    "\ufeffref: refs/heads/main\n",
    "ref: refs/a\0",
  ])("enforces the exact HEAD grammar: %s", (head) => {
    const root = repository("repo", head);
    expect(resolveRepoScope(root, base)).toEqual(invalid(join(root, ".git", "HEAD"), "malformed", root));
  });

  it("requires common objects and refs directories, and reports the affected path", () => {
    const root = repository();
    const objects = join(root, ".git", "objects");
    fs.rmdirSync(objects);
    fs.writeFileSync(objects, "not a directory");
    expect(resolveRepoScope(root, base)).toEqual(invalid(objects, "malformed", root));
    fs.unlinkSync(objects);
    directory(objects);
    const refs = join(root, ".git", "refs");
    fs.rmdirSync(refs);
    expect(resolveRepoScope(root, base)).toEqual({ ...invalid(refs, "unreadable", root), code: "ENOENT" });
  });

  it("rejects broken commondir markers without falling back to private storage", () => {
    const root = repository();
    const marker = join(root, ".git", "commondir");
    fs.symlinkSync(join(temp, "missing"), marker);
    expect(resolveRepoScope(root, base)).toEqual({ ...invalid(marker, "unreadable", root), code: "ENOENT" });
  });

  it("reports injected unreadable filesystem failures without leaking contents", () => {
    const root = repository();
    const head = join(root, ".git", "HEAD");
    const original = fs.openSync;
    vi.spyOn(fs, "openSync").mockImplementation((path, flags, mode) => {
      if (path === head) throw Object.assign(new Error("secret contents"), { code: "EACCES" });
      return original(path, flags, mode);
    });
    const result = resolveRepoScope(root, base);
    expect(result).toEqual({ ...invalid(head, "unreadable", root), code: "EACCES" });
    expect(JSON.stringify(result)).not.toContain("secret contents");
  });

  it("treats marker lookup errors as invalid rather than absence", () => {
    const root = repository();
    const marker = join(root, ".jj");
    const original = fs.lstatSync;
    vi.spyOn(fs, "lstatSync").mockImplementation(
      ((path: fs.PathLike) => {
        if (path === marker) throw Object.assign(new Error("denied"), { code: "EACCES" });
        return original(path);
      }) as typeof fs.lstatSync,
    );
    expect(resolveRepoScope(root, base)).toEqual({ ...invalid(marker, "unreadable", root), code: "EACCES" });
  });

  it("requires readable input and metadata directories", () => {
    const root = repository();
    const original = fs.readdirSync;
    const spy = vi.spyOn(fs, "readdirSync");
    for (const denied of [root, join(root, ".git"), join(root, ".git", "objects"), join(root, ".git", "refs")]) {
      spy.mockImplementation(
        ((path: fs.PathLike) => {
          if (path === denied) throw Object.assign(new Error("denied"), { code: "EACCES" });
          return original(path);
        }) as typeof fs.readdirSync,
      );
      expect(resolveRepoScope(root, base)).toEqual({
        ...invalid(denied, "unreadable", denied === root ? undefined : root),
        code: "EACCES",
      });
    }
  });
});

describe("bounded strict metadata reads", () => {
  it("accepts exactly 64KiB, rejects 64KiB+1, and preserves BOM", () => {
    const file = join(temp, "metadata");
    const text = "x".repeat(64 * 1024);
    fs.writeFileSync(file, text);
    expect(readMetadata(file)).toBe(text);
    fs.appendFileSync(file, "x");
    expect(() => readMetadata(file)).toThrowError(new MetadataError(file, "malformed"));
    fs.writeFileSync(file, "\ufefftext");
    expect(readMetadata(file)).toBe("\ufefftext");
  });

  it("applies the byte limit to resolver metadata too", () => {
    const root = repository("repo", `ref: refs/${"x".repeat(64 * 1024 - 10)}`);
    expect(resolveRepoScope(root, base)).toEqual(expected(join(root, ".git")));
    const head = join(root, ".git", "HEAD");
    fs.appendFileSync(head, "x");
    expect(resolveRepoScope(root, base)).toEqual(invalid(head, "malformed", root));
  });

  it.each([[0xff], [0xc0, 0xaf], [0xed, 0xa0, 0x80], [0xe2, 0x82]])("rejects strict UTF8 bytes %s", (...bytes) => {
    const root = repository();
    const head = join(root, ".git", "HEAD");
    fs.writeFileSync(head, Buffer.from(bytes));
    expect(resolveRepoScope(root, base)).toEqual(invalid(head, "malformed", root));
  });

  it("rejects non-regular targets before opening and accepts regular symlink targets", () => {
    const file = directory(join(temp, "metadata"));
    const open = vi.spyOn(fs, "openSync");
    expect(() => readMetadata(file)).toThrowError(new MetadataError(file, "malformed"));
    expect(open).not.toHaveBeenCalled();
    open.mockRestore();
    fs.rmdirSync(file);
    const target = join(temp, "target");
    fs.writeFileSync(target, "text");
    fs.symlinkSync(target, file);
    expect(readMetadata(file)).toBe("text");
  });

  it("checks the opened descriptor before reading and always closes it", () => {
    const file = join(temp, "metadata");
    fs.writeFileSync(file, "text");
    const original = fs.fstatSync;
    vi.spyOn(fs, "fstatSync").mockImplementation(
      ((fd: number) => {
        const stat = original(fd);
        stat.isFile = () => false;
        return stat;
      }) as typeof fs.fstatSync,
    );
    const read = vi.spyOn(fs, "readSync");
    const close = vi.spyOn(fs, "closeSync");
    const open = vi.spyOn(fs, "openSync");
    expect(() => readMetadata(file)).toThrowError(new MetadataError(file, "malformed"));
    expect(read).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledWith(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  });

  it("bounds reads even when the file grows after stat", () => {
    const file = join(temp, "metadata");
    fs.writeFileSync(file, "x".repeat(64 * 1024 + 1));
    const originalStat = fs.statSync;
    const originalFstat = fs.fstatSync;
    vi.spyOn(fs, "statSync").mockImplementation(
      ((path: fs.PathLike) => {
        const stat = originalStat(path);
        stat.size = 1;
        return stat;
      }) as typeof fs.statSync,
    );
    vi.spyOn(fs, "fstatSync").mockImplementation(
      ((fd: number) => {
        const stat = originalFstat(fd);
        stat.size = 1;
        return stat;
      }) as typeof fs.fstatSync,
    );
    const close = vi.spyOn(fs, "closeSync");
    expect(() => readMetadata(file)).toThrowError(new MetadataError(file, "malformed"));
    expect(close).toHaveBeenCalledOnce();
  });

  it.skipIf(process.platform === "win32")("rejects physical directory names containing non-UTF8 bytes", () => {
    const target = Buffer.concat([Buffer.from(`${temp}/`), Buffer.from([0xff])]);
    fs.mkdirSync(target);
    const alias = join(temp, "invalid-byte-alias");
    fs.symlinkSync(target, alias);
    expect(resolveRepoScope(alias, base)).toEqual(invalid(alias));
  });

  it("rejects undecodable canonical path bytes instead of hashing replacement characters", () => {
    const normal = fs.realpathSync;
    vi.spyOn(fs, "realpathSync").mockImplementation(
      ((path: fs.PathLike, options?: { encoding?: string } | string) => {
        if (typeof options === "object" && options?.encoding === "buffer") return Buffer.from([0xff]);
        return normal(path);
      }) as typeof fs.realpathSync,
    );
    expect(resolveRepoScope(temp, base)).toEqual(invalid(temp));
  });
});
