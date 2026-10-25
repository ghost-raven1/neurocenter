# Packager recipe algorithm, 2026-10-25

## A: dependency pins and safe diagnostics

The saved psinetron job used repository commit `027c6d25a8f4781f4dd531ed3798ba67d3d17be7`, not an npm source. Its `>=1.16.0` dependency was rejected by the project validator. The existing lock pins `@opencode-ai/plugin` to `1.18.34`. Runtime compatibility and assets require separate work; accepting this range does not make the upstream Bun plugin runnable.

A source dependency may now use a wider valid semver range only with an existing v2/v3 lock. The manifest range must match the root lock and its exact dependency version; all runtime lock entries require exact versions, SHA-512 integrity and the official registry. No latest resolution is added. The existing exact/caret/tilde behavior remains available for v1 inputs. Semver is a direct production dependency already present in the installed lock, rather than an implicit dev dependency.

The trusted builder reports bounded stage, target, code and redacted reason. Child stderr is not forwarded. Structured evidence is persisted in the existing job config JSONB under the current execution nonce before staging cleanup; it is separate from the immutable source identity. Cancellation, old history and exact request keys retain their owners.

Observed RED: the real prepareAdditionalSource path rejected the pinned manifest range before npm; the controlled process test lost the diagnostic report. Observed GREEN: 4 Node tests (including a source fixture with a fake npm CLI asserting ci, ignore-scripts and exact lock), 55 Catalog focused tests and Catalog production noEmit. The source fixture uses our own tiny code and npm script, no network, upstream hooks, user job or model call. No real npm registry, upstream plugin launch, OpenCode/Bun host or cross-platform acceptance is claimed.
