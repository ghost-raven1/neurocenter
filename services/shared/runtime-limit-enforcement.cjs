'use strict';
const { RUNTIME_LIMIT_CEILINGS, DEFAULT_RUNTIME_LIMIT_POLICY } = require('./runtime-limits.cjs');

/**
 * AD-1/AD-12 (epic-res-obs entry 4): единый источник таблицы «секция → enforcement-точка → тест».
 *
 * Модель (AD-1): ceiling — константа в едином источнике (RUNTIME_LIMIT_CEILINGS),
 * политика — default ≤ policy ≤ ceiling (DB runtime_limit_settings, RuntimeLimitsService).
 * P0-RES (R11): у каждого заявленного лимита есть enforcement-точка; лимит, который
 * не работает, — дефект.
 *
 * Data-driven: набор секций определяет RUNTIME_LIMIT_CEILINGS, НЕ эта таблица —
 * новые секции (epic 2/5) completeness-тест подхватывает автоматически:
 * секция в CEILINGS без записи здесь (и без явно allowlist-исключения с причиной) = фэйл сьюта.
 *
 * Enforcement-точка — место, где политика применяется ДО операции (admission),
 * а не пост-фактум проверка. Поле `marker` — доказательство применения политики
 * в файле точки (подстрока, обязанная встречаться в enforcement-файле).
 * Точная строка намеренно НЕ фиксируется (строки гниют при правках; файл+символ стабильнее).
 */
const ENFORCEMENT_POINTS = Object.freeze({
    textKnowledge: Object.freeze({
        // admission при выборе контекста: captureText валидирует против действующей политики
        // (new RuntimeLimitsService(models).effective() → policy.policy.textKnowledge).
        file: 'services/catalog-service/src/model-chat/chat-project-context.ts',
        symbol: 'captureText',
        marker: 'RuntimeLimitsService',
        test: 'services/catalog-service/src/model-chat/tests/chat-project-context.test.ts',
    }),
    ggufImport: Object.freeze({
        // GgufImportService шнурует действующую политику в admission импорта:
        // super(..., () => limits.ggufPolicy()) → ggufIntent(raw, limits) + quota ДО записи.
        file: 'services/catalog-service/src/models/gguf-import/gguf-import.service.ts',
        symbol: 'GgufImportService',
        marker: 'ggufPolicy',
        test: 'services/catalog-service/src/models/gguf-import/tests/gguf-import-enforcement.test.ts',
    }),
});

/**
 * Секции, осознанно без enforcement-точки — allowlist с причиной (паттерн AD-8:
 * явный остаток, а не тишина). Пуст: все текущие секции имеют enforcement-точки.
 * Секция и здесь, и в ENFORCEMENT_POINTS = фэйл (противоречие таблицы).
 */
const ENFORCEMENT_EXEMPTIONS = Object.freeze({});

/**
 * Вырожденные значения (ceiling = default / placeholder, не финализированный product-значением)
 * — Deferred по AD-1: «текущие вырожденные значения … поправить при финализации значений (Deferred)».
 * В сьюте — флаг (не фэйл); новое вырождение ВНЕ этого allowlist = фэйл.
 * Изменение ceiling = релиз контракта (epic 2, AD-12) — здесь значения не трогаются.
 */
const DEGENERATE_DEFERRED = Object.freeze({
    'textKnowledge.fileBytes':
        'AD-1: финализация значений — Deferred (128 KiB — осознанный лимит: PostgreSQL tsvector < 1 MiB)',
    'ggufImport.maximumBytes': 'AD-1: финализация значений — Deferred (8 TiB — placeholder ceiling)',
    'ggufImport.storageQuotaBytes': 'AD-1: финализация значений — Deferred (32 TiB — placeholder ceiling)',
});

/**
 * AD-12: ceiling-значения существуют ровно в одном месте (services/shared — re-export
 * единого источника); локальный ceiling-литерал в сервисном бинарии = фэйл.
 * Существующие вхождения, где значение другого домена совпало с ceiling
 * (chat-протокол, SQL CHECK, capacity-оценки, пагинация) — задокументированный остаток:
 * файл + точная строка + причина. Новое вхождение = фэйл; протухшая запись = фэйл.
 * Тестовые файлы (fixtures) и строковые литералы (SQL-конструкции) в проверку не входят.
 */
