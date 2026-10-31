import type { Package } from '../../bridge/package.js';
import { localRagCore } from '../rag-core/contract.js';
import { missingConfigurationFields, type LocalConfigurationSchema, type ConfigurationValues } from './schema.js';

/** Defaults существуют только в закреплённом RAG CLI; сохранённые значения и схема не меняются. */
export function missingLaunchFields(
    pkg: Package,
    schema: LocalConfigurationSchema,
    values: ConfigurationValues,
): string[] {
    const missing = missingConfigurationFields(schema, values);
    if (!localRagCore(pkg)) return missing;
    return missing.filter(
        (id) =>
            !schema.fields.some(
                (field) =>
                    field.id === id &&
                    field.target.kind === 'env' &&
                    ((field.type === 'url' &&
                        id === 'embeddingUrl' &&
                        field.target.name === 'NEUROCENTER_RAG_EMBEDDING_URL') ||
                        (field.type === 'string' &&
                            id === 'embeddingModel' &&
                            field.target.name === 'NEUROCENTER_RAG_EMBEDDING_MODEL')),
            ),
    );
}
