import { z } from 'zod';

export const statusSchema = z.object({
    authMethod: z.string().nullable(),
    authToken: z.string().nullable(),
});

export const modelSchema = z.object({
    model: z.string(),
    displayName: z.string(),
    isDefault: z.boolean(),
    hidden: z.boolean(),
    inputModalities: z.array(z.string()),
    defaultReasoningEffort: z.string(),
    supportedReasoningEfforts: z.array(z.object({ reasoningEffort: z.string() })),
});
