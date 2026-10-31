import {
    BadRequestException,
    ConflictException,
    ForbiddenException,
    NotFoundException,
    UnauthorizedException,
} from '@nestjs/common';
import type { PoolClient } from 'pg';
import { projectLevel } from '../access/access.model';
import type { Device, DeviceStore } from '../devices/device-store';
import { managedBinding } from '../devices/device-compatibility';

export interface DeviceLearningEnvelope {
    projectId: string;
    bindingId: string;
    instanceId: string;
    input?: unknown;
}
const plain = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value);

/** The device cannot select a server origin, actor, approval operation or arbitrary target folder. */
export function deviceLearningEnvelope(value: unknown, write = false): DeviceLearningEnvelope {
    if (
        !plain(value) ||
        Object.keys(value).some(
            (key) => !['projectId', 'bindingId', 'instanceId', ...(write ? ['input'] : [])].includes(key),
        ) ||
        typeof value.projectId !== 'string' ||
        !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value.projectId) ||
        typeof value.bindingId !== 'string' ||
        !/^[a-f0-9]{64}$/.test(value.bindingId) ||
        typeof value.instanceId !== 'string' ||
        !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value.instanceId) ||
        (write && !Object.prototype.hasOwnProperty.call(value, 'input'))
    )
        throw new BadRequestException('Передайте точную привязку проекта и допустимое сообщение обучения.');
    return value as unknown as DeviceLearningEnvelope;
}

/** A shared device row lock closes revocation and rebind races until the learning transaction commits. */
export async function authorizeDeviceLearning(
    db: Pick<PoolClient, 'query'>,
    original: Device,
    target: DeviceLearningEnvelope,
): Promise<void> {
    const { rows } = await db.query<Device>(
        `SELECT id,email,role,report FROM bridge_devices
        WHERE id=$1 AND email=$2 AND NOT revoked AND expires_at>clock_timestamp() FOR SHARE`,
        [original.id, original.email],
    );
    const device = rows[0];
    if (!device) throw new UnauthorizedException('Доступ MCP истёк или отозван.');
    if (device.role !== original.role) throw new ForbiddenException('Роль MCP изменилась. Перечитайте подключение.');
    const binding = Array.isArray(device.report.bindings)
        ? device.report.bindings.find((item) => item?.projectId === target.projectId)
        : undefined;
    if (
        managedBinding(device.report, target.projectId) !== target.bindingId ||
        binding?.instanceId !== target.instanceId
    ) {
        throw new ConflictException('Папка или экземпляр проекта изменились. Сообщение обучения не принято.');
    }
}

/** Fresh project rights are checked on every call, independent of the bridge's cached heartbeat. */
export async function currentLearningDevice(
    devices: DeviceStore,
    original: Device,
    target: DeviceLearningEnvelope,
    minimum: number,
): Promise<Device> {
    const device = await devices.owned({ email: original.email, activeRole: original.role }, original.id);
    const claims = await devices.access.claims(device.email);
    if (
        device.role !== original.role ||
        claims.email !== device.email ||
        projectLevel(claims, device.role, target.projectId) < minimum
    ) {
        throw new ForbiddenException(
            minimum === 1
                ? 'Нет доступа к обучению этого проекта.'
                : 'Сообщать опыт и гипотезы может разработчик проекта.',
        );
    }
    const exists = await devices.pool.query('SELECT id FROM projects WHERE id=$1', [target.projectId]);
    if (!exists.rows.length) throw new NotFoundException('Проект удалён.');
    await authorizeDeviceLearning(devices.pool, device, target);
    return device;
}
