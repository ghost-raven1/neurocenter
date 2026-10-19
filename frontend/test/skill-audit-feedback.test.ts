import { configureStore } from '@reduxjs/toolkit';
import { message } from 'antd';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import bffApi from '../src/core/api/bff';
import type { ISkillFile, ISkillMutationResult } from '../src/core/api/interfaces';
import { useAppDispatch } from '../src/core/hooks';
import SkillEditorModal from '../src/modules/Skills/components/SkillEditorModal';
import SkillListTable from '../src/modules/Skills/components/SkillListTable';
import reducer, { openEditor } from '../src/modules/Skills/redux/reducers';
import { notifySkillMutation } from '../src/modules/Skills/skillMutationFeedback';

const ui = vi.hoisted(() => ({
    state: (): unknown => ({}), save: undefined as (() => void) | undefined,
    remove: undefined as (() => void) | undefined,
}));

vi.mock('../src/core/hooks', () => ({useAppDispatch: vi.fn()}));
vi.mock('react-redux', () => ({useSelector: (select: (state: unknown) => unknown) => select(ui.state())}));
vi.mock('../src/common/components/Permission', () => ({default: ({children}: {children: ReactNode}) => children}));
vi.mock('../src/common/components/CodeBlock', () => ({CodeBlock: () => null}));
vi.mock('antd', async () => {
    const {createElement: h} = await import('react');
    const content = ({children}: {children?: ReactNode}) => children;
    const Form = Object.assign(content, {
        Item: content,
        useForm: () => [{validateFields: async () => ({name:'Проверка',slug:'helper',body:'# Инструкция'}),
            setFieldsValue: vi.fn(),resetFields: vi.fn()}],
    });
    return {
        Form, Input: Object.assign(() => null,{TextArea: () => null}), Select: () => null,
        Modal: ({open,children,footer}: {open: boolean;children: ReactNode;footer: ReactNode}) => open ? h('div',null,children,footer) : null,
        Button: ({children,onClick}: {children: ReactNode;onClick?: () => void}) => {
            if (children === 'Сохранить') { ui.save=onClick; }
            return null;
        },
        Popconfirm: ({onConfirm}: {onConfirm: () => void}) => { ui.remove=onConfirm; return null; },
        Table: ({columns,dataSource}: {columns: {key: string;render: (value: unknown,row: unknown) => ReactNode}[];dataSource: unknown[]}) =>
            columns.find(column=>column.key==='actions')?.render(undefined,dataSource[0]) ?? null,
        Space: content, Spin: () => null, Tag: content, Typography: {Text: content},
        message: {success: vi.fn(),warning: vi.fn(),error: vi.fn()},
    };
});

const skill: ISkillFile = {
    path:'common/helper',body:'# Инструкция',meta:{name:'Проверка',slug:'helper',scope:'common',mcp:[],plugins:[],tags:[],
        version:1,owner:'user@example.test',updatedAt:'2026-10-18T00:00:00.000Z',history:[]},
};

function setup(mode: 'create' | 'edit' = 'create') {
    const store=configureStore({reducer:{skills:reducer}});
    store.dispatch(openEditor({mode,path:skill.path}));
    ui.state=()=>({...store.getState(),skills:{...store.getState().skills,skills:[skill]}});
    vi.mocked(useAppDispatch).mockReturnValue(store.dispatch);
    vi.spyOn(bffApi,'getSkillTree').mockResolvedValue([]);
    vi.spyOn(bffApi,'listSkills').mockResolvedValue([]);
    return store;
}

beforeEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); ui.save=undefined; ui.remove=undefined; });