const CEILING_LITERAL_ALLOWLIST = Object.freeze([
    Object.freeze({
        file: 'services/catalog-service/src/agents/agent-job-compiler.ts',
        line: 'Buffer.byteLength(JSON.stringify(input)) > 128 * 1024',
        reason: 'chat/agent-протокол: размер JSON input, не ceiling runtime-limits',
    }),
    Object.freeze({
        file: 'services/catalog-service/src/asset-sources/source-archive-reader-files.ts',
        line: 'pathIdentityBytes: 16 * 1024 ** 2,',
        reason: 'asset-контракт: лимит path-identity, не ceiling runtime-limits',
    }),
    Object.freeze({
        file: 'services/catalog-service/src/asset-sources/source-archive-validation.ts',
        line: 'if (!match || match[1] !== file.sha256 || (!blob && file.bytes > 16 * 1024 ** 2))',
        reason: 'asset-контракт: размер файла source-архива, не ceiling runtime-limits',
    }),
    Object.freeze({
        file: 'services/catalog-service/src/background-agent/method-preparation.ts',
        line: 'const MANIFEST_LIMIT = 128 * 1024;',
        reason: 'background-agent: лимит manifest, не ceiling runtime-limits',
    }),
    Object.freeze({
        file: 'services/catalog-service/src/catalog-requests/request.validation.ts',
        line: 'page: positive(input.page, 1, 1000000),',
        reason: 'пагинация: верхняя граница страницы, не ceiling metadataPairs/tensorCount',
    }),
    Object.freeze({
        file: 'services/catalog-service/src/model-chat/chat-compaction.ts',
        line: 'const MAX_TEXT_BYTES = 128 * 1024;',
        reason: 'chat-протокол: лимит текста компрессии, не ceiling runtime-limits',
    }),
    Object.freeze({
        file: 'services/catalog-service/src/model-chat/chat-compaction.ts',
        line: 'if (context.requestBytes > 8 * 1024 ** 2) return true;',
        reason: 'chat-протокол: порог запроса компрессии, не ceiling runtime-limits',
    }),
    Object.freeze({
        file: 'services/catalog-service/src/model-chat/chat-context.ts',
        line: 'const MAX_MESSAGE_BYTES = 131072,',
        reason: 'chat-протокол: размер сообщения, не ceiling textKnowledge.fileBytes',
    }),
    Object.freeze({
        file: 'services/catalog-service/src/model-chat/chat-context.ts',
        line: 'MAX_REQUEST_BYTES = 8388608;',
        reason: 'chat-протокол: размер запроса, не ceiling textKnowledge.batchBytes',
    }),
    Object.freeze({
        file: 'services/catalog-service/src/model-chat/chat-context.ts',
        line: 'maxMessageBytes: 131072;',
        reason: 'chat-протокол: interface-член MAX_MESSAGE_BYTES, не ceiling runtime-limits',
    }),
    Object.freeze({
        file: 'services/catalog-service/src/model-chat/chat-context.ts',
        line: 'maxRequestBytes: 8388608;',
        reason: 'chat-протокол: interface-член MAX_REQUEST_BYTES, не ceiling runtime-limits',
    }),
    Object.freeze({
        file: 'services/catalog-service/src/model-chat/chat-project-context.ts',
        line: 'if (Buffer.byteLength(prompt) > 128 * 1024)',
        reason: 'chat-протокол: размер prompt, не ceiling textKnowledge.fileBytes',
    }),
    Object.freeze({
        file: 'services/catalog-service/src/model-chat/chat-round.ts',
        line: 'Buffer.byteLength(JSON.stringify(message.content)) > 8 * 1024 ** 2 ||',
        reason: 'chat-протокол: размер контента сообщения, не ceiling runtime-limits',
    }),
    Object.freeze({
        file: 'services/catalog-service/src/model-chat/chat-round.ts',
        line: 'if (Buffer.byteLength(JSON.stringify(groups.aggregate(next))) > 8 * 1024 ** 2)',
        reason: 'chat-протокол: размер агрегата, не ceiling runtime-limits',
    }),
    Object.freeze({
        file: 'services/catalog-service/src/model-chat/chat-validation.ts',
        line: 'Buffer.byteLength(value) > 128 * 1024',
        reason: 'chat-протокол: валидация поля, не ceiling runtime-limits',
    }),
    Object.freeze({
        file: 'services/catalog-service/src/model-chat/chat.service.ts',
        line: 'Buffer.byteLength(JSON.stringify(message.content)) > 8 * 1024 ** 2 ||',
        reason: 'chat-протокол: размер контента сообщения, не ceiling runtime-limits',
    }),
    Object.freeze({
        file: 'services/catalog-service/src/model-chat/chat.service.ts',
        line: 'if (Buffer.byteLength(text) > 128 * 1024)',
        reason: 'chat-протокол: размер текста, не ceiling runtime-limits',
    }),
    Object.freeze({
        file: 'services/catalog-service/src/models/inference.controller.ts',
        line: "if (typeof content !== 'string' || Buffer.byteLength(content) > 128 * 1024) {",
        reason: 'chat-протокол: размер content, не ceiling runtime-limits',
    }),
    Object.freeze({
        file: 'services/catalog-service/src/models/project-rag-client.ts',
        line: 'if (size > 8 * 1024 ** 2) {',
        reason: 'межсервисный transport: бюджет ответа RAG-клиента, не ceiling runtime-limits',
    }),
    Object.freeze({
        file: 'services/catalog-service/src/package-build/build-runtime.ts',
        line: 'if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > 16 * 1024 ** 2)',
        reason: 'package-build: размер файла build-runtime, не ceiling runtime-limits',
    }),
    Object.freeze({
        file: 'services/catalog-service/src/package-build/catalog-rebuild-state.ts',
        line: "const value = (await localJson(file + '.status.json', 128 * 1024)) as ICatalogRebuildState | undefined;",
        reason: 'package-build: бюджет чтения status.json, не ceiling runtime-limits',
    }),
    Object.freeze({
        file: 'services/catalog-service/src/package-build/package-agent.inventory.ts',
        line: 'bytes: config.source.type === \'files\' ? 8 * 1024 ** 2 : stagingLimit,',
        reason: 'package-build: оценка размера inventory, не ceiling runtime-limits',
    }),
    Object.freeze({
        file: 'services/catalog-service/src/package-build/package-build.service.ts',
        line: 'bytes: Buffer.byteLength(JSON.stringify(config)) + 131072,',
        reason: 'package-build: оценка headroom JSON-конфига, не ceiling runtime-limits',
    }),
    Object.freeze({
        file: 'services/catalog-service/src/project-chat-inference/project-chat-inference.service.ts',
        line: 'Buffer.byteLength(message.content) > 128 * 1024 ||',
        reason: 'chat-протокол: размер контента, не ceiling runtime-limits',
    }),
    Object.freeze({
        file: 'services/catalog-service/src/project-chat/project-chat-share.ts',
        line: 'const MAX_CONTENT_BYTES = 8 * 1024 ** 2;',
        reason: 'chat-протокол: размер shared-контента, не ceiling runtime-limits',
    }),
    Object.freeze({
        file: 'services/catalog-service/src/project-chat/project-chat.runner.ts',
        line: 'if (!answer.content.trim() || Buffer.byteLength(answer.content) > 8 * 1024 ** 2)',
        reason: 'chat-протокол: размер ответа модели, не ceiling runtime-limits',
    }),
    Object.freeze({
        file: 'services/catalog-service/src/project-chat/project-chat.validation.ts',
        line: 'Buffer.byteLength(body.prompt) > 131072 ||',
        reason: 'chat-протокол: размер prompt, не ceiling runtime-limits',
    }),
    Object.freeze({
        file: 'services/catalog-service/src/snapshots/snapshot-storage.ts',
        line: 'if (disk.bavail * disk.bsize < BigInt(bytes.length) + BigInt(256 * 1024 ** 2))',
        reason: 'snapshots: резерв диска перед записью, не ceiling runtime-limits',
    }),
    Object.freeze({
        file: 'services/catalog-service/src/source-upload/source-upload.model.ts',
        line: 'export const uploadLimit = 256 * 1024 ** 2;',
        reason: 'source-upload (asset-контракт): лимит загрузки, не ceiling runtime-limits',
    }),
    Object.freeze({
        file: 'services/catalog-service/src/system-roles/system-role.service.ts',
        line: 'if (Buffer.byteLength(JSON.stringify(snapshot)) > 524288 || Buffer.byteLength(JSON.stringify(input)) > 131072)',
        reason: 'system-roles: размер input, не ceiling runtime-limits',
    }),
    Object.freeze({
        file: 'services/rag-sync-service/src/rag/rag-db.ts',
        line: "const estimate = Math.max(16 * 1024 ** 2, Buffer.byteLength(JSON.stringify(upserts), 'utf8') * 6);",
        reason: 'RAG capacity-оценка max(16MiB, 6×JSON) — паттерн capacity.cjs, не ceiling runtime-limits',
    }),
    Object.freeze({
        file: 'services/rag-sync-service/src/rag/rag-generations.ts',
        line: 'bytes: Math.max(16 * 1024 ** 2, Buffer.byteLength(JSON.stringify(values)) * 6),',
        reason: 'RAG capacity-оценка max(16MiB, 6×JSON) — паттерн capacity.cjs, не ceiling runtime-limits',
    }),
    Object.freeze({
        file: 'services/rag-sync-service/src/rag/rag-generations.ts',
        line: 'bytes: Math.max(16 * 1024 ** 2, source.bytes * 6),',
        reason: 'RAG capacity-оценка max(16MiB, 6×JSON) — паттерн capacity.cjs, не ceiling runtime-limits',
    }),
]);

module.exports = {
    ENFORCEMENT_POINTS,
    ENFORCEMENT_EXEMPTIONS,
    DEGENERATE_DEFERRED,
    CEILING_LITERAL_ALLOWLIST,
    RUNTIME_LIMIT_CEILINGS,
    DEFAULT_RUNTIME_LIMIT_POLICY,
};
