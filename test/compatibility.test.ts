import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveRepoScope } from "../src/index.js";

const required = process.env.REPO_SCOPE_COMPATIBILITY_REQUIRED === "1";
const timeout = 30_000;
const maxBuffer = 1024 * 1024;

function directory(path: string): string {
  fs.mkdirSync(path, { recursive: true });
  return path;
}

function environment(root: string): NodeJS.ProcessEnv {
  // Deliberately do not inherit Git/JJ overrides, user config, or credential helpers.
  const env: NodeJS.ProcessEnv = {};
  const platformKeys = process.platform === "win32" ? ["SystemRoot", "WINDIR", "COMSPEC", "PATHEXT"] : [];
  for (const key of ["PATH", ...platformKeys]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  const config = join(root, "empty-jj-config.toml");
  fs.writeFileSync(config, "");
  return {
    ...env,
    LANG: "C",
    LC_ALL: "C",
    HOME: directory(join(root, "home")),
    XDG_CONFIG_HOME: directory(join(root, "xdg")),
    JJ_CONFIG: config,
    JJ_USER: "Compatibility Test",
    JJ_EMAIL: "compatibility@example.invalid",
    GIT_AUTHOR_NAME: "Compatibility Test",
    GIT_AUTHOR_EMAIL: "compatibility@example.invalid",
    GIT_COMMITTER_NAME: "Compatibility Test",
    GIT_COMMITTER_EMAIL: "compatibility@example.invalid",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
}

function executable(command: "git" | "jj", pins: string[], requested?: string) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "repo-scope-version-")));
  let version: string | undefined;
  let reason: string | undefined;
  try {
    const output = execFileSync(command, ["--version"], {
      cwd: root,
      env: environment(root),
      encoding: "utf8",
      timeout,
      maxBuffer,
    }).trim();
    const prefix = command === "git" ? "git version" : "jj";
    version = new RegExp(`^${prefix} (\\d+\\.\\d+\\.\\d+)(?:\\s|$)`).exec(output)?.[1];
    if (!version || !pins.includes(version) || (requested !== undefined && version !== requested)) {
      reason = `${command}: got ${JSON.stringify(output)}, expected ${requested ?? pins.join(" or ")}`;
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "error";
    reason = `${command}: executable unavailable or version probe failed (${code})`;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  if (reason && required) throw new Error(`Required repository compatibility target unavailable: ${reason}`);
  return { version, reason };
}

// These probes run during module initialization: required CI must fail, never silently skip.
const git = executable("git", ["2.49.0"], process.env.REPO_SCOPE_GIT_VERSION);
const jj = executable("jj", ["0.29.0", "0.46.0"], process.env.REPO_SCOPE_JJ_VERSION);
const modernJj = jj.version === "0.46.0";
const gitLabel = git.reason ? `SKIPPED: ${git.reason}` : `Git ${git.version}`;
const jjLabel = jj.reason ? `SKIPPED: ${jj.reason}` : `jj ${jj.version}`;

let temp: string;
let base: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  temp = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "repo-scope-compatibility-")));
  base = join(temp, "absent", "config");
  env = environment(temp);
});

afterEach(() => {
  fs.rmSync(temp, { recursive: true, force: true });
});

function run(command: "git" | "jj", args: string[], cwd = temp): string {
  return execFileSync(command, args, { cwd, env, encoding: "utf8", timeout, maxBuffer }).trim();
}

function expected(storage: string, kind: "git" | "jj" = "git") {
  // Independent hash oracle; never derive expectations from resolver internals.
  const identity = createHash("sha256")
    .update(Buffer.concat([Buffer.from(kind), Buffer.from([0]), Buffer.from(fs.realpathSync(storage), "utf8")]))
    .digest("hex");
  return { status: "found", identity, configDir: join(resolve(base), identity) };
}

function check(cwd: string, storage: string, kind: "git" | "jj" = "git") {
  const originalCwd = process.cwd();
  const suppliedCwd = cwd;
  const contents = fs.readdirSync(cwd).sort();
  const result = resolveRepoScope(cwd, base);
  expect(result).toEqual(expected(storage, kind));
  expect(process.cwd()).toBe(originalCwd);
  expect(cwd).toBe(suppliedCwd);
  expect(fs.readdirSync(cwd).sort()).toEqual(contents);
  expect(fs.existsSync(join(temp, "absent"))).toBe(false);
  return result;
}

function common(cwd: string): string {
  return run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd);
}

function gitRepository(name: string, committed = true): string {
  const root = join(temp, name);
  run("git", ["init", "--initial-branch=main", root]);
  if (committed) {
    fs.writeFileSync(join(root, "tracked"), "compatibility fixture\n");
    run("git", ["add", "tracked"], root);
    run("git", ["commit", "-m", "fixture"], root);
  }
  return root;
}

