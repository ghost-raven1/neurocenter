# Bridge archive verification, 2026-10-25

This verification uses an isolated worktree and temporary profiles. It does not update the user's installed bridge, connect a device, start inference, or call a user MCP server.

## Reproducible defect and source correction

The first archive was built from `53615fbace1a7100335d974430e7e32c2692be42` using recorded Node `24.22.0` on `darwin-arm64`. Its SHA-256 is `2a1c087df35f9fb11af759771f36b8360ee733180a7d73c817bd053091678af8` and build ID is `e54aeae4bbe2915a9a30984c41856c8abbec5d883a8505ffcfe948de9356c86f`.

Installation from that exact archive passed without network tools, system Node/npm, pairing, or browser opening, into a path containing spaces and Cyrillic. Its compiled worker completed actual MCP `initialize`, `tools/list`, and `tools/call`; the controlled marker was read once. Cleanup then correctly refused an ownership comparison that no longer matched. This archive did not pass native acceptance.

Native comparison of the same owned process showed that macOS `ps` with `LC_ALL=C` renders Cyrillic argv bytes as `M-P…`. With `LC_ALL=C.UTF-8`, it preserves the original argv and still emits English `lstart`. The source correction in `54576d37cd9b350ab599df34173f9ca69492f683` pins both command-bearing `ps` queries to the verified UTF-8 locale. UID, birth time, process group, exact command, nonce, and receipt checks remain intact. There is no unverified locale fallback.

Two unit contracts failed before the correction and passed afterward. They check status and recovery queries independently, including an incompatible caller locale. The native regression uses a receipt path with Cyrillic and spaces and cleans up using its retained child IPC handle if an ownership regression occurs. After the initial failed fixture, a native process inventory confirmed no remaining owned processes; no PID-only termination was used.

## Build inputs and boundaries

The bridge version is `0.9.20`. The checked GitHub release inventories for `ghost-raven1/neurocenter` and `ghost-raven1/neurocenter-assets` did not contain a published `0.9.20`. This task publishes no release or binary.

Production dependencies are installed by the canonical packager, through the real npm CLI with `--offline` and an isolated cache. Cached tarballs are verified against the pinned lock integrity. The initial cache preparation fetched 17 missing lock-pinned payloads (9,589,156 bytes) from exact `registry.npmjs.org` URLs, with redirects and install hooks disabled. User npm configuration and cache are not modified. The bundled OpenCode native engine remains pinned to `1.14.48`.

Archive preflight checks SHA-256, version, target, paths, entry types, modes, and unpacked limits before running the installer. The only roots allowed are `bin`, `dist`, `node_modules`, `package.json`, `package-lock.json`, and `runtime.json`. Links and special entries are rejected.

## Corrected candidate

The real Unicode ownership regression passed in the serialized candidate bridge suite (936 ms); it is not repeated. The bridge suite reported 1,553 passed, zero failed, and 18 skipped, which remains distinct from archive acceptance.

The verification worktree at `201dad72291c362f4c57f976fcb66862380b08f1` matches candidate `b21447a1662860b7592ae7cd8f8d60f6d24a9e61` for all 261 production inputs: bridge source/vendor/build/native inputs, manifests, the copied shared contracts, runtime recipes/helpers, and installer templates. The aggregate SHA-256 is `8667bc5cd7486bcbd6d0bfb8f61a0b28a15e445bfd9ae92699de19275bd78f77` (sorted `path NUL mode NUL sha256 NUL`). Tests and documentation do not enter this comparison. The pinned SDK lock SHA-256 remains `c075bd972208d52ea2536408bd256a480c725584e6dcb9a23da082e155d6218a`; the original OpenCode tarball is 35,723,110 bytes with SHA-256 `49dc867dfecb016ec7e1b172fb23050b4a602728dbe5379651cb1c6e56b96938`.

The corrected archive passed the isolated native acceptance below. The canonical bridge build completed in 3,407 ms and the canonical offline runtime packager in 34,512 ms. The archive is 136,996,913 bytes, version `0.9.20`, target `darwin-arm64`, Node `24.22.0`:

