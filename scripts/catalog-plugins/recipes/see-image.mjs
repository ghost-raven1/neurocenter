import fs from 'node:fs/promises';
import path from 'node:path';
import bundledCatalog from '../../../services/shared/bundled-catalog.cjs';

const repository = 'https://github.com/alfaoz/opencode-see-image';
const commit = '091becb8159b031423b01737c80c0891e11d803b';
const entrypoint = 'index.ts';

export const SEE_IMAGE_REVISION = 'git-' + commit;

/** Approved See Image source is shipped with the app; only its exact locked npm dependencies need a registry. */
export async function prepareBundledSeeImage(recipe, context, { prepareProject }) {
    const component = await bundledCatalog.readBundledComponent('opencode-see-image');
    const staged = await fs.mkdtemp(path.join(path.dirname(context.directory), '.see-image-source-'));
    try {
        for (const [name, bytes] of component.files) {
            if (!name.startsWith('source/')) continue;
            const filename = path.join(staged, name.slice(7));
            await fs.mkdir(path.dirname(filename), { recursive: true });
            await fs.writeFile(filename, bytes, { flag: 'wx' });
        }
        const result = await prepareProject(
            { ...recipe, source: { type: 'project', directory: '.', entrypoint } },
            { ...context, recipeDirectory: staged },
        );
        // Хост плагинов OpenCode находит серверную точку входа через name+exports в package.json
        // пакета (Host.resolve в packages/plugin/src/host.ts); общий манифест артефакта
        // ({private,type}) имени не имеет, и каталог без index.* молча отбрасывается.
        const manifest = {
            name: 'opencode-see-image',
            version: '1.5.0',
            private: true,
            type: 'module',
            main: './' + result.entrypoint,
            exports: { '.': './' + result.entrypoint },
        };
        await fs.writeFile(path.join(context.directory, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
        return { ...result, upstream: { ...result.upstream, repository, commit } };
    } finally {
        await fs.rm(staged, { recursive: true, force: true });
    }
}
