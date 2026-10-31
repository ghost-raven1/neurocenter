import { ConflictException, BadRequestException } from '@nestjs/common';
import type { Pool } from 'pg';
import { normalizeEmail } from './access.model';
import { securityEvent } from './security-events';

/** Однократный bootstrap работает только с пустой базой и никогда не восстанавливает отозванную роль. */
export async function bootstrapAdministrator(
    pool: Pool,
    input: { email: unknown; displayName?: unknown },
): Promise<{ created: boolean }> {
    let email: string;
    try {
        email = normalizeEmail(input.email);
    } catch {
        throw new BadRequestException('Заполните почту первого главного администратора.');
    }
    const displayName = input.displayName === undefined ? 'Главный администратор' : input.displayName;
    if (
        typeof displayName !== 'string' ||
        !displayName.trim() ||
        displayName.length > 128 ||
        /[\x00-\x1f\x7f]/.test(displayName)
    ) {
        throw new BadRequestException('Укажите корректное имя администратора.');
    }
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(72465381)');
        const receipt = (await client.query("SELECT principal FROM platform_bootstrap WHERE key='first-admin'"))
            .rows[0];
        if (receipt) {
            const current = (
                await client.query('SELECT is_main_admin,enabled FROM platform_users WHERE email=$1', [email])
            ).rows[0];
            if (receipt.principal !== email || !current?.is_main_admin || !current.enabled) {
                throw new ConflictException(
                    'Bootstrap уже выполнен; отозванные права не восстанавливаются. Используйте действующего администратора.',
                );
            }
            await client.query('COMMIT');
            return { created: false };
        }
        if ((await client.query('SELECT 1 FROM platform_users LIMIT 1')).rowCount) {
            throw new ConflictException('Первый администратор создаётся только в пустом каталоге пользователей.');
        }
        await client.query(
            'INSERT INTO platform_users(email,display_name,is_main_admin,enabled) VALUES($1,$2,true,true)',
            [email, displayName.trim()],
        );
        await client.query("INSERT INTO platform_bootstrap(key,principal) VALUES('first-admin',$1)", [email]);
        await securityEvent(client, {
            actor: 'system:bootstrap',
            action: 'admin.bootstrap',
            resourceId: email,
            before: null,
            after: { displayName: displayName.trim(), isMainAdmin: true, enabled: true },
        });
        await client.query('COMMIT');
        return { created: true };
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}
