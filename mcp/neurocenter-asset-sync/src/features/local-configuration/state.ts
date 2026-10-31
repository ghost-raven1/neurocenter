import { missingLaunchFields } from './launch-fields.js';
import { randomUUID } from 'node:crypto';
import { readPrivateConfiguration, writePrivateConfiguration } from './private-store.js';
import type { ConfigurationContext } from './context.js';
import { validateConfigurationValues, type ConfigurationValues } from './schema.js';

interface StoredConfiguration {
    schemaVersion: 1;
    scope: ConfigurationContext['scope'];
    revision: string;
    values: ConfigurationValues;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const pendingWrites = new Map<string, Promise<void>>();
export async function readConfiguration(context: ConfigurationContext): Promise<StoredConfiguration | undefined> {
    const stored = await readPrivateConfiguration<StoredConfiguration>(context.key);
    if (
        stored &&
        (stored.schemaVersion !== 1 ||
            !uuid.test(stored.revision) ||
            JSON.stringify(stored.scope) !== JSON.stringify(context.scope) ||
            Object.keys(stored).some((key) => !['schemaVersion', 'scope', 'revision', 'values'].includes(key)))
    ) {
        throw new Error('Локальная настройка повреждена.');
    }
    if (stored) {
        stored.values = validateConfigurationValues(context.schema, stored.values);
    }
    return stored;
}
export async function configurationStatus(context: ConfigurationContext) {
    await pendingWrites.get(context.key);
    const stored = await readConfiguration(context);
    const missingFieldIds = missingLaunchFields(context.pkg, context.schema, stored?.values ?? {});
    return {
        ...context.tuple,
        ready: missingFieldIds.length === 0,
        missingFieldIds,
        revision: stored?.revision ?? null,
        checkedAt: new Date().toISOString(),
    };
}
/** CAS защищает две открытые формы; новая ревизия аннулирует прежнюю диагностику. */
export async function saveConfiguration(
    context: ConfigurationContext,
    input: unknown,
    expectedRevision: string | null,
    authorize: () => Promise<void>,
    beforeCommit: () => void = () => {},
): Promise<void> {
    const prior = pendingWrites.get(context.key);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    const chain = (prior ?? Promise.resolve()).then(() => gate);
    pendingWrites.set(context.key, chain);
    await prior;
    try {
        const values = validateConfigurationValues(context.schema, input);
        const before = await readConfiguration(context);
        if ((before?.revision ?? null) !== expectedRevision) {
            throw new Error('Настройка изменена в другом окне.');
        }
        await authorize();
        await context.assertCurrent();
        await writePrivateConfiguration(
            context.key,
            { schemaVersion: 1, scope: context.scope, revision: randomUUID(), values },
            before,
            beforeCommit,
        );
    } finally {
        release();
        if (pendingWrites.get(context.key) === chain) {
            pendingWrites.delete(context.key);
        }
    }
}