- SHA-256: `fd5199ad937108502ddecb24deae2850c4d0b5db91e5a3c6ebbe0c1e66a938d4`.
- Build ID: `422b7e1f902fc6d481b903e0d78cc1f3290914599e45df29e9197d04690aece1`.
- Local archive: `.run/archive-verification/runtime-unicode-fixed/neurocenter-asset-sync-darwin-arm64-0.9.20.tgz`, with `.sha256` and `.json` sidecars.
- Preflight: exactly six roots, 12,792 entries, 430,166,784 unpacked bytes, safe relative paths, no links or special entries.
- The packager's native LanceDB table/count probe passed; no model inference ran. The bundled OpenCode binary remained `1.14.48`, SHA-256 `a29407b32f28ff552539d6f4a1bbe6fafc5023472c7ff8ca2494525b9b0d921b`.

Installation and the installed worker fixture completed in 14,492 ms in a fresh own directory containing Cyrillic and spaces. The implicit SHA sidecar was checked. The installer had no system Node, npm, or curl on PATH and received only owned HOME/XDG/configuration paths. It did not pair or open a browser.

The controlled runtime fixture is `scripts/test/bridge-system-role-mcp-runtime.fixture.mjs`. It exercised the installed compiled worker, actual managed-package inspection, actual HTTP client, and real SDK against an owned HTTP API and an owned file MCP. Actual JSON-RPC `initialize`, `tools/list`, and `tools/call` were traced. The assertions passed for:

- one controlled marker read, with one actual tool execution;
- a lost result acknowledgement recovered with identical HTTP JSON bytes and the same call ID, without replaying the tool;
- cancellation that waited for the owned descendant to close, followed by delivery of its saved unknown-result receipt;
- an unknown result after transport disconnection, with one tool execution;
- an unchanged marker and unchanged managed package after all scenarios.

The final native process inventory confirmed zero remaining processes belonging to this fixture. Free space was 5.0 GiB after completion. Only the original failed fixture's 443 MiB expanded scratch was removed after exact path/UID/process/SHA checks; its original archive, logs, trace, marker, result receipt, and closure receipt remain in `runtime/red-evidence`.

## Local evidence and repeat command

Paths below are relative to the verification worktree `/Users/aleksejstarodubcev/Downloads/neurocenter/.run/bridge-archive-verification`:

- `.run/archive-verification/production-source-receipt.json`: every production input, blob identity and SHA-256, the aggregate digest, source/candidate commits and pinned engine inputs.
- `.run/archive-verification/runtime-unicode-fixed/build-receipt.json` and `build.log`: actual canonical build exit codes, durations and source fingerprint.
- `.run/archive-verification/runtime-unicode-fixed/native-verification-receipt.json` and `native-install.log`: archive preflight, fresh installation path, runtime identity and passed worker assertions.
- `.run/archive-verification/runtime-unicode-fixed/process-completion-receipt.json`: zero remaining owned processes after successful cleanup.
- `.run/archive-verification/runtime/native-red-receipt.json`, `native-install.log` and `red-evidence/retirement-receipt.json`: original failed candidate and preserved failure evidence.

The existing local harness repeats archive SHA/preflight, a new isolated offline installation, and the actual compiled worker fixture. From that verification worktree:

```sh
/Users/aleksejstarodubcev/Downloads/neurocenter/.run/toolchains/node-v24.22.0-darwin-arm64/bin/node .run/verify-native-install.mjs runtime-unicode-fixed
```

The harness invokes the expanded Bash installer with `--archive` and the implicit SHA sidecar, using its own freshly created HOME/XDG/install directories. It does not update `~/.opencode`.

These checks do not establish a live authenticated website-to-role-to-user-device chain, production deployment, other operating systems, external MCP behavior, or real model inference. Subsequent bridge source changes require rebuilding and checking a fresh archive.
