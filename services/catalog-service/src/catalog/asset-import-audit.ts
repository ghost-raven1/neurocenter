interface ImportAuditItem {assetId: string; name: string; kind: string; version: string}
interface ImportAuditSnapshot {ids: string[]; items: ImportAuditItem[]; repository?: string; commit?: string}
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;

/** Only immutable selected-asset identities leave the job; payloads, source files and credentials never do. */
export function assetImportAuditSnapshot(value: unknown, rawItems: unknown): ImportAuditSnapshot {
    const input = record(value), ids = Array.isArray(input.ids) ? [...new Set(input.ids.filter(id => text(id, 256)))].slice(0, 50) : [];
    const selected = new Set(ids), items: ImportAuditItem[] = [];
    for (const raw of Array.isArray(rawItems) ? rawItems : []) {
        const item = record(raw);
        if (!text(item.assetId, 256) || !selected.has(item.assetId) || !text(item.name, 512) || !text(item.version, 128)
            || !['mcp', 'plugin', 'skill', 'model', 'bridge', 'agent'].includes(String(item.kind)) || items.some(previous => previous.assetId === item.assetId)) continue;
        items.push({assetId: item.assetId, name: item.name, kind: String(item.kind), version: item.version});
    }
    return {ids, items, ...(text(input.repository, 256) ? {repository: input.repository} : {}), ...(typeof input.commit === 'string' && /^[a-f0-9]{40}$/.test(input.commit) ? {commit: input.commit} : {})};
}

/** Read the pinned job descriptions, never the mutable current catalogue or package content. */
export const assetImportAuditJobs = `SELECT jobs.id, COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'assetId',item #>> '{resolved,asset,id}','name',item->>'name','kind',item #>> '{resolved,asset,kind}','version',item #>> '{resolved,asset,version}'))
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jobs.items)='array' THEN jobs.items ELSE '[]'::jsonb END) AS item
    WHERE jobs.selected_ids ? (item #>> '{resolved,asset,id}')), '[]'::jsonb) AS items
    FROM asset_source_jobs jobs WHERE jobs.id::text=ANY($1::text[])`;
