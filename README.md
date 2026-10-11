# pi-repo-scope

A standalone, synchronous, read-only resolver for physical Git and jj repository scopes.
It returns a shared-configuration key and derived path, not a storage API. No runtime dependencies; ESM on Node 24+.

## API

```ts
import { resolveRepoScope } from "pi-repo-scope";

// Both paths are explicit, absolute, host-supplied inputs.
const scope = resolveRepoScope("/work/project/src", "/var/lib/my-app/repo-config");
switch (scope.status) {
  case "found":
    console.log(scope.identity, scope.configDir);
    // The host decides whether and how to use this path. Nothing was created.
    break;
  case "none":
    console.log("No repository marker", scope.canonicalInputDirectory);
    break;
  case "invalid":
    console.error(scope.stage, scope.reason, scope.path, scope.code);
    break;
}
```

`resolveRepoScope(cwd, sharedConfigBase)` does not use the process working directory as a default,
change it, guess a home directory, create directories, or inspect shared configuration storage.
Both inputs must be absolute, well-formed strings without NUL. `cwd` must resolve to an existing,
readable directory. **The shared base need not exist**: it is lexically resolved, not realpathed or
checked for existence, and `configDir` is the base joined with the identity. The host owns base selection.

Results are a discriminated union:

- `found`: `identity` (lowercase SHA-256 hex) and `configDir`.
- `none`: `canonicalInputDirectory`, after reaching the filesystem root without a marker.
- `invalid`: `stage` (`input` or `metadata`), `reason` (`malformed`, `unreadable`, or `unsupported`),
  `path`, optional filesystem `code`, and `canonicalInputDirectory` when input canonicalization succeeded.

## Identity and layouts

Discovery walks physical ancestry after Node realpath canonicalization of `cwd`, preferring `.jj`
over `.git` in the same directory. A malformed or unsupported nearest marker produces `invalid`;
it does not fall back to an outer repository. Bare Git storage is not recognized directly without a marker.

The identity hashes the UTF-8 bytes of `kind + "\0" + canonicalStoragePath` with SHA-256.
The path is Node's realpath spelling, not a remote URL, content hash, repository name, or logical checkout path:

- Git uses its common storage directory, including `.git` directories, `gitdir: ` files, and `commondir` pointers.
  Linked worktrees share that identity. Separate clones and submodule storage have different identities.
- Git-backed jj uses the same Git common storage identity. Colocated Git/jj, external Git storage,
  and jj workspaces sharing that storage therefore share a key.
- Native jj uses the whole canonical `.jj/repo` directory with kind `jj`, not just its `store`.
  Both lowercase `simple` and the released `Simple` backend alias are accepted. Released CLI fixtures
  assert the actual bytes are exactly `Simple`, with no newline; backend type files are not trimmed.

Supported layouts are checked structurally: Git requires `HEAD` containing `ref: refs/...` or a 40/64-digit
hex object ID, plus readable `objects` and `refs` directories in common storage. jj requires readable
`store`, `op_store`, `op_heads`, and `index` directories, each with a raw, nonempty `type` token containing
no whitespace or NUL. Only commit-store backends `git`, `simple`, and the actual released `Simple` are supported.
No newer workspace metadata is required, and the resolver does not upgrade repositories.

Moving canonical storage changes its key. Moving a checkout while preserving the same storage path does not.
Symlink aliases resolving to the same storage share a key. This is filesystem identity, not portable identity.

Git line pointers accept a single optional terminal LF or CRLF and reject embedded line breaks/NUL.
jj `repo` and `git_target` file pointers are raw paths: whitespace, including trailing newlines, is preserved,
not trimmed. Relative pointers are resolved against their layout-defined directory.

## Security and support boundary

Resolution is a metadata snapshot, **not authorization**. Repository pointers are forgeable and can redirect
reads to other accessible storage; hashing does not establish trust, ownership, or permission to load config.
Filesystem changes can race resolution. Consumers own validation, grant policies, and safe use of returned paths.

