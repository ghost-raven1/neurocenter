import { ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';
import { assertInternal } from '../access/access.controller';
import type { AccessDb } from '../access/access-db';
import type { IAccessActor, IAccessClaims } from '../access/access.model';

export interface IModelActor extends IAccessActor { claims: IAccessClaims }

/** Права перечитываются для каждого действия; тело запроса не определяет исполнителя. */
export async function readModelActor(req: Request, access: AccessDb): Promise<IModelActor> {
    assertInternal(req.headers['x-neurocenter-internal']);
    let actor: Partial<IAccessActor> | null;
    try { actor = JSON.parse(decodeURIComponent(String(req.headers['x-bridge-actor'] || 'null'))) as Partial<IAccessActor> | null; }
    catch { throw new ForbiddenException('Нужна действующая роль пользователя.'); }
    const claims = await access.claims(actor?.email);
    if (typeof actor?.activeRole !== 'string' || !claims.userRoles.includes(actor.activeRole)) { throw new ForbiddenException('Активная роль больше не назначена пользователю.'); }
    return { email: claims.email, activeRole: actor.activeRole, claims };
}
