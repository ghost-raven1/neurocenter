import { describe, expect, it } from 'vitest';
import { validateModelAssignment, validateModelCreate, validateModelDescriptor, validateModelDelete, validateModelUpdate } from '../src/models/model-validation';

const model = { name: '  Моя модель  ', description: '  Для проекта  ', capability: 'embedding', model: 'qwen3-embedding:4b', dimension: 2560 };

describe('Валидация карточек моделей', () => {
    it('Нормализует метаданные и не принимает адрес runtime от пользователя', () => {
        expect(validateModelCreate(model)).toEqual({ ...model, runtime: 'ollama', name: 'Моя модель', description: 'Для проекта' });
        expect(validateModelCreate({ name: 'Чат', capability: 'chat', model: 'team/model:1.0' })).toMatchObject({ dimension: null, description: '' });
        expect(() => validateModelCreate({ ...model, runtimeUrl: 'http://localhost:11434' })).toThrow('неподдерживаемые');
        expect(() => validateModelCreate({ ...model, manifestSha256: 'a'.repeat(64) })).toThrow('неподдерживаемые');
    });

    it.each(['https://registry.example/model:1', 'registry.example/model:1', 'localhost:11434/model:1', '../model:1', 'model', 'model:', 'model:one/two', 'model:1\n', 'model:$(command)'])('Не принимает URL, команды и неявный тег: %s', technicalName => {
        expect(() => validateModelCreate({ ...model, model: technicalName })).toThrow('явным тегом');
    });

    it.each([
        { name: '' }, { name: 'a'.repeat(129) }, { name: 'строка\nдругая' }, { description: 'a'.repeat(4001) },
        { description: 'текст\u0000' }, { capability: 'audio' }, { dimension: 0 }, { dimension: 1.5 }, { dimension: 16385 },
        { capability: 'chat', dimension: 2560 },
    ])('Отклоняет некорректные поля: %j', changes => {
        expect(() => validateModelCreate({ ...model, ...changes })).toThrow();
    });

    it('Редактирование требует ревизию; удалённая техническая идентичность проверяется с текущим runtime', () => {
        expect(validateModelUpdate({ expectedRevision: 3, name: ' Новое ' })).toEqual({ expectedRevision: 3, name: 'Новое' });
        expect(() => validateModelUpdate({ name: 'Новое' })).toThrow('expectedRevision');
        expect(validateModelUpdate({ expectedRevision: 1, model: 'other:1', dimension: 5, modelVersion: 'v2' })).toMatchObject({ model: 'other:1', dimension: 5, modelVersion: 'v2' });
        for (const changes of [{ capability: 'vision' }, { runtime: 'remote-openai' }, { source: 'builtin' }]) {
            expect(() => validateModelUpdate({ expectedRevision: 1, ...changes })).toThrow('неподдерживаемые');
        }
        expect(() => validateModelDelete({ expectedRevision: '1' })).toThrow('expectedRevision');
        expect(() => validateModelDelete({ expectedRevision: 0 })).toThrow('expectedRevision');
        expect(validateModelDelete({ expectedRevision: 1 })).toBe(1);
    });

    it('Назначение использует только постоянный идентификатор модели', () => {
        expect(validateModelAssignment({ modelId: 'model-example' })).toBe('model-example');
        expect(() => validateModelAssignment({ modelId: 'model-example', actor: 'forged@example.invalid' })).toThrow('неподдерживаемые');
        expect(() => validateModelAssignment({ modelId: '../model-example' })).toThrow('Выберите');
        expect(() => validateModelAssignment(null)).toThrow('данные модели');
    });

    it('Нативный descriptor локальной модели не содержит deployment адреса', () => {
        const descriptor = validateModelDescriptor({ description: 'Модель из ассета', runtime: 'ollama', model: 'fixture:1', capability: 'embedding', dimension: 3, source: 'builtin', manifestSha256: 'a'.repeat(64) });
        expect(descriptor.manifestSha256).toBe('a'.repeat(64));
        expect(Object.keys(descriptor)).not.toContain('baseUrl');
    });
});