Metadata reads allow symlinks to regular files, but reject FIFOs, devices, and other non-regular files as
`malformed`. Reads enforce a maximum of 64 KiB and strict UTF-8 decoding; a BOM is preserved, not stripped.
Oversized or undecodable metadata is also `malformed`. Canonical paths must round-trip as UTF-8.
The supported platform scope is macOS/Linux with UTF-8 paths; Windows and arbitrary non-UTF-8 filesystem
names are not claimed. No Git or jj subprocess is used by the resolver itself.
All filesystem work is synchronous: slow disks, network mounts, or hostile filesystem I/O can block the caller;
there is no timeout or asynchronous isolation.

Consumer adoption is intentionally not included. Stricter rejection of unknown commit-store types and special,
oversized, or undecodable metadata may reject previously accepted Armory layouts or change adapter fallback
keys at adoption. The resolver itself provides no fallback or migration of existing config or grants.
Repository keys and storage paths can change; consumers own any mapping, migration, and authorization policy.

## Development and planned verification

Use Node 24 (`.node-version`) and npm 11.12.1 (`packageManager`). Install from the committed lockfile:

```sh
npm ci
npm run lint
npm run typecheck
npm test
npm run build
```

The committed `package-lock.json` makes dependency installation reproducible. Workflow execution remains
unverified; the full local test suite is pending final validation.

The prepared CI runs on pushes to `main` and pull requests. Its Ubuntu check uses `npm ci`, lint, typecheck,
test, and build. A separate **planned, not locally passed** compatibility matrix covers Ubuntu Linux and
macOS 15, Git 2.49.0, and jj 0.29.0/0.46.0. It builds the pinned Git source from kernel.org without gettext,
Tcl/Tk, curl, expat, or OpenSSL, and downloads exact tagged jj release archives from the official GitHub project.
Fixtures use local transport only; Git HTTP transport is unnecessary. Downloads use fixed HTTPS URLs;
no verified checksums are supplied, so this is version pinning, not cryptographic artifact verification.

For local released-layout checks with those CLIs on `PATH`:

```sh
npm test -- test/compatibility.test.ts
```

Missing or mismatched CLIs skip their corresponding local fixture groups, not demonstrate compatibility.
Required mode throws during the exact CLI version probes rather than silently skipping:

```sh
REPO_SCOPE_COMPATIBILITY_REQUIRED=1 \
REPO_SCOPE_GIT_VERSION=2.49.0 \
REPO_SCOPE_JJ_VERSION=0.46.0 \
npm test -- test/compatibility.test.ts
```

The matrix sets the same required mode with its selected jj version. These matrix targets remain unverified
until the prepared workflow actually runs successfully.

## Delivery prerequisites

The prepared CI and release workflows run automatically when pushed to `main` on the configured GitHub
repository; no manual activation is required. Neither workflow has been executed or verified yet.
A `main` push runs release-please v5 for the root Node package, starting from manifest version 0.1.0,
with minor bumps before 1.0 and no component prefix in tags. Only `release_created == 'true'` enables the
publisher, which runs `npm ci`, build, and `npm publish --provenance --access public` with npm's registry and OIDC permissions.
The package exports only the resolver ESM entry and its types; the file allowlist is `dist`, and prepack builds it.

Before publishing:

1. Obtain a successful CI run, including the required compatibility matrix.
2. Configure the actual GitHub remote/repository and set the real repository URL in package repository metadata.
   No remote is currently configured; no GitHub URL or author is invented.
3. Choose the license and set accurate package license metadata and the appropriate license text.
   No license has been chosen or `LICENSE` added. Repository and license metadata **must be set before publishing**.
4. Manually configure an npm trusted publisher for the actual GitHub owner, repository, and `release.yml`
   workflow, and ensure package-name/publishing access. The workflow does not provision this trust.

No consumer integration, migration, push, release, or npm publication has been performed.
