const stages = [
    'preflight',
    'runtime-preparation',
    'transport-loading',
    'transport-call',
    'dispatch-admission',
    'outbound-fetch',
    'response-headers',
    'response-validation',
    'completed',
] as const;

export { stages };

export const httpStages = new Set(['response-headers', 'response-validation', 'completed']);