function secondary(primary: string, name: string, colocated = false): string {
  const root = join(temp, name);
  run("jj", ["workspace", "add", ...(modernJj ? [colocated ? "--colocate" : "--no-colocate"] : []), root], primary);
  return root;
}

describe.skipIf(Boolean(git.reason))(`released Git layouts (${gitLabel})`, () => {
  it.each([false, true])("resolves main with committed=%s using Git's common-directory oracle", (committed) => {
    const root = gitRepository("main", committed);
    expect(run("git", ["symbolic-ref", "HEAD"], root)).toBe("refs/heads/main");
    check(root, common(root));
    check(directory(join(root, "nested", "deep")), common(root));
  }, 120_000);

  it("shares linked worktree identity and keeps local submodule storage distinct", () => {
    const root = gitRepository("main");
    const worktree = join(temp, "linked");
    run("git", ["worktree", "add", "-b", "linked", worktree], root);
    expect(check(worktree, common(worktree))).toEqual(check(root, common(root)));
    const source = gitRepository("source");
    run("git", ["-c", "protocol.file.allow=always", "submodule", "add", source, "submodule"], root);
    const submodule = join(root, "submodule");
    expect(check(submodule, common(submodule))).not.toEqual(check(root, common(root)));
    expect(check(submodule, common(submodule))).not.toEqual(check(source, common(source)));
  }, 120_000);

  it("does not recognize bare storage directly", () => {
    const bare = join(temp, "bare.git");
    run("git", ["init", "--bare", "--initial-branch=main", bare]);
    expect(resolveRepoScope(bare, base)).toEqual({ status: "none", canonicalInputDirectory: fs.realpathSync(bare) });
  }, 120_000);
});

describe.skipIf(Boolean(git.reason || jj.reason))(`released jj Git layouts (${gitLabel}; ${jjLabel})`, () => {
  it.each([false, true])("resolves internal Git storage with colocated=%s and shares identity", (colocated) => {
    const root = join(temp, "primary");
    run("jj", ["git", "init", ...(colocated ? ["--colocate"] : modernJj ? ["--no-colocate"] : []), root]);
    const storage = colocated
      ? common(root)
      : run("git", [
          "--git-dir",
          join(root, ".jj", "repo", "store", "git"),
          "rev-parse",
          "--path-format=absolute",
          "--git-common-dir",
        ]);
    const primary = check(root, storage);
    expect(check(secondary(root, "secondary"), storage)).toEqual(primary);
    if (colocated && modernJj) {
      const work = secondary(root, "colocated-secondary", true);
      expect(fs.existsSync(join(work, ".git"))).toBe(true);
      expect(check(work, common(work))).toEqual(primary);
    }
  }, 120_000);

  it.each([false, true])("resolves external absolute Git storage with bare=%s", (bare) => {
    const gitRoot = bare ? join(temp, "bare.git") : gitRepository("ordinary");
    if (bare) run("git", ["init", "--bare", "--initial-branch=main", gitRoot]);
    const storage = common(gitRoot);
    const root = join(temp, "jj-external");
    run("jj", ["git", "init", "--git-repo", fs.realpathSync(storage), root]);
    const primary = check(root, storage);
    expect(check(secondary(root, "secondary"), storage)).toEqual(primary);
    if (bare) {
      expect(resolveRepoScope(gitRoot, base)).toEqual({
        status: "none",
        canonicalInputDirectory: fs.realpathSync(gitRoot),
      });
    } else {
      const linked = join(temp, "linked");
      run("git", ["worktree", "add", "-b", "linked", linked], gitRoot);
      expect(check(gitRoot, storage)).toEqual(primary);
      expect(check(linked, common(linked))).toEqual(primary);
    }
  }, 120_000);
});

describe.skipIf(Boolean(jj.reason))(`released native jj layouts (${jjLabel})`, () => {
  it("hashes the whole Simple repository, not its store, and shares secondary identity", () => {
    const root = join(temp, "native");
    run("jj", ["debug", "init-simple", root]);
    const repo = join(root, ".jj", "repo");
    expect(fs.readFileSync(join(repo, "store", "type"), "utf8")).toBe("Simple");
    const primary = check(root, repo, "jj");
    expect(primary).not.toEqual(expected(join(repo, "store"), "jj"));
    expect(check(secondary(root, "native-secondary"), repo, "jj")).toEqual(primary);
  }, 120_000);
});

it.skipIf(process.platform === "win32" || !fs.existsSync("/dev/null"))(
  "rejects a real device metadata target without reading it",
  () => {
    const root = directory(join(temp, "device-repo"));
    const storage = directory(join(root, ".git"));
    directory(join(storage, "objects"));
    directory(join(storage, "refs"));
    const head = join(storage, "HEAD");
    fs.symlinkSync("/dev/null", head);
    expect(resolveRepoScope(root, base)).toEqual({
      status: "invalid",
      stage: "metadata",
      reason: "malformed",
      path: head,
      canonicalInputDirectory: root,
    });
  },
);
