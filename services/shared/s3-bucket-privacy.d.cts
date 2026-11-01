import type { Readable } from 'node:stream';
export interface IS3PrivacyClient {
    makeRequestAsync(
        options: { method: string; bucketName: string; query: string },
        payload: string,
        expectedCodes: number[],
    ): Promise<Readable & { statusCode?: number }>;
}
/** Signed bounded policy/ACL checks. Named principals are allowed; public/groups and unknown forms fail closed. */
export function assertPrivateS3Bucket(client: IS3PrivacyClient, bucket: string): Promise<void>;
