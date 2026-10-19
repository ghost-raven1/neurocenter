import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { IInstallPlan } from '../src/features/McpBridge/api';
import type { IInstallPlanPackage } from '../src/features/McpBridge/installPlanTypes';
import { approveInstallation, prepareInstallation, refreshInstallationPlan, revokeInstallationPlan, type IPlanExecution } from '../src/modules/Store/installPlans/installPlanFlow';
import { InstallPlanActions, InstallPlanDetails } from '../src/modules/Store/installPlans/InstallPlanModal';

const plan: IInstallPlan = {
    id: 'plan-1', projectId: 'project-1', assetId: 'common/helper', assetKind: 'skill', version: 2,
    manifest: 'a'.repeat(64), status: 'pending', revision: 0, approvedBy: null,
    files: [{ path: 'SKILL.md', size: 12, sha256: 'b'.repeat(64), content: '# Инструкция' }],
    config: null, requirements: { mcp: [], plugins: [] },
};
function execution(next: IInstallPlan = plan) {
    return {
        api: { preparePlan: vi.fn(async () => next), approvePlan: vi.fn(async () => ({ ...plan, status: 'approved' as const, revision: 1 })) },
        current: vi.fn(() => true), enqueue: vi.fn(async () => undefined),
    } satisfies IPlanExecution;
}
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { resolve, promise };
}

