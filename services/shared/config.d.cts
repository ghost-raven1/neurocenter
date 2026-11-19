export type EnvType = 'positiveInteger' | 'nonNegativeInteger' | 'integer' | 'string' | 'secret' | 'boolean';

export interface EnvSpec {
    name: string;
    type: EnvType;
    required?: boolean;
    default?: unknown;
    description?: string;
    min?: number;
    max?: number;
}

export interface EnvReportEntry {
    name: string;
    type: EnvType;
    description?: string;
    value?: unknown;
    masked?: boolean;
}

export interface ConfigResult {
    values: Record<string, unknown>;
    report: EnvReportEntry[];
}

export declare class ConfigEnvironmentError extends Error {
    issues: string[];
}

export declare function loadConfig(
    schema: EnvSpec[],
    env: NodeJS.ProcessEnv,
    validate?: (values: Record<string, unknown>) => string[],
): ConfigResult;

export declare function formatConfigReport(report: EnvReportEntry[]): string;
