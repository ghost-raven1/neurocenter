import {ensureCatalogSchema} from '../database/catalog-schema';
import {createPool} from '../database/pool';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { IAccessClaims, IPlatformUser, IPlatformUserWrite, normalizeEmail, ROLES } from './access.model';
import {securityEvent} from './security-events';

/** Хранит пользователей по почте; проектные назначения остаются в project_members. */
@Injectable()
export class AccessDb implements OnModuleInit, OnModuleDestroy {
    private readonly pool = createPool({ connectionString: process.env.CATALOG_PG_URL || 'postgresql://rag:rag@localhost:5432/catalog', max: 3 },'access');
    private initialization?:Promise<void>;
    ready():Promise<void>{return this.initialization??=this.initialize();}
    async onModuleInit(): Promise<void> {await this.ready();}
    private async initialize(): Promise<void> {
        await ensureCatalogSchema(this.pool);
        // Начальный локальный администратор создаётся один раз и не получает права повторно после их отзыва.
        if (process.env.SSO_DISABLE === 'true') {
            const email = normalizeEmail(process.env.DEV_USER_EMAIL || 'dev@localhost');
            await this.pool.query(`INSERT INTO platform_users (email,display_name,is_main_admin)
                VALUES ($1,'Локальный администратор',true) ON CONFLICT DO NOTHING`, [email]);
        }
    }
    async onModuleDestroy(): Promise<void> { await this.pool.end(); }

    async projects():Promise<Array<{id:string;name:string}>> {
        return (await this.pool.query('SELECT id,name FROM projects ORDER BY id')).rows as Array<{id:string;name:string}>;
    }

    async list(): Promise<IPlatformUser[]> {
        const { rows } = await this.pool.query(`SELECT email, display_name AS "displayName", is_main_admin AS "isMainAdmin", enabled, created_at AS "createdAt" FROM platform_users ORDER BY email`);
        return rows as IPlatformUser[];
    }

    save(input:IPlatformUserWrite,actor='system:administration'):Promise<IPlatformUser> {
        return this.writeUser(input,actor,'save');
    }

    /** Проектное назначение создаёт только отсутствующий аккаунт, сохраняя существующий профиль и права. */
    ensureProjectUser(input:Pick<IPlatformUserWrite,'email'|'displayName'>,actor:string):Promise<IPlatformUser> {
        return this.writeUser({email:input.email,displayName:input.displayName},actor,'create-if-missing');
    }

