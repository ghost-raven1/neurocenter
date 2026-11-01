/** Type-only receipts keep consumer build roots intact; checked storage is separate from runtime readiness. */
export interface IGgufMetadata {
    format: 'gguf';
    version: 2 | 3;
    architecture: string;
    tensorCount: number;
    metadataCount: number;
}
export interface IGgufFileImport {
    format: 'gguf';
    uploadId: string;
    sha256: string;
    bytes: number;
    fileName: string;
    architecture: string;
    version: 2 | 3;
}
export interface IGgufImportIntent {
    requestKey: string;
    fileName: string;
    bytes: number;
    expectedSha256?: string;
}
export interface IGgufImportReceipt extends IGgufImportIntent {
    id: string;
    state: 'WAITING' | 'UPLOADING' | 'READY' | 'CANCELLED' | 'ACCEPTED';
    sha256: string | null;
    metadata: IGgufMetadata | null;
    modelId: string | null;
    expiresAt: string;
    limits: Readonly<IGgufImportPolicy>;
}
export interface IGgufImportAccept {
    name: string;
    description?: string;
    capability: 'chat' | 'embedding';
    model?: string;
}
import type { IGgufImportPolicy } from './gguf-import-policy.cjs';
