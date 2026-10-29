# Contract reference

The single maintained format reference is [Asset contract v1](../skills/neurocenter-packaging/references/contract.md).

The shared runtime implementation is exported from `@neurocenter/asset-contract`. Types are in [`index.d.ts`](../index.d.ts).

## Verified local content

A local ZIP or canonical source snapshot uses `source: {type: "archive", sha256, bytes}`. Its hash covers the exact snapshot bytes; the envelope contains no server paths, credentials, device IDs, or invented repository URL.

Tool delivery artifacts may omit `url`. Such an artifact remains identified by its native descriptor SHA-256 and byte inventory. An importer may accept it only when those exact bytes already exist in its verified blob store. `downloadArtifacts` retains content-only entries; `fetchArtifact` rejects them before making a request or creating a file. A missing blob never falls back to an unpinned source.

Publishing a local build adds real immutable Release transports and exports a new source version. It preserves native package bytes/pins. Previously published source version bytes remain immutable. Consumers still validate the native package and authorize installation through their API Gateway.

## Native OpenCode agents

`kind: "agent"` is an inline native definition, separate from MCP/plugin packages. Its card contains stable `id`, reserved `nc-` slug, display name and `definition` (`description`, Markdown `prompt`, `mode`, explicit permissions and optional `provider/model`, temperature, topP, steps). The supported permission keys follow pinned OpenCode 1.14.48, including `bash`, not newer `shell`. Prompt bytes are bounded to 64 KiB; unknown fields, paths, credentials as model IDs and nested permission rules are rejected.

Source imports create immutable template versions. Projects pin exact versions and maintain their own overrides. Devices receive the compiled project snapshot only through the deployment's API Gateway and bridge; the source descriptor never contains device IDs, project paths, provider credentials or a fabricated installed status. Configuration success means the native agent files were written, not a successful model inference or reload of an existing OpenCode session.