describe('Одобрение точного плана установки', () => {
    it('Устанавливает одобренный манифест без дополнительного подтверждения', async () => {
        const approved = { ...plan, status: 'approved' as const, revision: 1 };
        const flow = execution(approved);
        expect(await prepareInstallation(plan, flow)).toBeUndefined();
        expect(flow.enqueue).toHaveBeenCalledExactlyOnceWith(approved);
        expect(flow.api.approvePlan).not.toHaveBeenCalled();
    });

    it.each(['pending', 'revoked'] as const)('Открывает просмотр без отправки задания: %s', async status => {
        const candidate = { ...plan, status };
        const flow = execution(candidate);
        expect(await prepareInstallation(plan, flow)).toEqual(candidate);
        expect(flow.enqueue).not.toHaveBeenCalled();
    });

    it('Позволяет отдельно открыть уже одобренную версию для отзыва', async () => {
        const approved = { ...plan, status: 'approved' as const, revision: 1 };
        const flow = execution(approved);
        expect(await prepareInstallation(plan, flow, true)).toEqual(approved);
        expect(flow.enqueue).not.toHaveBeenCalled();
    });

    it('Передаёт в установку тот же план после одобрения и новый номер состояния', async () => {
        const flow = execution();
        await approveInstallation(plan, flow);
        expect(flow.api.approvePlan).toHaveBeenCalledExactlyOnceWith(plan);
        expect(flow.enqueue).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: plan.id, manifest: plan.manifest, revision: 1 }));
    });

    it.each([
        { projectId: 'foreign-project' }, { assetId: 'common/other' }, { assetKind: 'plugin' },
        { version: 3 }, { manifest: 'bad' }, { revision: -1 }, { revision: Number.NaN }, { status: 'unknown' },
    ])('Отказывает при подмене подготовленного плана: %j', async change => {
        const flow = execution({ ...plan, ...change } as IInstallPlan);
        await expect(prepareInstallation(plan, flow)).rejects.toThrow('План установки изменился');
        expect(flow.enqueue).not.toHaveBeenCalled();
    });

    it.each([
        { id: 'other-plan' }, { manifest: 'c'.repeat(64) }, { revision: 0 }, { status: 'pending' },
    ])('Не устанавливает подменённый результат одобрения: %j', async change => {
        const flow = execution();
        flow.api.approvePlan.mockResolvedValue({ ...plan, status: 'approved', revision: 1, ...change } as never);
        await expect(approveInstallation(plan, flow)).rejects.toThrow();
        expect(flow.enqueue).not.toHaveBeenCalled();
    });

    it('Не создаёт задание после отмены во время подготовки', async () => {
        const pending = deferred<IInstallPlan>();
        const flow = execution();
        flow.api.preparePlan.mockReturnValue(pending.promise);
        const result = prepareInstallation(plan, flow);
        flow.current.mockReturnValue(false);
        pending.resolve({ ...plan, status: 'approved', revision: 1 });
        expect(await result).toBeUndefined();
        expect(flow.enqueue).not.toHaveBeenCalled();
    });

    it('Не создаёт задание после смены профиля или проекта во время одобрения', async () => {
        const pending = deferred<IInstallPlan>();
        const flow = execution();
        flow.api.approvePlan.mockReturnValue(pending.promise as never);
        const result = approveInstallation(plan, flow);
        flow.current.mockReturnValue(false);
        pending.resolve({ ...plan, status: 'approved', revision: 1 });
        await result;
        expect(flow.enqueue).not.toHaveBeenCalled();
    });

    it('Сохраняет отказ подготовки зависимостей и не сообщает об установке', async () => {
        const flow = execution();
        flow.api.preparePlan.mockRejectedValue(new Error('Сначала подготовьте граф зависимостей'));
        await expect(prepareInstallation(plan, flow)).rejects.toThrow('граф зависимостей');
        expect(flow.enqueue).not.toHaveBeenCalled();
    });

    it('Конфликт одновременного одобрения не запускает установку', async () => {
        const flow = execution();
        flow.api.approvePlan.mockRejectedValue(new Error('Разрешение уже изменили'));
        await expect(approveInstallation(plan, flow)).rejects.toThrow('уже изменили');
        expect(flow.enqueue).not.toHaveBeenCalled();
    });

    it('Подтверждает отзыв той же версии с увеличенной ревизией', async () => {
        const approved = { ...plan, status: 'approved' as const, revision: 1 };
        const revoke = vi.fn(async () => ({ ...approved, status: 'revoked' as const, revision: 2 }));
        expect(await revokeInstallationPlan(approved, revoke, () => true)).toMatchObject({ status: 'revoked', revision: 2 });
        expect(revoke).toHaveBeenCalledExactlyOnceWith(approved);
    });

    it('Игнорирует завершившийся отзыв после закрытия окна', async () => {
        const revoke = vi.fn(async () => ({ ...plan, status: 'revoked' as const, revision: 2 }));
        expect(await revokeInstallationPlan(plan, revoke, () => false)).toBeUndefined();
    });

    it('Не принимает отзыв другого манифеста', async () => {
        const revoke = vi.fn(async () => ({ ...plan, manifest: 'c'.repeat(64), status: 'revoked' as const, revision: 2 }));
        await expect(revokeInstallationPlan(plan, revoke, () => true)).rejects.toThrow('Состояние разрешения');
    });

    it('Обновление статуса читает тот же план и не создаёт задание после чужого одобрения', async () => {
        const read = vi.fn(async () => ({ ...plan, status: 'approved' as const, revision: 1 }));
        const next = await refreshInstallationPlan(plan, read, () => true);
        expect(next).toMatchObject({ status: 'approved', revision: 1 });
        expect(read).toHaveBeenCalledExactlyOnceWith(plan.id);
        const flow = execution(next!);
        expect(flow.enqueue).not.toHaveBeenCalled();
        expect(flow.api.preparePlan).not.toHaveBeenCalled();
    });

    it('После чужого одобрения отдельное нажатие запускает обычную подготовку и установку', async () => {
        const next = { ...plan, status: 'approved' as const, revision: 1 };
        const flow = execution(next);
        await prepareInstallation(plan, flow);
        expect(flow.api.preparePlan).toHaveBeenCalledExactlyOnceWith(plan);
        expect(flow.enqueue).toHaveBeenCalledExactlyOnceWith(next);
    });

    it('Поздний GET не перезаписывает более новую ревизию после одобрения', async () => {
        const approved = { ...plan, status: 'approved' as const, revision: 3 };
        expect(await refreshInstallationPlan(approved, async () => ({ ...plan, status: 'revoked', revision: 2 }), () => true)).toBeUndefined();
    });

    it('GET, начатый перед POST одобрения, игнорируется после смены номера операции', async () => {
        const pending = deferred<IInstallPlan>();
        let operation = 1;
        const result = refreshInstallationPlan(plan, () => pending.promise, () => operation === 1);
        operation = 2;
        pending.resolve(plan);
        expect(await result).toBeUndefined();
    });

    it('Смена проекта или закрытие окна отменяет запоздавшее обновление', async () => {
        const pending = deferred<IInstallPlan>();
        let opened = true;
        const result = refreshInstallationPlan(plan, () => pending.promise, () => opened);
        opened = false;
        pending.resolve({ ...plan, status: 'approved', revision: 1 });
        expect(await result).toBeUndefined();
    });

    it('Результат GET другого плана нельзя показать в открытой модалке', async () => {
        await expect(refreshInstallationPlan(plan, async () => ({ ...plan, id: 'other-plan' }), () => true)).rejects.toThrow('другому плану');
    });

    it('Одна ревизия не принимает противоречивый статус', async () => {
        expect(await refreshInstallationPlan(plan, async () => ({ ...plan, status: 'approved' }), () => true)).toBeUndefined();
    });
});

