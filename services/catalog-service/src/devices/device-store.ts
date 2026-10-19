import {createPool} from '../database/pool';
import {
    BadRequestException,
    ConflictException,
    ForbiddenException,
    Injectable,
    OnModuleDestroy,
    OnModuleInit,
    UnauthorizedException,
} from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { AccessDb } from '../access/access-db';
import type { IAccessActor } from '../access/access.model';
import {recordDeviceOperation,notifyDeviceOperations} from './device-operations';
import { workspaceReport } from './device-report';
import { migrateCatalog } from '../database/migrations';
import { INSTALLATION_MIGRATIONS } from './installation-migrations';

export const digest = (value: string): string =>
    createHash('sha256').update(value).digest('hex');
export interface Device {
    id: string;
    email: string;
    role: string;
    name: string;
    fingerprint: string;
    last_seen: string | null;
    report: Record<string, unknown>;
    revoked: boolean;
}
interface IRevokedJob {id:string;kind:string;project_id:string|null;email:string;state:'cancelled'|'failed'|'reconciling';percent:number|null;message:string;}

/** Личная привязка MCP: в базе хранятся хэши секретов, в интерфейс они не возвращаются. */
@Injectable()
export class DeviceStore implements OnModuleInit, OnModuleDestroy {
    readonly pool = createPool({
        connectionString:
            process.env.CATALOG_PG_URL ||
            'postgresql://rag:rag@localhost:5432/catalog',
        max: 4,
    },'devices');
    constructor(readonly access: AccessDb) {}
    async onModuleInit(): Promise<void> {
        await this.pool.query(`CREATE TABLE IF NOT EXISTS bridge_devices (
            id text PRIMARY KEY,email text NOT NULL,role text NOT NULL,name text NOT NULL,fingerprint text NOT NULL,
            token_hash text UNIQUE NOT NULL,expires_at timestamptz NOT NULL DEFAULT now()+interval '30 days',
            revoked boolean NOT NULL DEFAULT false,last_seen timestamptz,report jsonb NOT NULL DEFAULT '{}');
            CREATE TABLE IF NOT EXISTS bridge_pairs (
            code_hash text PRIMARY KEY,user_code text UNIQUE NOT NULL,name text NOT NULL,fingerprint text NOT NULL,
            expires_at timestamptz NOT NULL DEFAULT now()+interval '10 minutes',email text,role text,issued boolean NOT NULL DEFAULT false);
            CREATE TABLE IF NOT EXISTS bridge_jobs (
            id text PRIMARY KEY,device_id text NOT NULL REFERENCES bridge_devices(id),email text NOT NULL,
            role text NOT NULL,project_id text,kind text NOT NULL,payload jsonb NOT NULL,request_key text NOT NULL,
            request_hash text NOT NULL,state text NOT NULL DEFAULT 'queued',percent integer,message text NOT NULL DEFAULT 'Ожидает моста',
            lease text,lease_until timestamptz,result jsonb,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
            UNIQUE(email,request_key));
            CREATE INDEX IF NOT EXISTS bridge_jobs_device_queue ON bridge_jobs(device_id,state,created_at);
            ALTER TABLE bridge_jobs ADD COLUMN IF NOT EXISTS started_at timestamptz;
            ALTER TABLE bridge_pairs ADD COLUMN IF NOT EXISTS proposed_token_hash text;
            ALTER TABLE bridge_pairs ADD COLUMN IF NOT EXISTS resume_device_id text;
            ALTER TABLE bridge_pairs ADD COLUMN IF NOT EXISTS resume_token_hash text;
            ALTER TABLE bridge_pairs ADD COLUMN IF NOT EXISTS issued_device_id text;
            ALTER TABLE bridge_devices ADD COLUMN IF NOT EXISTS paused_until timestamptz;`);
        await migrateCatalog(this.pool, INSTALLATION_MIGRATIONS);
    }
    async onModuleDestroy(): Promise<void> {
        await this.pool.end();
    }
    async start(input: { name?: unknown; fingerprint?: unknown; credentialHash?: unknown }, previousToken?: string) {
        if (
            !input ||
            typeof input.name !== 'string' ||
            !input.name.trim() ||
            input.name.length > 100 ||
            typeof input.fingerprint !== 'string' ||
            !/^[a-f0-9]{32,64}$/.test(input.fingerprint)
            || (input.credentialHash !== undefined && (typeof input.credentialHash !== 'string' || !/^[a-f0-9]{64}$/.test(input.credentialHash)))
        ) {
            throw new BadRequestException(
                'Некорректное имя или отпечаток MCP.',
            );
        }
        const code = randomBytes(32).toString('hex');
        const userCode = randomBytes(8).toString('hex').toUpperCase();
        // Просроченный ключ доказывает прежнюю привязку, но её продление всё равно требует входа владельца.
        const resume = input.credentialHash && /^[a-f0-9]{64}$/.test(previousToken || '')
            ? await this.pool.query('SELECT id FROM bridge_devices WHERE token_hash=$1 AND NOT revoked', [digest(previousToken!)])
            : { rows: [] };
        await this.pool.query(
            'DELETE FROM bridge_pairs WHERE expires_at<now()',
        );
        await this.pool.query(
            'INSERT INTO bridge_pairs(code_hash,user_code,name,fingerprint,proposed_token_hash,resume_device_id,resume_token_hash) VALUES($1,$2,$3,$4,$5,$6,$7)',
            [digest(code), userCode, input.name.trim(), input.fingerprint, input.credentialHash || null, resume.rows[0]?.id || null, resume.rows[0] ? digest(previousToken!) : null],
        );
        return { deviceCode: code, userCode, expiresIn: 600 };
    }
    async pairInfo(userCode: string, actor: IAccessActor) {
        const { rows } = await this.pool.query(
            'SELECT user_code AS "userCode",name,fingerprint,expires_at AS "expiresAt",email IS NOT NULL AS approved FROM bridge_pairs WHERE user_code=$1 AND expires_at>now() AND (email IS NULL OR email=$2)',
            [userCode,actor.email],
        );
        if (!rows[0]) {
            throw new ConflictException(
                'Код подключения истёк или уже использован. Начните подключение в MCP заново.',
            );
        }
        return rows[0];
    }
    async approve(actor: IAccessActor, userCode: string) {
        const claims = await this.access.claims(actor.email);
        if (!claims.userRoles.includes(actor.activeRole)) {
            throw new ForbiddenException('Выбранная роль больше не назначена.');
        }
        const { rowCount } = await this.pool.query(
            `UPDATE bridge_pairs p SET email=$2,role=$3 WHERE user_code=$1 AND expires_at>now() AND email IS NULL AND NOT issued
            AND (resume_device_id IS NULL OR EXISTS(SELECT 1 FROM bridge_devices d WHERE d.id=p.resume_device_id AND d.email=$2 AND d.token_hash=p.resume_token_hash AND NOT d.revoked))`,
            [userCode, actor.email, actor.activeRole],
        );
        if (!rowCount) {
            throw new ConflictException(
                'Код истёк или подключение уже подтверждено.',
            );
        }
        return { ok: true };
    }
    async poll(code: string) {
        if (typeof code !== 'string' || !/^\w{64}$/.test(code)) {
            throw new UnauthorizedException();
        }
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const { rows } = await client.query(
                'SELECT * FROM bridge_pairs WHERE code_hash=$1 AND expires_at>now() FOR UPDATE',
                [digest(code)],
            );
            const pair = rows[0];
            if (!pair) {
                throw new ConflictException(
                    'Подключение истекло или уже завершено.',
                );
            }
            if (pair.issued) {
                if (!pair.proposed_token_hash || !pair.issued_device_id) { throw new ConflictException('Подключение уже завершено.'); }
                const issued = await client.query('SELECT id,email,role FROM bridge_devices WHERE id=$1 AND token_hash=$2 AND NOT revoked AND expires_at>now()', [pair.issued_device_id, pair.proposed_token_hash]);
                if (!issued.rows[0]) { throw new ConflictException('Это подключение уже заменено или отозвано.'); }
                if (!(await this.access.claims(issued.rows[0].email)).userRoles.includes(issued.rows[0].role)) { throw new ForbiddenException('Право подключения отозвано.'); }
                await client.query('COMMIT');
                return { state: 'connected', deviceId: issued.rows[0].id, email: issued.rows[0].email };
            }
            if (!pair.email) {
                await client.query('COMMIT');
                return { state: 'pending' };
            }
            const claims = await this.access.claims(pair.email);
            if (!claims.userRoles.includes(pair.role)) {
                throw new ForbiddenException('Право подключения отозвано.');
            }
            const token = randomBytes(32).toString('hex');
            const id = pair.resume_device_id || randomUUID();
            const tokenHash = pair.proposed_token_hash || digest(token);
            if (pair.resume_device_id) {
                const renewed = await client.query(`UPDATE bridge_devices SET token_hash=$2,role=$3,name=$4,fingerprint=$5,expires_at=now()+interval '30 days',last_seen=NULL
                    WHERE id=$1 AND email=$6 AND token_hash=$7 AND NOT revoked RETURNING id`, [id, tokenHash, pair.role, pair.name, pair.fingerprint, pair.email, pair.resume_token_hash]);
                if (!renewed.rows.length) { throw new ConflictException('Прежнее подключение уже отозвано. Начните подключение заново.'); }
            } else { await client.query(
                'INSERT INTO bridge_devices(id,email,role,name,fingerprint,token_hash) VALUES($1,$2,$3,$4,$5,$6)',
                [
                    id,
                    pair.email,
                    pair.role,
                    pair.name,
                    pair.fingerprint,
                    tokenHash,
                ],
            ); }
            await client.query(
                'UPDATE bridge_pairs SET issued=true,issued_device_id=$2 WHERE code_hash=$1',
                [digest(code), id],
            );
            await client.query('COMMIT');
            return {
                state: 'connected',
                ...(pair.proposed_token_hash ? {} : { token }),
                deviceId: id,
                email: pair.email,
            };
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }
    async identity(token: unknown): Promise<Device> {
        if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) {
            throw new UnauthorizedException('MCP не подключён.');
        }
        const { rows } = await this.pool.query(
            'SELECT id,email,role,name,fingerprint,last_seen,report,revoked FROM bridge_devices WHERE token_hash=$1 AND NOT revoked AND expires_at>now()',
            [digest(token)],
        );
        const device = rows[0] as Device | undefined;
        if (!device) {
            throw new UnauthorizedException('Доступ MCP истёк или отозван.');
        }
        const claims = await this.access.claims(device.email);
        if (!claims.userRoles.includes(device.role)) {
            throw new ForbiddenException(
                'Роль MCP отозвана. Подключите MCP с доступной ролью.',
            );
        }
        return device;
    }
    async owned(actor: IAccessActor, id: string, allowExpired = false): Promise<Device> {
        const { rows } = await this.pool.query(
            'SELECT id,email,role,name,fingerprint,last_seen,report,revoked FROM bridge_devices WHERE id=$1 AND email=$2 AND NOT revoked AND ($3::boolean OR expires_at>now())',
            [id, actor.email, allowExpired],
        );
        if (!rows[0]) {
            throw new ForbiddenException(
                'Этот MCP не подключён к вашему профилю.',
            );
        }
        return rows[0] as Device;
    }
    async list(actor: IAccessActor) {
        return (
            await this.pool.query(
                `SELECT id,name,role,fingerprint,last_seen AS "lastSeen",report,
            expires_at AS "expiresAt",expires_at<=now() AS "requiresReconnect",
            expires_at>now() AND last_seen>now()-interval '40 seconds' AS online FROM bridge_devices WHERE email=$1 AND NOT revoked ORDER BY last_seen DESC NULLS LAST`,
                [actor.email],
            )
        ).rows.map(row => {
            try { return { ...row, report: workspaceReport(row.report) }; }
            catch { return { ...row, report: { rootError: 'Отчёт компьютера повреждён. Обновите локальный MCP.' } }; }
        });
    }
    async revoke(actor: IAccessActor, id: string) {
        await this.owned(actor, id, true);
        const client=await this.pool.connect();
        try{
            await client.query('BEGIN');
            await client.query('UPDATE bridge_devices SET revoked=true WHERE id=$1',[id]);
            const {rows}=await client.query<IRevokedJob>(`UPDATE bridge_jobs SET state=CASE WHEN state='queued' THEN 'cancelled' WHEN kind IN ('install','uninstall','apply-local-change','apply-adopt-installation','apply-local-restore','bind-project') THEN 'reconciling' ELSE 'failed' END,
                message=CASE WHEN state='queued' THEN 'Подключение моста отключено. Задание отменено.' ELSE 'Мост отключён во время выполнения. Проверьте локальные файлы перед повтором.' END,
                updated_at=now() WHERE device_id=$1 AND state IN ('queued','running','reconciling') RETURNING *`,[id]);
            for(const job of rows){await recordDeviceOperation(client,job,job.state==='reconciling'?'RUNNING':String(job.state).toUpperCase(),job.percent??0,job.message);}
            await client.query('COMMIT');
        }catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error;}finally{client.release();}
        await notifyDeviceOperations();
        return { ok: true };
    }
    async heartbeat(device: Device, report: unknown) {
        const checked = workspaceReport(report);
        await this.pool.query(
            'UPDATE bridge_devices SET last_seen=now(),report=$2 WHERE id=$1',
            [device.id, checked],
        );
        return { ok: true };
    }
    /** Пауза сериализована с claim: обновление клиента не обрывает уже начатую файловую операцию. */
    async pause(device: Device) {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query("UPDATE bridge_devices SET paused_until=now()+interval '1 minute' WHERE id=$1", [device.id]);
            const active = await client.query<{ count: string }>("SELECT count(*) FROM bridge_jobs WHERE device_id=$1 AND state IN ('running','reconciling')", [device.id]);
            await client.query('COMMIT');
            return { activeJobs: Number(active.rows[0]?.count || 0) };
        } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
        finally { client.release(); }
    }
    async resume(device: Device) {
        await this.pool.query('UPDATE bridge_devices SET paused_until=NULL WHERE id=$1', [device.id]);
        return { ok: true };
    }
}
