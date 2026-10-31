import path from 'node:path';
import { z } from 'zod';
import { readBoundedUtf8 } from '../bridge/read-bounded.js';
import { safeTarget, workspaceInstanceAt } from '../bridge/workspace.js';
import { hash } from '../bridge/state.js';

export const resolveProjectKeyInputSchema = z
    .object({
        project: z.string().min(1).optional(),
        createIfMissing: z
            .boolean()
            .optional()
            .describe('Устаревший параметр. Проект связывается с папкой явно на странице проектов.'),
    })
    .strict();
export type TResolveProjectKeyInput = z.infer<typeof resolveProjectKeyInputSchema>;

const bindingSchema = z
    .object({
        version: z.union([z.literal(1), z.literal(2)]),
        server: z
            .string()
            .url()
            .refine((value) => {
                const url = new URL(value);
                return ['http:', 'https:'].includes(url.protocol) && url.origin === value;
            }, 'Укажите origin Нейроцентра без пароля и пути'),
        projectId: z
            .string()
            .min(1)
            .max(128)
            .refine((value) => !/[\x00-\x20/\\]/.test(value)),
        instanceId: z.string().uuid().optional(),
    })
    .refine((value) => value.version === 1 || value.instanceId !== undefined);

/** Читает явную привязку: одинаковые названия папок у разных людей не определяют серверный проект. */
export async function resolveProjectKey(input: TResolveProjectKeyInput, cwd: string): Promise<string> {
    const root = path.resolve(cwd, input.project ?? '.');
    let raw: string;
    try {
        raw = await readBoundedUtf8(await safeTarget(root, '.opencode/neurocenter.json'), 64 * 1024);
    } catch (error) {
        const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
        return JSON.stringify({
            ok: false,
            error: missing ? 'project-binding-required' : 'project-binding-unreadable',
            folderName: path.basename(root),
            message: missing
                ? 'Свяжите локальную папку с серверным проектом на странице «Проекты». Название папки не используется для автоматического выбора.'
                : 'Не удалось прочитать .opencode/neurocenter.json. Проверьте доступ к папке.',
            hint: 'Нейроцентр → Проекты → Связать папку. Автоматическое создание по имени папки отключено.',
        });
    }
    let binding: z.infer<typeof bindingSchema>;
    try {
        binding = bindingSchema.parse(JSON.parse(raw));
    } catch {
        return JSON.stringify({
            ok: false,
            error: 'project-binding-invalid',
            message: 'Некорректная привязка .opencode/neurocenter.json. Данные проекта не изменены.',
        });
    }
    if (binding.version === 1) {
        return JSON.stringify({
            ok: true,
            projectKey: binding.projectId,
            matchedBy: 'binding',
            server: binding.server,
            folderName: path.basename(root),
            accessVerified: false,
            identityVerified: false,
            migrationRequired: true,
            message:
                'Найдена старая привязка. Подтвердите экземпляр и проверьте файлы на странице «Проекты» перед синхронизацией.',
        });
    }
    try {
        const instance = await workspaceInstanceAt(root, binding.projectId);
        return JSON.stringify({
            ok: true,
            projectKey: binding.projectId,
            matchedBy: 'binding',
            server: binding.server,
            folderName: path.basename(root),
            accessVerified: false,
            identityVerified: true,
            instanceId: instance.instanceId,
            bindingId: hash(
                JSON.stringify([instance.server, instance.projectId, instance.instanceId, instance.bindingNonce]),
            ),
            message: 'Локальный экземпляр проверен. Доступ к данным проверяется сервером.',
        });
    } catch {
        return JSON.stringify({
            ok: false,
            error: 'project-instance-unverified',
            migrationRequired: true,
            message:
                'Экземпляр папки не подтверждён на этом компьютере. Выберите новую копию или проверенный перенос на странице «Проекты».',
        });
    }
}
