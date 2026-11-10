import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse as parseJsonc, type ParseError } from 'jsonc-parser';
import { readOpenCodeModelMetadata } from '../../bridge/opencode-model-scan.js';
import { loadRagConfig } from '../../lib/config.js';
import type { IOpenCodeModelCandidate } from '../../../../../services/shared/opencode-model-scan.cjs';

/**
 * Разрешение моделей по подсистемам устройства (Epic 12, story 12.1, решение (в)).
 *
 * Дефолтные модели (chat/vision) и ключи провайдеров читаются ТОЛЬКО из
 * opencode-конфига компьютера (opencode.json/jsonc слои + auth store) и
 * профиля embedding из opencode-rag.json. Тихого fallback на каталог НЕТ:
 * при отсутствии конфигурации возвращается явный `config-missing` с
 * подсказкой, что именно добавить (решение (г) — шаг онбординга
 * «предложить заполнить»).
 */

export type TSubsystem = 'chat' | 'vision' | 'rag-embedding';

export interface ISubsystemModel {
    subsystem: TSubsystem;
    status: 'resolved' | 'config-missing';
    provider?: string;
    model?: string;
    hasKey: boolean;
    credentialSource?: IOpenCodeModelCandidate['credentialSource'];
    guidance?: string;
}

export interface ISubsystemResolution {
    status: 'ok' | 'config-missing';
    configPresent: boolean;
    subsystems: ISubsystemModel[];
    guidance?: string;
}

const CHAT_GUIDANCE =
    'Задайте дефолтную chat-модель в opencode.json компьютера: "model": "<provider>/<model>" (провайдер должен иметь ключ).';
const VISION_GUIDANCE =
    'Добавьте в opencode.json vision-модель с ключом (modalities.input должна включать "image").';
const RAG_GUIDANCE =
    'Добавьте embedding-профиль в opencode-rag.json: "embedding": { "provider", "model", "baseUrl" } с доступным ключом.';

function matchSelector(candidates: IOpenCodeModelCandidate[], selector: string): IOpenCodeModelCandidate | undefined {
    if (!selector.includes('/')) return undefined;
    const [provider, ...parts] = selector.split('/');
    const model = parts.join('/');
    if (!provider || !model) return undefined;
    return candidates.find(
        (candidate) =>
            candidate.provider === provider &&
            (candidate.model === model || candidate.modelVersion === model || candidate.configKey === model),
    );
}

function matchEmbedding(candidates: IOpenCodeModelCandidate[], embedding: { provider: string; model: string }) {
    return candidates.find(
        (candidate) =>
            candidate.provider === embedding.provider &&
            (candidate.model === embedding.model || candidate.modelVersion === embedding.model),
    );
}

/**
 * Чистое ядро: разрешает модели подсистем из кандидатов opencode, селектора
 * дефолтной модели и embedding-профиля. Не читает файловую систему.
 */
export function resolveSubsystemModelsFromInputs(inputs: {
    candidates: IOpenCodeModelCandidate[];
    defaultModel?: string;
    ragEmbedding?: { provider: string; model: string; baseUrl: string | null } | null;
}): ISubsystemResolution {
    const { candidates, defaultModel, ragEmbedding } = inputs;
    const configPresent = candidates.length > 0;
    if (!configPresent) {
        return {
            status: 'config-missing',
            configPresent: false,
            guidance:
                'На компьютере не найден opencode-конфиг с моделями. Заполните opencode.json: "model" и провайдера с ключом, а для RAG — embedding в opencode-rag.json.',
            subsystems: [
                { subsystem: 'chat', status: 'config-missing', hasKey: false, guidance: CHAT_GUIDANCE },
                { subsystem: 'vision', status: 'config-missing', hasKey: false, guidance: VISION_GUIDANCE },
                { subsystem: 'rag-embedding', status: 'config-missing', hasKey: false, guidance: RAG_GUIDANCE },
            ],
        };
    }

    const subsystems: ISubsystemModel[] = [];

    // chat = config.model (дефолтная модель устройства).
    const chat = matchSelector(candidates, defaultModel ?? '');
    if (defaultModel && chat) {
        subsystems.push({
            subsystem: 'chat',
            status: 'resolved',
            provider: chat.provider,
            model: chat.model,
            hasKey: chat.hasKey,
            credentialSource: chat.credentialSource,
        });
    } else {
        subsystems.push({ subsystem: 'chat', status: 'config-missing', hasKey: false, guidance: CHAT_GUIDANCE });
    }

    // vision = первый vision-кандидат с ключом и без блокировки.
    const vision = candidates.find((candidate) => candidate.capability === 'vision' && candidate.hasKey && !candidate.blocker);
    if (vision) {
        subsystems.push({
            subsystem: 'vision',
            status: 'resolved',
            provider: vision.provider,
            model: vision.model,
            hasKey: vision.hasKey,
            credentialSource: vision.credentialSource,
        });
    } else {
        subsystems.push({ subsystem: 'vision', status: 'config-missing', hasKey: false, guidance: VISION_GUIDANCE });
    }

    // rag-embedding = профиль из opencode-rag.json + совпадающий ключ.
    let rag: ISubsystemModel;
    if (!ragEmbedding || !ragEmbedding.provider || !ragEmbedding.model) {
        rag = { subsystem: 'rag-embedding', status: 'config-missing', hasKey: false, guidance: RAG_GUIDANCE };
    } else {
        const exact = matchEmbedding(candidates, ragEmbedding);
        if (exact) {
            rag = {
                subsystem: 'rag-embedding',
                status: 'resolved',
                provider: exact.provider,
                model: ragEmbedding.model,
                hasKey: exact.hasKey,
                credentialSource: exact.credentialSource,
            };
        } else {
            const providerKey = candidates.find((candidate) => candidate.provider === ragEmbedding.provider && candidate.hasKey);
            rag = providerKey
                ? {
                      subsystem: 'rag-embedding',
                      status: 'resolved',
                      provider: providerKey.provider,
                      model: ragEmbedding.model,
                      hasKey: true,
                      credentialSource: providerKey.credentialSource,
                  }
                : { subsystem: 'rag-embedding', status: 'config-missing', hasKey: false, guidance: RAG_GUIDANCE };
        }
    }
    subsystems.push(rag);

    const allResolved = subsystems.every((item) => item.status === 'resolved');
    return {
        status: allResolved ? 'ok' : 'config-missing',
        configPresent: true,
        subsystems,
        ...(allResolved
            ? {}
            : { guidance: 'Часть подсистем не разрешена из конфигурации устройства. Заполните отсутствующие модели и ключи.' }),
    };
}

