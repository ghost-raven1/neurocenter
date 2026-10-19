import { z } from 'zod';

import { detectProject, type IProjectInfo } from '../lib/project.js';
import { locateStore } from '../lib/store.js';

export const detectProjectInputSchema = z
    .object({
        root: z.string().optional().describe('Корень воркспейса (деф. CWD).'),
        dbPath: z.string().optional().describe('Явный путь к rag_db (LanceDB).'),
        projectKey: z
            .string()
            .optional()
            .describe('Авторитетный ключ проекта (из каталога/клиента) для точной привязки.'),
    })
    .strict();

export type TDetectProjectInput = z.infer<typeof detectProjectInputSchema>;

export interface IRagDbBinding {
    configPath: string | null;
    storePath: string | null;
    vectorStorePathConfigured: string | null;
    embedding: { provider: string; model: string; baseUrl: string | null } | null;
    retrieval: { topK: number; minScore: number } | null;
    mcpEnabled: boolean | null;
}

export interface IProjectDetection {
    project: IProjectInfo;
    ragDb: IRagDbBinding;
    notes: string[];
}

/**
 * Сводит воедино: корень проекта, `opencode-rag.json` (локализация), привязку
 * `rag_db ↔ конфиг` и идентификацию проекта (git/package/AGENTS.md).
 *
 * @param input - параметры (root/dbPath/projectKey).
 * @param cwd - базовый каталог.
 */
export async function detectProjectTool(
    input: TDetectProjectInput,
    cwd: string,
): Promise<IProjectDetection> {
    const { root, dbPath, projectKey } = input;
    const located = await locateStore(dbPath ?? root, cwd);
    const project = await detectProject(located.root, projectKey);

    const notes: string[] = [];
    if (!located.configPath) {
        notes.push(
            'opencode-rag.json не найден рядом с root/dbPath — привязка rag_db не подтверждена. Задайте root каталога с opencode-rag.json.',
        );
    } else if (!located.storePath) {
        notes.push(
            'vectorStore.path не задан в opencode-rag.json и .opencode/rag_db рядом не найден.',
        );
    } else {
        notes.push(`rag_db ↔ opencode-rag.json связаны: ${located.storePath}`);
    }

    return {
        project,
        ragDb: {
            configPath: located.configPath,
            storePath: located.storePath,
            vectorStorePathConfigured: located.config?.vectorStorePath ?? null,
            embedding: located.config?.embedding ?? null,
            retrieval: located.config?.retrieval ?? null,
            mcpEnabled: located.config?.mcpEnabled ?? null,
        },
        notes,
    };
}
