import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveRepoScope } from "../src/index.js";
import { MetadataError, readMetadata } from "../src/metadata.js";

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof fs>()),
}));

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

function jjRepository(root: string, backend = "git", repo = join(root, ".jj", "repo")): string {
  directory(join(root, ".jj"));
  for (const component of ["store", "op_store", "op_heads", "index"]) {
    directory(join(repo, component));
    fs.writeFileSync(join(repo, component, "type"), component === "store" ? backend : "other-token");
  }
  if (repo !== join(root, ".jj", "repo")) {
    fs.writeFileSync(join(root, ".jj", "repo"), relative(join(root, ".jj"), repo));
  }
  return repo;
}

function expected(storage: string, kind = "git") {
  // Independent byte construction of the storage-kind + NUL + canonical-path hash vector.
  const identity = createHash("sha256")
    .update(Buffer.concat([Buffer.from(kind), Buffer.from([0]), Buffer.from(fs.realpathSync(storage), "utf8")]))
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
    expect(resolveRepoScope(file, base)).toEqual({ ...invalid(file, "malformed", file), stage: "input" });
  });

  it("retains the canonical target for a symlink-to-file cwd input failure", () => {
    const target = join(temp, "target-file");
    fs.writeFileSync(target, "contents");
    const alias = join(temp, "file-alias");
    fs.symlinkSync(target, alias, "file");
    expect(resolveRepoScope(alias, base)).toEqual({ ...invalid(target, "malformed", target), stage: "input" });
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
    const result =
      kind === "file"
        ? invalid(marker, "malformed", root)
        : { ...invalid(kind === "directory" ? join(marker, "repo") : marker, "unreadable", root), code: "ENOENT" };
    expect(resolveRepoScope(root, base)).toEqual(result);
  });

  it("stops at nested jj instead of an ancestor Git repository", () => {
    const root = repository();
    const nested = directory(join(root, "nested"));
    directory(join(nested, ".jj"));
    expect(resolveRepoScope(nested, base)).toEqual({
      ...invalid(join(nested, ".jj", "repo"), "unreadable", nested),
      code: "ENOENT",
    });
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
    vi.spyOn(fs, "lstatSync").mockImplementation(((path: fs.PathLike) => {
      if (path === marker) throw Object.assign(new Error("denied"), { code: "EACCES" });
      return original(path);
    }) as typeof fs.lstatSync);
    expect(resolveRepoScope(root, base)).toEqual({ ...invalid(marker, "unreadable", root), code: "EACCES" });
  });

  it("requires readable input and metadata directories", () => {
    const root = repository();
    const original = fs.readdirSync;
    const spy = vi.spyOn(fs, "readdirSync");
    for (const denied of [root, join(root, ".git"), join(root, ".git", "objects"), join(root, ".git", "refs")]) {
      spy.mockImplementation(((path: fs.PathLike) => {
        if (path === denied) throw Object.assign(new Error("denied"), { code: "EACCES" });
        return original(path);
      }) as typeof fs.readdirSync);
      expect(resolveRepoScope(root, base)).toEqual({
        ...invalid(denied, "unreadable", root),
        stage: denied === root ? "input" : "metadata",
        code: "EACCES",
      });
    }
  });
});

