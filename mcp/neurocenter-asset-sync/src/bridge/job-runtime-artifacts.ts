import type { Package } from './package.js';
import { ensureRuntimeArtifact } from '../features/runtime-artifacts/cache.js';
import { downloadJobRuntimeArtifact } from './runtime-artifact-download.js';
import { withRuntimePreparationIntent } from './runtime-preparation-intent.js';
import type { Completion } from './completions.js';

/** Скачивание завершено до транзакции установки, без сторонних реестров и исполняемых install hooks. */
export async function prepareJobRuntimeArtifacts(
    packages: Package[],
    authorize: () => Promise<unknown>,
    progress: (percent: number, message: string) => Promise<unknown>,
    options: { repairCorrupt?: boolean; intent?: Completion } = {},
): Promise<void> {
    await withRuntimePreparationIntent(options.intent, async () => {
        for (const pkg of packages) {
            await ensureRuntimeArtifact(pkg, {
                repairCorrupt: options.repairCorrupt,
                beforeCommit: authorize,
                download: async (descriptor) => {
                    await authorize();
                    await progress(5, 'Загружаем проверенный готовый комплект для этого компьютера.');
                    return downloadJobRuntimeArtifact(descriptor);
                },
            });
        }
    });
}