describe('Сохранение скилла при ожидании аудита', () => {
    it('Ожидающий аудит папки не маскируется под ошибку или создание файла', () => {
        notifySkillMutation({ audit: { state: 'pending' } }, 'Папка создана', 'directory');
        expect(message.warning).toHaveBeenCalledExactlyOnceWith('Папка создана. Ожидается подтверждение аудита.', 8);
        expect(message.success).not.toHaveBeenCalled();
        expect(message.error).not.toHaveBeenCalled();
    });
    it('Ожидание подтверждения показывает предупреждение и сохраняет полученный результат', () => {
        const result: ISkillMutationResult={...skill,audit:{state:'pending'}};
        const before=structuredClone(result);
        notifySkillMutation(result,'Скилл создан');
        expect(message.warning).toHaveBeenCalledExactlyOnceWith('Изменения сохранены. Ожидается подтверждение аудита.',8);
        expect(message.success).not.toHaveBeenCalled();
        expect(message.error).not.toHaveBeenCalled();
        expect(result).toEqual(before);
    });

    it('Подтверждённое сохранение сохраняет обычное сообщение об успехе', () => {
        notifySkillMutation(skill,'Скилл создан');
        expect(message.success).toHaveBeenCalledExactlyOnceWith('Скилл создан');
        expect(message.warning).not.toHaveBeenCalled();
    });

    it.each(['create','edit'] as const)('Успешный %s закрывает редактор даже при отложенном аудите', async mode => {
        const store=setup(mode);
        const mutation=vi.spyOn(bffApi,mode==='create'?'createSkill':'updateSkill')
            .mockResolvedValue({...skill,audit:{state:'pending'}});
        renderToStaticMarkup(createElement(SkillEditorModal,{dirPath:'common'}));
        expect(ui.save).toBeTypeOf('function');
        ui.save?.();
        await vi.waitFor(()=>expect(store.getState().skills.editorOpen).toBe(false));
        expect(mutation).toHaveBeenCalledOnce();
        expect(bffApi.getSkillTree).toHaveBeenCalledOnce();
        expect(bffApi.listSkills).toHaveBeenCalledWith({path:'common'});
        expect(message.warning).toHaveBeenCalledWith('Изменения сохранены. Ожидается подтверждение аудита.',8);
        expect(message.error).not.toHaveBeenCalled();
    });

    it.each(['create','edit'] as const)('Отклонённый %s оставляет редактор открытым и не показывает успех', async mode => {
        const store=setup(mode);
        vi.spyOn(bffApi,mode==='create'?'createSkill':'updateSkill').mockRejectedValue(new Error('Отклонено'));
        renderToStaticMarkup(createElement(SkillEditorModal,{dirPath:'common'}));
        ui.save?.();
        await vi.waitFor(()=>expect(message.error).toHaveBeenCalledOnce());
        expect(store.getState().skills.editorOpen).toBe(true);
        expect(message.success).not.toHaveBeenCalled();
        expect(message.warning).not.toHaveBeenCalled();
        expect(bffApi.getSkillTree).not.toHaveBeenCalled();
    });

    it('Удаление с отложенным аудитом обновляет список без ложной ошибки', async () => {
        setup();
        vi.spyOn(bffApi,'deleteSkill').mockResolvedValue({ok:true,path:skill.path,audit:{state:'pending'}});
        renderToStaticMarkup(createElement(SkillListTable,{dirPath:'common'}));
        expect(ui.remove).toBeTypeOf('function');
        ui.remove?.();
        await vi.waitFor(()=>expect(bffApi.listSkills).toHaveBeenCalledOnce());
        expect(message.warning).toHaveBeenCalledExactlyOnceWith('Скилл удалён. Ожидается подтверждение аудита.',8);
        expect(message.success).not.toHaveBeenCalled();
        expect(message.error).not.toHaveBeenCalled();
    });

    it('Отклонённое удаление не выдаётся за удалённый скилл', async () => {
        setup();
        vi.spyOn(bffApi,'deleteSkill').mockRejectedValue(new Error('Отклонено'));
        renderToStaticMarkup(createElement(SkillListTable,{dirPath:'common'}));
        ui.remove?.();
        await vi.waitFor(()=>expect(message.error).toHaveBeenCalledWith('Не удалось удалить скилл'));
        expect(message.success).not.toHaveBeenCalled();
        expect(message.warning).not.toHaveBeenCalled();
        expect(bffApi.listSkills).not.toHaveBeenCalled();
    });
});
