export interface ISkillSourceFile {
    path: string;
    content: string;
    encoding?: 'base64';
}
export interface IParsedSkillSource {
    entrypoint: string;
    slug: string;
    name: string;
    description: string;
    body: string;
    meta: { description: string; tags: string[]; mcp: []; plugins: []; specialization?: string };
    resources: ISkillSourceFile[];
}
export function parseSkillSource(
    files: ISkillSourceFile[],
    overrides?: { name?: string; description?: string; entrypoint?: string; metadataOnly?: boolean },
    parseYaml?: (value: string) => unknown,
): IParsedSkillSource;
export function skillSourceEntrypoints(files: ISkillSourceFile[]): string[];
export function validateSkillLinks(content: string, paths: string[]): void;
