/** Only the approved archive SHA-256 check may produce this bounded integrity code. */
export class RuntimeArtifactIntegrityError extends Error {
    constructor(
        readonly code: 'runtime-artifact-sha-mismatch',
        readonly expected: string,
        readonly computed: string,
        message: string,
    ) {
        super(message);
        this.name = 'RuntimeArtifactIntegrityError';
    }
}
