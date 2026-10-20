import { ConflictException, Injectable } from '@nestjs/common';
import { existsSync, createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { AssetSourcesService } from '../asset-sources/asset-sources.service';
import type { IModel } from './model.types';
import type { IModelProgress } from './ollama-client';
import { localModelAlias } from './local-model-alias';

type Engine = { hydrateModelBundle(options: Record<string, unknown>): Promise<{ ok: boolean }> };
// Native bundle engine содержит TLA; TS CommonJS не должен переписывать его import в require.
const loadEngine = new Function('url', 'return import(url)') as (url: string) => Promise<Engine>;

/** Установка читает только exact imported source receipt; сетевого fallback или /api/pull нет. */
@Injectable()
export class ModelBundleRuntime {
    constructor(private readonly assets: AssetSourcesService) {}
    async prepare(model: IModel, progress: (value: IModelProgress) => Promise<void>, signal: AbortSignal): Promise<void> {
        if (model.runtime !== 'ollama' || !model.manifestSha256) throw new ConflictException('Сначала импортируйте проверенный ассет модели с закреплённым SHA.');
        signal.throwIfAborted();
        const supply = await this.assets.modelSupply(model.id, model.manifestSha256);
        if (supply.lock.model !== model.model || supply.lock.manifestSha256 !== model.manifestSha256) throw new ConflictException('Поставка не соответствует выбранной версии модели.');
        const development = path.resolve(__dirname, '../../../../scripts/models/bundle.mjs');
        const engineFile=existsSync(development) ? development : '/tools/scripts/models/bundle.mjs';
        const engine = await loadEngine(pathToFileURL(engineFile).href);
        const validator=await loadEngine(pathToFileURL(path.join(path.dirname(engineFile),'bundle-manifest.mjs')).href) as unknown as {validateModelBundle(bundle:unknown,locks:unknown[]):void};
        validator.validateModelBundle(supply.bundle,[supply.lock]);
        const alias=localModelAlias(model),[publicName,publicTag]=model.model.split(':'),[aliasName,aliasTag]=alias.split(':');
        const originalPath=`models/manifests/registry.ollama.ai/${publicName.includes('/')?publicName:'library/'+publicName}/${publicTag}`;
        const aliasPath=`models/manifests/registry.ollama.ai/${aliasName}/${aliasTag}`;
        const runtimeBundle={...supply.bundle,files:(supply.bundle.files as Array<Record<string,unknown>>).map(file=>file.path===originalPath?{...file,path:aliasPath}:file)};
        const runtimeLock={...supply.lock,model:alias};
        const parts = new Map(supply.parts.map(part => [String(part.name), part]));
        const localRead: typeof fetch = async (url, options) => {
            signal.throwIfAborted();
            const requested = String(url), file = requested.slice(requested.lastIndexOf('/') + 1);
            const part = parts.get(file);
            if (!part || requested !== String(supply.bundle.releaseBaseUrl) + '/' + file) throw new ConflictException('Часть модели не зарегистрирована в импортированной поставке.');
            const stream = createReadStream(part.path, { signal: options?.signal ?? signal });
            return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { headers: { 'content-length': String(part.bytes) } });
        };
        const result = await engine.hydrateModelBundle({ directory: process.env.MODEL_STORAGE_PATH || path.resolve(__dirname, '../../../../data/embedding'),
            manifest: runtimeBundle, locks: [runtimeLock], retainExistingTags: true, fetch: localRead, signal,
            onProgress: async (value: { stage: string; message: string; completed: number; total: number }) => {
                signal.throwIfAborted(); await progress({ stage: value.stage, message: value.message,
                    progress: value.total > 0 ? Math.min(85, Math.floor(85 * value.completed / value.total)) : null });
            } });
        signal.throwIfAborted();
        if (result.ok !== true) throw new ConflictException('Установка проверенной поставки модели не подтверждена.');
    }
}
