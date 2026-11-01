export type TAdapterJson = null | boolean | number | string | TAdapterJson[] | { [key: string]: TAdapterJson };
export type TAdapterParameters = { [key: string]: TAdapterJson };
export interface IAdapterParameterDefinition {
    readonly id: string;
    readonly wirePath: readonly string[];
    readonly protectedKeys: readonly string[];
    readonly maximumBytes: number;
    readonly maximumDepth: number;
    readonly maximumNodes: number;
}
export const ADAPTER_PARAMETER_DEFINITIONS: Readonly<
    Record<'openai-chat-completions' | 'openai-responses' | 'ollama', IAdapterParameterDefinition>
>;
export function normalizeAdapterParameters(
    value: unknown,
    definition?: IAdapterParameterDefinition,
): TAdapterParameters;
export function applyAdapterParameters(
    body: Record<string, unknown>,
    parameters: unknown,
    definition: IAdapterParameterDefinition,
): Record<string, unknown>;
export interface IAdapterParameterIssue {
    name: string;
    type: string;
}
export function adapterParameterIssues(value: unknown, known: readonly string[]): IAdapterParameterIssue[];
