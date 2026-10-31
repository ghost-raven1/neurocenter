import { HttpException } from '@nestjs/common';
import fs from 'node:fs/promises';
import { CapacityError, getCapacityStatus, reserveBytes } from '../../../../shared/capacity.cjs';
import type { GgufImportPolicy } from '../../../../shared/gguf-import-policy.cjs';

/** Existing bytes need a fresh physical floor, not a second reservation for the same file. */
export async function assertGgufCapacity(root: string, limits: GgufImportPolicy): Promise<void> {
    try {
        const [disk, info] = await Promise.all([fs.statfs(root, { bigint: true }), fs.stat(root)]),
            snapshot = getCapacityStatus();
        if (
            process.env.CAPACITY_REQUIRED === 'true' &&
            (!snapshot.available || snapshot.resources?.['runtime-artifacts'].filesystem !== String(info.dev))
        )
            throw new CapacityError('CAPACITY_UNAVAILABLE', 'runtime-artifacts');
        if (disk.bavail * disk.bsize < BigInt(reserveBytes) + BigInt(limits.diskReserveBytes))
            throw new CapacityError('CAPACITY_LOW', 'runtime-artifacts');
    } catch (error) {
        const failure =
            error instanceof CapacityError ? error : new CapacityError('CAPACITY_UNAVAILABLE', 'runtime-artifacts');
        throw new HttpException(failure.message, failure.statusCode);
    }
}
