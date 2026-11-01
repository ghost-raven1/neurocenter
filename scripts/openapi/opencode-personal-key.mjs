import {
    OPENCODE_PERSONAL_KEY_JOB as kind,
    OPENCODE_PERSONAL_KEY_SCHEMAS as schemas,
} from '../../services/shared/opencode-personal-key.cjs';
export const personalKeySchemas = {
    OpenCodePersonalKeyRequest: schemas.request,
    OpenCodePersonalKeyPayload: schemas.payload,
    OpenCodePersonalKeyResult: schemas.result,
    OpenCodePersonalKeyReceipt: schemas.receipt,
    OpenCodePersonalKeyContext: schemas.context,
};
const ref = (name) => ({ $ref: '#/components/schemas/OpenCodePersonalKey' + name });
const json = (schema) => ({ 'application/json': { schema } });
const lookup = () => ({
    type: 'object',
    additionalProperties: false,
    required: ['receipt'],
    properties: { receipt: { ...schemas.receipt, nullable: true } },
});
/** The write-only credential exists only in the direct authenticated device POST, never the job schema. */
export function describePersonalKey(operation, path, http) {
    if (path === '/api/device-jobs' && http === 'post') {
        const body = operation.requestBody?.content?.['application/json'];
        if (body)
            body.schema = {
                oneOf: [
                    { allOf: [body.schema, { type: 'object', properties: { kind: { not: { enum: [kind] } } } }] },
                    ref('Request'),
                ],
            };
        operation['x-neurocenter-job-kind-contracts'] = {
            ...operation['x-neurocenter-job-kind-contracts'],
            [kind]: { request: ref('Request'), payload: ref('Payload'), result: ref('Result') },
        };
    }
    const privateRoute = /^\/(?:api|internal)\/device-channel\/opencode-personal-key\/(context|save|receipt)$/.exec(
        path,
    );
    if (privateRoute && http === 'post') {
        const action = privateRoute[1];
        operation.requestBody = {
            required: true,
            content: json({
                type: 'object',
                additionalProperties: false,
                required: action === 'save' ? ['jobId', 'apiKey'] : ['jobId'],
                properties: {
                    jobId: { type: 'string', format: 'uuid' },
                    ...(action === 'save'
                        ? {
                              apiKey: {
                                  type: 'string',
                                  format: 'password',
                                  writeOnly: true,
                                  minLength: 1,
                                  maxLength: 8192,
                              },
                          }
                        : {}),
                },
            }),
        };
        operation.responses['200'] = {
            description:
                action === 'context'
                    ? 'Pinned recipient for explicit local consent.'
                    : action === 'save'
                      ? 'Write-only personal key accepted; no inference was performed.'
                      : 'Existing receipt remains readable when transfer is disabled.',
            content: json(action === 'context' ? ref('Context') : action === 'save' ? ref('Receipt') : lookup()),
        };
    }
    if (/^\/api\/models\/[^/]+\/my-access\/transfers\/[^/]+$/.test(path) && http === 'get') {
        operation.responses['200'] = {
            description:
                'Owner-scoped receipt without the key or a key-derived hash; readable after feature OFF and session expiry.',
            content: json({
                ...lookup(),
                required: ['receipt', 'canStartNew'],
                properties: { ...lookup().properties, canStartNew: { type: 'boolean' } },
            }),
        };
    }
    return operation;
}
