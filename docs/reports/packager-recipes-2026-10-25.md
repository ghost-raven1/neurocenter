# Packager recipe algorithm, 2026-10-25

## A: dependency pins and safe diagnostics

The saved psinetron job used repository commit `027c6d25a8f4781f4dd531ed3798ba67d3d17be7`, not an npm source. Its `>=1.16.0` dependency was rejected by the project validator. The existing lock pins `@opencode-ai/plugin` to `1.18.34`. Runtime compatibility and assets require separate work; accepting this range does not make the upstream Bun plugin runnable.

A source dependency may now use a wider valid semver range only with an existing v2/v3 lock. The manifest range must match the root lock and its exact dependency version; all runtime lock entries require exact versions, SHA-512 integrity and the official registry. No latest resolution is added. The existing exact/caret/tilde behavior remains available for v1 inputs. Semver is a direct production dependency already present in the installed lock, rather than an implicit dev dependency.

The trusted builder reports bounded stage, target, code and redacted reason. Child stderr is not forwarded. Structured evidence is persisted in the existing job config JSONB under the current execution nonce before staging cleanup; it is separate from the immutable source identity. Cancellation, old history and exact request keys retain their owners.

Observed RED: the real prepareAdditionalSource path rejected the pinned manifest range before npm; the controlled process test lost the diagnostic report. Observed GREEN: 4 Node tests (including a source fixture with a fake npm CLI asserting ci, ignore-scripts and exact lock), 55 Catalog focused tests and Catalog production noEmit. The source fixture uses our own tiny code and npm script, no network, upstream hooks, user job or model call. No real npm registry, upstream plugin launch, OpenCode/Bun host or cross-platform acceptance is claimed.

## B: executable source recipes

New explicit agent builds pin recipeVersion 2 once at admission when tool_build_agent_recipes is enabled (default true). Exact accepted replay is looked up first. Existing/unknown jobs retain v1 interpretation; disabling the flag preserves v1 admission, history and cancellation. No new migration or table is needed.

The agent receives a bounded inventory of pinned file hashes, manifest summary, exact dependency lock, reachable static JS/TS imports, allowed compilation strategies, resources and targets. It writes four checked internal operations: locked dependencies/none, Node24 bundle or preserve JS layout, explicit resource copies, and mandatory isolated startup verification. The full plan and hash are kept in the existing agent journal. Model output cannot add shell, install hooks, a new source, a new runtime, targets or credentials. The executor rechecks actual source bytes and entrypoint before dependencies or compilation.

The supported source profile is deliberately limited to GitHub/file JS/TS sources with a bounded static module graph. Ready JS may retain module paths and read adjacent packaged assets. TS without module-relative resources may be compiled for Node24. Unsupported Bun/Deno, TS module-relative assets, unresolved/dynamic imports, native/install-hook dependencies, unsupported manifest targets/runtime, generic npm-only and prepared-runtime profiles fail before a paid proposal. Npm-v2 and an enforceably isolated Bun host are separate work. The saved visualiser is therefore diagnosed early, not claimed runnable.

Runtime verification and publication remain separate mandatory gates. The verify operation does not turn a prepared archive into a verified/published candidate. Cross-platform runtime execution is not claimed by host-only checks.

Combined B/C candidate receipt: 61/61 Node source/builder/resource/supply tests (0 skips), 80/80 Catalog agent/API/protocol/attempt tests (0 skips), own Catalog emit and production noEmit GREEN. The source-pin race was reproduced on the previous original-directory inventory line: B was copied into staging, original A was restored at the controlled lstat boundary, and the old code accepted it. With inventory read from the copied staging, the same test rejects B before creating an output entrypoint. No sleeps or unchecked source execution were used.

The existing supply suite also exposed a baseline missing rag-core-contract cjs/declaration import in the retained publication validator. Both files were added to its explicit source closure; the suite then passed 20/20, including isolated validator compilation and actual controlled build/export/pack. This baseline fix is being carried independently by the parent core candidate.

The trusted inspector uses a native CommonJS async-import bridge so the real ESM inspector works under the compiled service and the test VM. Catalog Docker delivery already copies the complete shared/scripts directories, so the new loader and source helpers are included. The v2 source pin and ESM bridge remain subject to final independent review; no live service or user plugin acceptance is claimed.

Source inspection uses Node24 type transformation as data, not execution. The profile is fixed to Node24 because the upstream Node26 API removed transform mode: [Node24 module API](https://r2.nodejs.org/docs/latest-v24.x/api/module.html#modulestriptypescripttypescode-options).