/** Читает top-level `model` из user-global слоёв opencode-конфига (последний заданный выигрывает). */
async function readDefaultChatModel(home: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
    const readModel = async (file: string): Promise<string | undefined> => {
        try {
            const source = (await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, '');
            const errors: ParseError[] = [];
            const value: unknown = parseJsonc(source, errors, { allowTrailingComma: true });
            if (errors.length || !value || typeof value !== 'object' || Array.isArray(value)) return undefined;
            const model = (value as { model?: unknown }).model;
            return typeof model === 'string' && model.includes('/') ? model : undefined;
        } catch {
            return undefined;
        }
    };
    const layers: string[] = [];
    const xdg = path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'opencode');
    for (const name of ['config.json', 'opencode.json', 'opencode.jsonc']) layers.push(path.join(xdg, name));
    if (env.OPENCODE_CONFIG) layers.push(path.resolve(env.OPENCODE_CONFIG));
    for (const name of ['opencode.json', 'opencode.jsonc']) layers.push(path.join(home, '.opencode', name));
    for (const file of layers) {
        const model = await readModel(file);
        if (model) return model;
    }
    // OPENCODE_CONFIG_CONTENT проверяется последним (inline-слой).
    if (env.OPENCODE_CONFIG_CONTENT) {
        try {
            const errors: ParseError[] = [];
            const value: unknown = parseJsonc(env.OPENCODE_CONFIG_CONTENT, errors, { allowTrailingComma: true });
            if (!errors.length && value && typeof value === 'object' && !Array.isArray(value)) {
                const model = (value as { model?: unknown }).model;
                if (typeof model === 'string' && model.includes('/')) return model;
            }
        } catch {
            // некорректный inline-слой игнорируется
        }
    }
    return undefined;
}

export interface IResolveSubsystemModelsOptions {
    root: string;
    home?: string;
    environment?: NodeJS.ProcessEnv;
    authorize?: () => Promise<unknown>;
    ragConfigPath?: string;
}

/**
 * Разрешает модели подсистем устройства из реального opencode-конфига.
 *
 * @param options - корень сканирования, home/окружение (для тестов), путь к opencode-rag.json.
 * @returns разрешение chat/vision/rag-embedding или явный config-missing с подсказками.
 */
export async function resolveSubsystemModels(options: IResolveSubsystemModelsOptions): Promise<ISubsystemResolution> {
    const home = options.home ?? os.homedir();
    const env = options.environment ?? process.env;
    const scan = await readOpenCodeModelMetadata(options.root, { scope: 'global', deviceId: '8f1b2a3c-4d5e-6f70-8192-a3b4c5d6e7f8' }, {
        home,
        environment: env,
        authorize: options.authorize,
        readAuth: true,
    });
    const [defaultModel, ragCore] = await Promise.all([
        readDefaultChatModel(home, env),
        options.ragConfigPath ? loadRagConfig(options.ragConfigPath) : Promise.resolve(null),
    ]);
    return resolveSubsystemModelsFromInputs({
        candidates: scan.candidates,
        defaultModel,
        ragEmbedding: ragCore
            ? {
                  provider: ragCore.embedding.provider,
                  model: ragCore.embedding.model,
                  baseUrl: ragCore.embedding.baseUrl,
              }
            : null,
    });
}