describe('Просмотр полного комплекта перед одобрением', () => {
    const dependency: IInstallPlanPackage = {
        kind:'mcp', id:'ai-plug-search', name:'Поиск документов', version:3, manifest:'c'.repeat(64),
        files:[{path:'dist/search.mjs',size:10,sha256:'d'.repeat(64),content:'export const search = true;'}],
        config:{transport:'stdio',entrypoint:'dist/search.mjs',command:'node'}, requirements:{dependencies:[]},
    };
    const root: IInstallPlanPackage = {
        kind:'skill',id:plan.assetId,name:'Основной помощник',version:plan.version,manifest:'e'.repeat(64),files:plan.files,
        config:{note:'ROOT_CONFIG_ONLY_ONCE'}, requirements:{dependencies:[{kind:'mcp',id:dependency.id,version:dependency.version,manifest:dependency.manifest}]},
    };
    const multi: IInstallPlan = {...plan,manifest:'f'.repeat(64),packages:[dependency,root]};

    it('Показывает состав, отдельные версии и общий хэш комплекта, даже если корень расположен последним', () => {
        const html = renderToStaticMarkup(createElement(InstallPlanDetails,{plan:multi}));
        expect(html).toContain('SHA-256 комплекта'); expect(html).toContain(multi.manifest);
        expect(html).toContain('Инструментов: 2'); expect(html).toContain('файлов: 2');
        for (const pkg of multi.packages ?? []) {
            expect(html).toContain(pkg.name); expect(html).toContain(pkg.id); expect(html).toContain(pkg.manifest);
            for (const file of pkg.files) { expect(html).toContain(file.path); expect(html).toContain(file.sha256); }
        }
        expect(html).toContain('Основной инструмент'); expect(html).toContain('Зависимость');
    });
    it('Не дублирует файлы и конфиг корня верхним обзором одиночного плана', () => {
        const html = renderToStaticMarkup(createElement(InstallPlanDetails,{plan:{...multi,
            files:[{...plan.files[0],path:'OBSOLETE_TOP_LEVEL_FILE.md'}], config:{note:'OBSOLETE_TOP_LEVEL_CONFIG'},
        }}));
        expect(html).not.toContain('OBSOLETE_TOP_LEVEL_FILE'); expect(html).not.toContain('OBSOLETE_TOP_LEVEL_CONFIG');
        expect(html.split('ROOT_CONFIG_ONLY_ONCE')).toHaveLength(2);
        expect(html).toContain('SKILL.md');
    });
    it('Показывает все 200 файлов комплекта без усечения по пакетам', () => {
        const members = [dependency,root].map((pkg,index) => ({...pkg,files:Array.from({length:100},(_,file)=>({...plan.files[0],path:`package-${index}/file-${file}.txt`}))}));
        const html = renderToStaticMarkup(createElement(InstallPlanDetails,{plan:{...multi,packages:members}}));
        expect(html).toContain('файлов: 200');
        for (const pkg of members) { for (const file of pkg.files) { expect(html).toContain(file.path); } }
    });
    it('Показывает точные требования без старых массивов mcp/plugins и не падает на пустом requirements', () => {
        const html = renderToStaticMarkup(createElement(InstallPlanDetails,{plan:multi}));
        expect(html).toContain(`MCP: ${dependency.id} · версия 3`); expect(html).toContain(dependency.manifest);
        expect(renderToStaticMarkup(createElement(InstallPlanDetails,{plan:{...plan,requirements:{}}}))).toContain('Не указаны');
    });
    it('Удалённый пакет показывает конфигурацию, пустые файлы и не вставляет HTML из имён', () => {
        const remote = {...dependency,name:'<script>опасное имя</script>',files:[],config:{transport:'remote',url:'https://mcp.example.test/path',headers:{Authorization:'Bearer {env:KEY}'}}};
        const html = renderToStaticMarkup(createElement(InstallPlanDetails,{plan:{...multi,packages:[remote,root]}}));
        expect(html).toContain('Локальных файлов нет'); expect(html).toContain('https://mcp.example.test/path'); expect(html).toContain('{env:KEY}');
        expect(html).toContain('&lt;script&gt;'); expect(html).not.toContain('<script>опасное');
    });
    it('Подписи действий явно относятся ко всему комплекту, роли и блокировки сохраняются', () => {
        const actions = {plan:multi,canApprove:true,busy:false,installOnApprove:true,onCancel:vi.fn(),onApprove:vi.fn(),onRevoke:vi.fn(),onInstall:vi.fn()};
        expect(renderToStaticMarkup(createElement(InstallPlanActions,actions))).toContain('Одобрить и установить комплект');
        expect(renderToStaticMarkup(createElement(InstallPlanActions,{...actions,installOnApprove:false}))).toContain('Одобрить комплект');
        const approved = renderToStaticMarkup(createElement(InstallPlanActions,{...actions,plan:{...multi,status:'approved'},canApprove:false,installDisabled:true}));
        expect(approved).toContain('Установить одобренный комплект'); expect(approved).toContain('disabled=""'); expect(approved).not.toContain('Отозвать');
        expect(actions.onApprove).not.toHaveBeenCalled(); expect(actions.onInstall).not.toHaveBeenCalled();
    });
    it('Одиночный план сохраняет прежнюю подпись хэша и обзор файлов', () => {
        const html = renderToStaticMarkup(createElement(InstallPlanDetails,{plan}));
        expect(html).toContain('SHA-256 манифеста'); expect(html).not.toContain('Состав комплекта'); expect(html).toContain('SKILL.md');
    });
});

