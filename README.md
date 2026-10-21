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

## Development and verification

Use Node 24 (`.node-version`) and npm 11.12.1 (`packageManager`). Install from the committed lockfile:

```sh
npm ci
npm run lint
npm run typecheck
npm test
npm run build
```

The committed `package-lock.json` makes dependency installation reproducible. Verification includes lint,
typecheck, build, resolver tests, and pinned Git/jj compatibility tests. Local compatibility fixtures skip
when the required CLI versions are unavailable; local checks do not establish a passing CI run for a new commit.

CI runs on pushes to `main` and pull requests. Its Ubuntu check uses `npm ci`, lint, typecheck,
test, and build. A separate required compatibility matrix covers Ubuntu Linux, Git 2.49.0, and both
jj 0.29.0 (older released layouts) and 0.46.0 (newer released layouts). It builds the pinned Git source
from kernel.org without gettext, Tcl/Tk, curl, expat, or OpenSSL, and downloads exact tagged jj release
archives from the official GitHub project.
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

The matrix sets the same required mode with its selected jj version. The updated matrix remains pending
verification until CI completes successfully. macOS remains supported through local/manual full-suite
and pinned compatibility checks when the required binaries are available; run these checks before releases
or path-canonicalization changes.

## Delivery prerequisites

The GitHub repository and remote are configured, and pull-request CI runs have started.
A `main` push also automatically runs the release workflow: release-please v5 opens or updates a release PR
for the root Node package, starting from manifest version 0.1.0, with minor bumps before 1.0 and no component
prefix in tags. Opening or updating that PR does not by itself create or publish a release. No manual workflow
activation is required. The release workflow has not been executed or verified yet.
After the manual initial 0.1.0 publish and trusted-publisher setup below, merging a release PR creates a release.
Only `release_created == 'true'` enables the publisher, which runs `npm ci`, build, and
`npm publish --provenance --access public` with npm's registry and OIDC permissions.
The package exports only the resolver ESM entry and its types; the file allowlist is `dist`, and prepack builds it.
npm includes `README.md` and `LICENSE` automatically. The package is MIT licensed; see [LICENSE](LICENSE).
The repository URL is https://github.com/Jomik/pi-repo-scope and is recorded in package metadata.

Before publishing:

1. Confirm the GitHub repository and remote still match the repository URL above.
2. Obtain a successful CI run, including the required pinned compatibility matrix.
3. Perform the user-confirmed **manual initial 0.1.0 publish** locally to bootstrap the npm package,
   after confirming package-name/publishing access. Keep the package and release-please manifest/tag versions
   aligned at 0.1.0 for this initial release:

   ```sh
   npm publish --access public
   ```

   Prepack builds the package; do not add `--provenance` to this local initial publish.
4. After the initial publish, manually configure the npm GitHub trusted publisher with owner `Jomik`,
   repository `pi-repo-scope`, and workflow `publish.yml`. This trust is not configured by the workflow
   and is not yet verified. Future releases use release-please and the OIDC publisher described above.
   Complete trusted-publisher setup before merging any automated release PR; a created release triggers
   the publisher, which otherwise fails authentication.

No consumer integration, migration, release, or npm publication has been performed.
