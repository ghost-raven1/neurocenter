import type { AuthHook } from '@opencode-ai/plugin';

export type TAuthOAuthResult = Awaited<
    ReturnType<
        Extract<
            AuthHook['methods'][number],
            {
                type: 'oauth';
            }
        >['authorize']
    >
>;
