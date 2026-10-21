import { createBridgeRequestKey } from '../McpBridge/bridgeRequestKey';

/** A lost acknowledgement retries the exact payload, including its original CAS revision. */
export function createAgentRequestKeys(generate: () => string = createBridgeRequestKey) {
    const keys = new Map<string, string>();
    return {
        forRequest: (operation: string, body: unknown): string => {
            const fingerprint = JSON.stringify([operation, body]);
            let key = keys.get(fingerprint);
            if (!key) { key = generate(); keys.set(fingerprint, key); }
            return key;
        },
        clear: (): void => keys.clear(),
    };
}