    private async writeUser(input:IPlatformUserWrite,actor:string,mode:'save'|'create-if-missing'):Promise<IPlatformUser> {
        if (!input || typeof input !== 'object' || Array.isArray(input)) { throw new BadRequestException('Передайте данные пользователя.'); }
        if (input.displayName !== undefined && (typeof input.displayName !== 'string' || input.displayName.trim().length > 128 || /[\x00-\x1f\x7f]/.test(input.displayName))) { throw new BadRequestException('Имя пользователя: строка до 128 символов без управляющих знаков.'); }
        let email: string;
        try { email = normalizeEmail(input.email); } catch (error) { throw new BadRequestException((error as Error).message); }
        if (input.isMainAdmin !== undefined && typeof input.isMainAdmin !== 'boolean') { throw new BadRequestException('isMainAdmin должен быть булевым значением.'); }
        if (input.enabled !== undefined && typeof input.enabled !== 'boolean') { throw new BadRequestException('enabled должен быть булевым значением.'); }
        if (input.createOnly !== undefined && typeof input.createOnly !== 'boolean') { throw new BadRequestException('createOnly должен быть булевым значением.'); }
        if (input.expected !== undefined && (!input.expected || typeof input.expected !== 'object' || typeof input.expected.displayName !== 'string' || typeof input.expected.isMainAdmin !== 'boolean' || typeof input.expected.enabled !== 'boolean')) { throw new BadRequestException('Некорректное исходное состояние пользователя.'); }
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            // Сериализация защищает последнего администратора от двух одновременных отзывов.
            await client.query("SELECT pg_advisory_xact_lock(72465381)");
            const current = await client.query('SELECT * FROM platform_users WHERE email=$1 FOR UPDATE', [email]);
            if(mode==='create-if-missing'&&current.rows[0]) {
                const user=current.rows[0];
                await client.query('COMMIT');
                return {email:user.email,displayName:user.display_name,isMainAdmin:user.is_main_admin,enabled:user.enabled,createdAt:user.created_at};
            }
            if (input.createOnly && current.rows[0]) { throw new ConflictException('Пользователь с этой почтой уже добавлен. Откройте его настройки.'); }
            if (input.expected && (!current.rows[0] || current.rows[0].display_name!==input.expected.displayName || current.rows[0].is_main_admin!==input.expected.isMainAdmin || current.rows[0].enabled!==input.expected.enabled)) {
                throw new ConflictException('Пользователя уже изменили. Обновите список и откройте актуальные настройки; введённый текст остался в форме.');
            }
            if (current.rows[0]?.is_main_admin && current.rows[0]?.enabled && (input.isMainAdmin === false || input.enabled === false)) {
                const others = await client.query('SELECT 1 FROM platform_users WHERE is_main_admin AND enabled AND email<>$1 LIMIT 1',[email]);
                if (!others.rowCount) { throw new ConflictException('Нельзя отключить последнего главного администратора.'); }
            }
            const { rows } = await client.query(`INSERT INTO platform_users (email,display_name,is_main_admin,enabled)
                VALUES ($1,$2,$3,$4) ON CONFLICT (email) DO UPDATE SET
                display_name=COALESCE($5,platform_users.display_name), is_main_admin=COALESCE($6,platform_users.is_main_admin), enabled=COALESCE($7,platform_users.enabled)
                RETURNING email, display_name AS "displayName", is_main_admin AS "isMainAdmin", enabled, created_at AS "createdAt"`,
                [email, typeof input.displayName === 'string' ? input.displayName.trim() : '', input.isMainAdmin === true, input.enabled !== false,
                    typeof input.displayName === 'string' ? input.displayName.trim() : null, input.isMainAdmin ?? null, input.enabled ?? null]);
            const previous=current.rows[0];
            const saved=rows[0] as IPlatformUser;
            if (!previous || previous.display_name!==saved.displayName || previous.is_main_admin!==saved.isMainAdmin || previous.enabled!==saved.enabled) {
                await securityEvent(client,{actor,action:previous?'user.update':'user.create',resourceId:email,
                    before:previous?{displayName:previous.display_name,isMainAdmin:previous.is_main_admin,enabled:previous.enabled}:null,after:saved});
            }
            await client.query('COMMIT'); return rows[0] as IPlatformUser;
        } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    }

    /** Повторно читает назначения при каждом запросе: отзыв доступа действует без нового входа. */
    async claims(value: unknown): Promise<IAccessClaims> {
        let email: string;
        try { email = normalizeEmail(value); } catch { throw new ForbiddenException('У пользователя не подтверждена почта.'); }
        const { rows } = await this.pool.query('SELECT is_main_admin,enabled FROM platform_users WHERE email=$1',[email]);
        const account = rows[0];
        if (!account || !account.enabled) { throw new ForbiddenException('Учётная запись не добавлена или отключена администратором.'); }
        const grants = await this.pool.query(`SELECT p.id AS "projectId",p.name AS "projectName",pm.role
            FROM project_members pm JOIN projects p ON p.id=pm.project_id WHERE lower(pm.principal_name)=$1`,[email]);
        const projects = grants.rows as IAccessClaims['projects'];
        const userRoles = ROLES.filter(role => role === 'Главный админ' ? account.is_main_admin : projects.some(item => item.role === role));
        const assets = await this.pool.query(`SELECT DISTINCT asset_id,asset_kind FROM project_assets WHERE project_id=ANY($1::text[])`,[projects.map(item=>item.projectId)]);
        return {email,userRoles:[...userRoles],projects,
            pluginIds:assets.rows.filter(item=>item.asset_kind!=='skill').map(item=>String(item.asset_id)),
            skillPaths:assets.rows.filter(item=>item.asset_kind==='skill').map(item=>String(item.asset_id))};
    }
}
