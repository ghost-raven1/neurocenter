/** Only local preparation budget checks may produce a bounded pre-dispatch capacity code. */
export class RuntimeArtifactCapacityError extends Error {
    constructor(
        readonly code: 'runtime-cache-full' | 'disk-full',
        message: string,
    ) {
        super(message);
        this.name = 'RuntimeArtifactCapacityError';
    }
}