describe("shared jj storage", () => {
  it.each(["internal", "external", "colocated"])("resolves %s Git storage with the Git hash", (layout) => {
    const root = layout === "colocated" ? repository() : directory(join(temp, "work"));
    const repo = jjRepository(root);
    const storage =
      layout === "colocated"
        ? join(root, ".git")
        : gitStorage(layout === "internal" ? join(repo, "store", "git") : join(temp, "external-git"));
    fs.writeFileSync(join(repo, "store", "git_target"), relative(join(repo, "store"), storage));
    const nested = directory(join(root, "nested"));
    expect(resolveRepoScope(nested, base)).toEqual(expected(storage));
    expect(fs.existsSync(dirname(base))).toBe(false);
  });

  it.each(["relative", "absolute"])("preserves raw %s repo and git_target whitespace/newlines", (kind) => {
    const root = directory(join(temp, "primary"));
    const repo = jjRepository(root, "git", join(temp, " shared\nrepo\n"));
    const storage = gitStorage(join(temp, " git\ntarget\n "));
    fs.writeFileSync(
      join(repo, "store", "git_target"),
      kind === "relative" ? relative(join(repo, "store"), storage) : storage,
    );
    fs.writeFileSync(join(root, ".jj", "repo"), kind === "relative" ? relative(join(root, ".jj"), repo) : repo);
    const secondary = directory(join(temp, "secondary"));
    directory(join(secondary, ".jj"));
    fs.writeFileSync(
      join(secondary, ".jj", "repo"),
      kind === "relative" ? relative(join(secondary, ".jj"), repo) : repo,
    );
    expect(resolveRepoScope(root, base)).toEqual(expected(storage));
    expect(resolveRepoScope(secondary, base)).toEqual(expected(storage));
  });

  it.each(["directory", "gitfile"])("reuses private Git commondir through a %s target", (kind) => {
    const root = repository();
    const common = join(root, ".git");
    const privateDir = directory(join(common, "worktrees", "jj"));
    fs.writeFileSync(join(privateDir, "HEAD"), "ref: refs/heads/jj\n");
    fs.writeFileSync(join(privateDir, "commondir"), "../..\n");
    const work = directory(join(temp, "jj-work"));
    const repo = jjRepository(work);
    let target = privateDir;
    if (kind === "gitfile") {
      target = join(repo, "store", "gitfile");
      fs.writeFileSync(target, `gitdir: ${relative(dirname(target), privateDir)}\n`);
    }
    fs.writeFileSync(join(repo, "store", "git_target"), target);
    expect(resolveRepoScope(work, base)).toEqual(expected(common));
    expect(resolveRepoScope(work, base)).toEqual(resolveRepoScope(root, base));
  });

  it.each(["simple", "Simple"])("hashes the whole canonical repo for %s, not its store", (backend) => {
    const root = directory(join(temp, "primary"));
    const repo = jjRepository(root, backend);
    expect(resolveRepoScope(root, base)).toEqual(expected(repo, "jj"));
    expect(resolveRepoScope(root, base)).not.toEqual(expected(join(repo, "store"), "jj"));
    expect(resolveRepoScope(root, base)).not.toEqual(expected(repo, backend));
    const work = directory(join(temp, "secondary"));
    directory(join(work, ".jj"));
    const alias = join(temp, "repo-alias");
    fs.symlinkSync(repo, alias, "dir");
    fs.writeFileSync(join(work, ".jj", "repo"), alias);
    expect(resolveRepoScope(work, base)).toEqual(expected(repo, "jj"));
    const clone = directory(join(temp, "clone"));
    const cloneRepo = jjRepository(clone, backend);
    // Even sharing the store is insufficient: the whole repository owns identity.
    fs.rmSync(join(cloneRepo, "store"), { recursive: true });
    fs.symlinkSync(join(repo, "store"), join(cloneRepo, "store"), "dir");
    expect(resolveRepoScope(clone, base)).toEqual(expected(cloneRepo, "jj"));
    expect(resolveRepoScope(clone, base)).not.toEqual(resolveRepoScope(root, base));
  });

  it("groups Git target aliases but keeps independent clones separate", () => {
    const root = directory(join(temp, "work"));
    const repo = jjRepository(root);
    const storage = gitStorage(join(temp, "git-storage"));
    const alias = join(temp, "git-alias");
    fs.symlinkSync(storage, alias, "dir");
    const target = join(repo, "store", "git_target");
    fs.writeFileSync(target, alias);
    expect(resolveRepoScope(root, base)).toEqual(expected(storage));
    const clone = gitStorage(join(temp, "clone-storage"));
    fs.writeFileSync(target, clone);
    expect(resolveRepoScope(root, base)).toEqual(expected(clone));
    expect(resolveRepoScope(root, base)).not.toEqual(expected(storage));
  });

  it.each(["store", "op_store", "op_heads", "index"])("requires a readable %s directory and type", (component) => {
    const root = repository();
    const repo = jjRepository(root, "simple");
    const dir = join(repo, component);
    const type = join(dir, "type");
    fs.unlinkSync(type);
    expect(resolveRepoScope(root, base)).toEqual({ ...invalid(type, "unreadable", root), code: "ENOENT" });
    directory(type);
    expect(resolveRepoScope(root, base)).toEqual(invalid(type, "malformed", root));
    fs.rmdirSync(type);
    fs.rmdirSync(dir);
    expect(resolveRepoScope(root, base)).toEqual({ ...invalid(dir, "unreadable", root), code: "ENOENT" });
    fs.writeFileSync(dir, "file");
    expect(resolveRepoScope(root, base)).toEqual(invalid(dir, "malformed", root));
  });

  it.each(["", "git\n", "git ", "git\0", "git\t", "x".repeat(64 * 1024 + 1), Buffer.from([0xff])])(
    "rejects malformed type metadata: case %#",
    (value) => {
      const root = repository();
      const repo = jjRepository(root, "simple");
      for (const component of ["store", "op_store", "op_heads", "index"]) {
        const type = join(repo, component, "type");
        fs.writeFileSync(type, value);
        expect(resolveRepoScope(root, base)).toEqual(invalid(type, "malformed", root));
        fs.writeFileSync(type, component === "store" ? "simple" : "other-token");
      }
    },
  );

  it.each(["custom", "SIMPLE", "Git"])("stops at unsupported commit backend %s without fallback", (backend) => {
    const parent = repository();
    const root = directory(join(parent, "nested"));
    gitStorage(join(root, ".git"));
    const repo = jjRepository(root, backend);
    expect(resolveRepoScope(root, base)).toEqual(invalid(join(repo, "store", "type"), "unsupported", root));
  });

  it.each(["repo", "git_target"])("rejects malformed raw %s pointers without fallback", (pointer) => {
    const root = repository();
    const repo = jjRepository(root, "git", join(temp, "shared"));
    const path = pointer === "repo" ? join(root, ".jj", "repo") : join(repo, "store", "git_target");
    for (const value of ["", "target\0", "x".repeat(64 * 1024 + 1), Buffer.from([0xff])]) {
      fs.writeFileSync(path, value);
      expect(resolveRepoScope(root, base)).toEqual(invalid(path, "malformed", root));
    }
    fs.writeFileSync(path, "missing");
    const missing = resolve(pointer === "repo" ? join(root, ".jj") : join(repo, "store"), "missing");
    expect(resolveRepoScope(root, base)).toEqual({ ...invalid(missing, "unreadable", root), code: "ENOENT" });
    fs.unlinkSync(path);
    expect(resolveRepoScope(root, base)).toEqual({ ...invalid(path, "unreadable", root), code: "ENOENT" });
    fs.symlinkSync(join(temp, "broken-target"), path);
    expect(resolveRepoScope(root, base)).toEqual({ ...invalid(path, "unreadable", root), code: "ENOENT" });
    fs.unlinkSync(path);
    directory(path);
    expect(resolveRepoScope(root, base)).toEqual(
      pointer === "git_target"
        ? invalid(path, "malformed", root)
        : { ...invalid(join(path, "store"), "unreadable", root), code: "ENOENT" },
    );
  });

  it("requires the shared repo to be a readable directory", () => {
    const root = repository();
    directory(join(root, ".jj"));
    const target = join(temp, "repo-file");
    fs.writeFileSync(target, "contents");
    fs.writeFileSync(join(root, ".jj", "repo"), target);
    expect(resolveRepoScope(root, base)).toEqual(invalid(target, "malformed", root));
  });

  it("reports injected unreadable jj directories and files at their exact paths", () => {
    const root = repository();
    const repo = jjRepository(root, "git", join(temp, "shared"));
    const storage = gitStorage(join(repo, "store", "git"));
    fs.writeFileSync(join(repo, "store", "git_target"), storage);
    const readdir = fs.readdirSync;
    const open = fs.openSync;
    const dirSpy = vi.spyOn(fs, "readdirSync");
    for (const denied of [
      join(root, ".jj"),
      repo,
      ...["store", "op_store", "op_heads", "index"].map((name) => join(repo, name)),
    ]) {
      dirSpy.mockImplementation(((path: fs.PathLike) => {
        if (path === denied) throw Object.assign(new Error("denied"), { code: "EACCES" });
        return readdir(path);
      }) as typeof fs.readdirSync);
      expect(resolveRepoScope(root, base)).toEqual({ ...invalid(denied, "unreadable", root), code: "EACCES" });
    }
    dirSpy.mockRestore();
    const openSpy = vi.spyOn(fs, "openSync");
    for (const denied of [
      join(root, ".jj", "repo"),
      join(repo, "store", "git_target"),
      ...["store", "op_store", "op_heads", "index"].map((name) => join(repo, name, "type")),
    ]) {
      openSpy.mockImplementation((path, flags, mode) => {
        if (path === denied) throw Object.assign(new Error("denied"), { code: "EACCES" });
        return open(path, flags, mode);
      });
      expect(resolveRepoScope(root, base)).toEqual({ ...invalid(denied, "unreadable", root), code: "EACCES" });
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

  it.skipIf(process.platform === "win32")("rejects device symlink targets without opening them", () => {
    const file = join(temp, "device");
    fs.symlinkSync("/dev/null", file);
    const open = vi.spyOn(fs, "openSync");
    expect(() => readMetadata(file)).toThrowError(new MetadataError(file, "malformed"));
    expect(open).not.toHaveBeenCalled();
  });

  it("checks the opened descriptor before reading and always closes it", () => {
    const file = join(temp, "metadata");
    fs.writeFileSync(file, "text");
    const original = fs.fstatSync;
    vi.spyOn(fs, "fstatSync").mockImplementation(((fd: number) => {
      const stat = original(fd);
      stat.isFile = () => false;
      return stat;
    }) as typeof fs.fstatSync);
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
    vi.spyOn(fs, "statSync").mockImplementation(((path: fs.PathLike) => {
      const stat = originalStat(path);
      stat.size = 1;
      return stat;
    }) as typeof fs.statSync);
    vi.spyOn(fs, "fstatSync").mockImplementation(((fd: number) => {
      const stat = originalFstat(fd);
      stat.size = 1;
      return stat;
    }) as typeof fs.fstatSync);
    const close = vi.spyOn(fs, "closeSync");
    expect(() => readMetadata(file)).toThrowError(new MetadataError(file, "malformed"));
    expect(close).toHaveBeenCalledOnce();
  });

  it.skipIf(process.platform === "win32")("rejects physical directory names containing non-UTF8 bytes", () => {
    const target = Buffer.concat([Buffer.from(`${temp}/`), Buffer.from([0xff])]);
    try {
      fs.mkdirSync(target);
    } catch (error) {
      if (process.platform === "darwin" && (error as NodeJS.ErrnoException).code === "EILSEQ") return;
      throw error;
    }
    const alias = join(temp, "invalid-byte-alias");
    fs.symlinkSync(target, alias);
    expect(resolveRepoScope(alias, base)).toEqual(invalid(alias));
  });

  it("rejects undecodable canonical path bytes instead of hashing replacement characters", () => {
    const normal = fs.realpathSync;
    vi.spyOn(fs, "realpathSync").mockImplementation(((path: fs.PathLike, options?: { encoding?: string } | string) => {
      if (typeof options === "object" && options?.encoding === "buffer") return Buffer.from([0xff]);
      return normal(path);
    }) as typeof fs.realpathSync);
    expect(resolveRepoScope(temp, base)).toEqual(invalid(temp));
  });
});
