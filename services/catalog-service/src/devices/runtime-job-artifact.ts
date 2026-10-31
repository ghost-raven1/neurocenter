import { ConflictException } from '@nestjs/common';
import type { Pool } from 'pg';
import type { IPackage } from '../catalog/bundle-package';
import { verifyPackage } from '../catalog/bundle-package';

/** Вызывается после свежей jobs.authorize; repair допускается только по сохранённому плану с явным согласием. */
export async function approvedRuntimeArtifact(
    pool: Pool,
    deviceId: string,
    jobId: string,
    lease: string,
    sha256: string,
): Promise<{ sha256: string; compressedBytes: number }> {
    const { rows } = await pool.query(
        `SELECT j.payload FROM bridge_jobs j WHERE j.id=$1 AND j.device_id=$2 AND j.lease=$3
        AND j.state='running' AND j.lease_until>now() AND (j.kind='install'
        OR (j.kind IN ('prepare-opencode-provider','open-opencode-provider') AND j.payload->'descriptor'->>'providerKind'='codex-bridge')
        OR (j.kind='apply-local-change' AND EXISTS (
            SELECT 1 FROM bridge_local_change_plans p WHERE p.id::text=j.payload->>'changePlanId'
                AND p.device_id=j.device_id AND p.project_id=j.project_id AND p.email=j.email
                AND p.binding_id=j.payload->>'bindingId' AND p.instance_id::text=j.payload->>'instanceId'
                AND p.digest=j.payload->>'expectedChangeDigest' AND p.revision::text=j.payload->>'changePlanRevision'
                AND p.purpose='repair' AND p.expires_at>now() AND p.applied_job_id IS NULL
                AND p.summary->'runtimeRepairRequired'='true'::jsonb)))`,
        [jobId, deviceId, lease],
    );
    const inference = rows.length
        ? undefined
        : (
              await pool.query(
                  `SELECT m.connector_package FROM device_model_calls c
        JOIN bridge_jobs j ON j.id=c.job_id JOIN model_device_connections m ON m.model_id=c.model_id AND m.revision=c.connection_revision
        WHERE j.id=$1 AND j.device_id=$2 AND j.lease=$3 AND j.kind='infer-device-codex'
        AND j.state='running' AND j.lease_until>clock_timestamp() AND c.cancelled_at IS NULL AND c.result IS NULL AND c.deadline_at>clock_timestamp()
        AND m.revoked_at IS NULL`,
                  [jobId, deviceId, lease],
              )
          ).rows[0];
    const payload = rows[0]?.payload ?? (inference ? { connectorPackage: inference.connector_package } : undefined);
    const connector = payload?.connectorPackage as IPackage | undefined;
    if (
        connector &&
        (!verifyPackage(connector) ||
            connector.plugin.kind !== 'plugin' ||
            (!inference &&
                (connector.plugin.id !== payload.descriptor?.connector?.assetId ||
                    connector.plugin.version !== payload.descriptor?.connector?.version ||
                    connector.manifest.sha256 !== payload.descriptor?.connector?.manifest)))
    )
        throw new ConflictException('Комплект коннектора не соответствует заданию.');
    const packages: IPackage[] = connector
        ? [connector]
        : (payload?.installSet?.packages ?? (payload?.package ? [payload.package] : []));
    const descriptors = packages.flatMap((pkg) =>
        Array.isArray(pkg.config?.extra?.runtimeArtifacts) ? pkg.config.extra.runtimeArtifacts : [],
    ) as Array<{ sha256: string; compressedBytes: number }>;
    const descriptor = descriptors.find((item) => item.sha256 === sha256);
    if (!descriptor)
        throw new ConflictException('Артефакт не входит в одобренный комплект восстановления или установки.');
    return descriptor;
}
