import type { IAgentDefinition } from '../interfaces';

/** Keep prompt bytes intact; only an empty optional OpenCode parameter is omitted. */
export function normalizedAgentDefinition(value: IAgentDefinition): IAgentDefinition {
    const permission = Object.fromEntries(
        Object.entries(value.permission ?? {}).filter(([, action]) => action !== undefined),
    );
    const optional = Object.fromEntries(
        ['model', 'temperature', 'topP', 'steps'].flatMap((key) => {
            const raw = value[key as keyof IAgentDefinition];
            const normalized = typeof raw === 'string' ? raw.trim() : raw;
            return normalized === '' || normalized === null || normalized === undefined ? [] : [[key, normalized]];
        }),
    );
    return { description: value.description.trim(), prompt: value.prompt, mode: value.mode, permission, ...optional };
}