describe('Просмотр файлов и доступных действий разрешения', () => {
    const actions = { onCancel: vi.fn(), onApprove: vi.fn(), onRevoke: vi.fn(), onInstall: vi.fn(), busy: false, installOnApprove: true };

    it('Разработчик видит отмену и не получает кнопок администрирования', () => {
        const html = renderToStaticMarkup(createElement(InstallPlanActions, { ...actions, plan, canApprove: false }));
        expect(html).toContain('Отмена');
        expect(html).not.toContain('Одобрить');
        expect(html).not.toContain('Отозвать');
    });

    it('Администратор может одобрить установку или отдельно разрешить версию', () => {
        expect(renderToStaticMarkup(createElement(InstallPlanActions, { ...actions, plan, canApprove: true }))).toContain('Одобрить и установить');
        expect(renderToStaticMarkup(createElement(InstallPlanActions, { ...actions, plan, canApprove: true, installOnApprove: false }))).toContain('Одобрить версию');
    });

    it('Уже одобренная версия сохраняет доступное действие отзыва', () => {
        const html = renderToStaticMarkup(createElement(InstallPlanActions, { ...actions, plan: { ...plan, status: 'approved' }, canApprove: true }));
        expect(html).toContain('Отозвать разрешение');
        expect(html).not.toContain('Одобрить и установить');
    });

    it.each([false, true])('После чужого одобрения установка доступна по явному нажатию, админ: %s', canApprove => {
        const html = renderToStaticMarkup(createElement(InstallPlanActions, { ...actions, plan: { ...plan, status: 'approved' }, canApprove }));
        expect(html).toContain('Установить одобренную версию');
        expect(actions.onInstall).not.toHaveBeenCalled();
    });

    it('Контроль разрешения без установки сохраняет только отзыв для администратора', () => {
        const html = renderToStaticMarkup(createElement(InstallPlanActions, { ...actions, plan: { ...plan, status: 'approved' }, canApprove: true, installOnApprove: false }));
        expect(html).toContain('Отозвать разрешение');
        expect(html).not.toContain('Установить одобренную версию');
    });

    it('Блокирует установку при недоступном подключении MCP', () => {
        const html = renderToStaticMarkup(createElement(InstallPlanActions, { ...actions, plan: { ...plan, status: 'approved' }, canApprove: false, installDisabled: true }));
        expect(html).toContain('Установить одобренную версию');
        expect(html).toContain('disabled=""');
    });

    it('Показывает все файлы и хэши без сокращения до первого ресурса', () => {
        const files = Array.from({ length: 100 }, (_, index) => ({ ...plan.files[0], path: `assets/file-${index}.txt` }));
        const html = renderToStaticMarkup(createElement(InstallPlanDetails, { plan: { ...plan, files } }));
        for (const file of files) { expect(html).toContain(file.path); }
        expect(html).toContain(plan.manifest);
        expect(html).toContain(plan.files[0].sha256);
        expect(html).toContain('Посмотреть содержимое');
    });

    it('Показывает конфигурацию текстом, бинарный ресурс по хэшу, и зависимости обоих видов', () => {
        const html = renderToStaticMarkup(createElement(InstallPlanDetails, { plan: {
            ...plan, files: [{ ...plan.files[0], path: 'assets/tool.bin', encoding: 'base64', content: 'AA==' }],
            config: { url: 'https://mcp.example', command: '<script>bad()</script>' }, requirements: { mcp: ['browser'], plugins: ['review'] },
        } }));
        expect(html).toContain('Бинарный файл');
        expect(html).toContain('assets/tool.bin');
        expect(html).toContain('https://mcp.example');
        expect(html).toContain('&lt;script&gt;');
        expect(html).not.toContain('<script>bad()');
        expect(html).toContain('MCP: browser');
        expect(html).toContain('Плагин: review');
    });
});
