# Contract reference

The single maintained format reference is [Asset contract v1](../skills/neurocenter-packaging/references/contract.md).

The shared runtime implementation is exported from `@neurocenter/asset-contract`. Types are in [`index.d.ts`](../index.d.ts).

## Contract 1.3.0

Explicit required system set for the device (epic-catalog-external, story 12.1). Four additive top-level fields on the asset descriptor and, mirroring it, on the index entry:

- **`system: true` / `required: true`** — mark the asset as a mandatory device asset: it must be installed on the device and is assigned to every new project by default.
- **`subsystem`** — one of `SYSTEM_SUBSYSTEMS`: `core`, `rag`, `system-roles`, `agent-team`.
- **`note`** — non-empty text (≤2000 chars, no control characters) explaining why the asset is required.
- **All-or-nothing** — either all four fields are present or none are. A partial set is rejected; flags must be the boolean `true`.
- **Index mirror** — `IndexEntry` carries the same four fields; `loadRepository` rejects an index whose marker diverges from the descriptor bytes. `assertIndexEvolution` is unchanged: previously published version bytes cannot change, so the marker only appears on new versions.

Already published descriptors without the fields remain valid at read; model assets deliberately never carry the marker (they stay optional hosting).

## Contract 1.2.2

Four additive extensions for the runtime-trust architecture (AD-2, AD-12, AD-13, AD-16); already published bytes without the new fields remain valid at read, while `validateAsset(value, {mode: 'produce'})` makes them mandatory:

- **`limits` (AD-2)** — `RuntimeArtifact.limits: {compressedBytes, unpackedBytes, filesCount, cacheBytes}`. The verified descriptor is the client's only source of server limits; every value must be within `[1..ARTIFACT_CEILING]` (fail-closed). Declared artifact sizes are validated against the ceiling, never against environment values.
- **`contractVersion` (AD-13)** — strict semver on `AssetBase`; new publications must carry exactly `CONTRACT_VERSION` (`1.2.2`) of the producing contract build.
- **`status` (AD-16)** — `IndexEntry.status: 'active' | 'retired'`; missing at read means `active`. `assertIndexEvolution` rejects `retired → active`: retirement is irreversible and retired versions are never removed from the index.
- **`[min,max]` capability ranges (AD-13)** — `compatibility.packageFormat` / `compatibility.bridgeProtocol` are validated against `PACKAGE_FORMAT_RANGE` (`{min: 5, max: 5}`) and `BRIDGE_PROTOCOL_RANGE` (`{min: 2, max: 2}`) instead of floor equality.
- **Ceiling constants (AD-12)** — `ARTIFACT_CEILING` (`1 GiB / 4 GiB / 100000 / 8 GiB cache`, AD-1 interim) is the single source of ceilings in the pinned contract, exported from `lib/ceiling.mjs`. The `NEUROCENTER_RUNTIME_MAX_*` environment path is removed: any ceiling change is a new contract release plus re-pin plus bump test.

## Verified local content

A local ZIP or canonical source snapshot uses `source: {type: "archive", sha256, bytes}`. Its hash covers the exact snapshot bytes; the envelope contains no server paths, credentials, device IDs, or invented repository URL.

Tool delivery artifacts may omit `url`. Such an artifact remains identified by its native descriptor SHA-256 and byte inventory. An importer may accept it only when those exact bytes already exist in its verified blob store. `downloadArtifacts` retains content-only entries; `fetchArtifact` rejects them before making a request or creating a file. A missing blob never falls back to an unpinned source.

Publishing a local build adds real immutable Release transports and exports a new source version. It preserves native package bytes/pins. Previously published source version bytes remain immutable. Consumers still validate the native package and authorize installation through their API Gateway.

## Native OpenCode agents

`kind: "agent"` is an inline native definition, separate from MCP/plugin packages. Its card contains stable `id`, reserved `nc-` slug, display name and `definition` (`description`, Markdown `prompt`, `mode`, explicit permissions and optional `provider/model`, temperature, topP, steps). The supported permission keys follow pinned OpenCode 1.14.48, including `bash`, not newer `shell`. Prompt bytes are bounded to 64 KiB; unknown fields, paths, credentials as model IDs and nested permission rules are rejected.

Source imports create immutable template versions. Projects pin exact versions and maintain their own overrides. Devices receive the compiled project snapshot only through the deployment's API Gateway and bridge; the source descriptor never contains device IDs, project paths, provider credentials or a fabricated installed status. Configuration success means the native agent files were written, not a successful model inference or reload of an existing OpenCode session.
