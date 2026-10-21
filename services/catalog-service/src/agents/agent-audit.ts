export const AGENT_AUDIT_ACTIONS = [
    'agent.create','agent.update','agent.archive','agent.restore','agent.import','agent.snapshot',
    'project.agent.assign','project.agent.update','project.agent.remove','project.agents.connect',
] as const;
const actions = new Set<string>(AGENT_AUDIT_ACTIONS);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** The common journal exposes revision metadata without duplicating private prompts or permissions. */
export function agentAuditSnapshot(value: unknown): Record<string, string | number | boolean> | null {
    if (!object(value)) return null;
    const result: Record<string, string | number | boolean> = {};
    for (const key of ['id','name','slug','kind','projectId','projectName','manifest','manifestSha256','promptSha256','deviceId','bindingId','instanceId','jobId','mode','hash']) {
        if (typeof value[key] === 'string') result[key] = value[key];
    }
    for (const key of ['version','revision']) {
        if (Number.isSafeInteger(value[key]) && Number(value[key]) >= 0) result[key] = Number(value[key]);
    }
    for (const key of ['enabled','removed','overridden','archived']) {
        if (typeof value[key] === 'boolean') result[key] = value[key];
    }
    if (Array.isArray(value.projects)) result.projectsCount = value.projects.length;
    return result;
}

export function isAgentAuditEvent(action: string, details: {before: unknown; after: unknown} | null | undefined): boolean {
    if (actions.has(action)) return true;
    return ['asset.archive','asset.restore'].includes(action) && [details?.before,details?.after].some(value => object(value) && value.kind === 'agent');
}
