// @vitest-environment jsdom
import {act, createElement, type ChangeEvent} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {webcrypto} from 'node:crypto';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {ModelTokenQuotas} from '../src/features/ModelTokenQuotas/ModelTokenQuotas';
import {quotaStorageKey} from '../src/features/ModelTokenQuotas/storage';
import {deferred, failure, identity, input, view} from './model-token-quotas.fixture';

const io = vi.hoisted(() => ({owner: 1, users: vi.fn(), read: vi.fn(), write: vi.fn(), receipt: vi.fn()}));
vi.mock('../src/features/ModelTokenQuotas/api', () => ({quotaApi: io}));
vi.mock('react-redux', () => ({useSelector: (read: (state: unknown) => unknown) => read({userBlock: {user: {email: 'admin@example.test', activeRole: 'Главный админ'}}})}));
const auth = vi.hoisted(() => ({captureOwner: () => {const owner = io.owner; return () => io.owner === owner;}}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner', () => ({useAuthRequestOwner: () => ({scope: identity.scope, captureOwner: auth.captureOwner})}));
// The picker boundary is a semantic native select; real parent/controller/ownership/HTTP transitions remain under test.
vi.mock('antd', async original => ({...await original<typeof import('antd')>(), Select: ({options, onChange, value, placeholder, ...props}: {options?: Array<{value: string; label: string}>; onChange?: (value: string) => void; value?: string; placeholder?: string; 'aria-label'?: string; disabled?: boolean}) => createElement('select', {'aria-label': props['aria-label'], disabled: props.disabled, value: value ?? '', onChange: (event: ChangeEvent<HTMLSelectElement>) => onChange?.(event.currentTarget.value)}, createElement('option', {value: ''}, placeholder), ...(options?.map(option => createElement('option', {key: option.value, value: option.value}, option.label)) ?? []))}));

let root: Root, container: HTMLDivElement;
const users = [{email: identity.userEmail, displayName: 'Сотрудник без вызовов', enabled: true}, {email: 'second@example.test', displayName: 'Второй сотрудник', enabled: true}];
const toggle = async (details: HTMLDetailsElement, open = true) => {await act(async () => {details.open = open; details.dispatchEvent(new Event('toggle'));});};
const select = async (email: string) => {await act(async () => {const field = container.querySelector('select[aria-label="Пользователь персональной квоты"]') as HTMLSelectElement; field.value = email; field.dispatchEvent(new Event('change', {bubbles: true}));});};
const click = async (text: string) => {await act(async () => {const button = [...container.querySelectorAll('button')].find(value => value.textContent === text); expect(button).toBeDefined(); button!.click();});};
beforeEach(async () => {
    vi.resetAllMocks(); io.owner = 1; vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); localStorage.clear();
    Object.defineProperty(window, 'matchMedia', {configurable: true, value: vi.fn(() => ({matches: false, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn()}))});
    vi.stubGlobal('ResizeObserver', class {observe() {} unobserve() {} disconnect() {}});
    io.users.mockResolvedValue(users); io.read.mockResolvedValue(view()); io.receipt.mockRejectedValue(failure(404));
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    await act(async () => root.render(createElement(ModelTokenQuotas, {modelId: identity.modelId})));
});
afterEach(async () => {await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals();});

it('starts collapsed with no private request; first expansion loads users once and closing retains its owned state', async () => {
    const section = container.querySelector('details')!; expect(section.open).toBe(false); expect(io.users).not.toHaveBeenCalled(); expect(io.read).not.toHaveBeenCalled();
    await toggle(section); expect(io.users).toHaveBeenCalledOnce(); expect(container.textContent).toContain('Сотрудник без вызовов'); expect(io.read).not.toHaveBeenCalled();
    await toggle(section, false); await toggle(section); expect(io.users).toHaveBeenCalledOnce(); expect(io.write).not.toHaveBeenCalled();
});
it('a fresh policy403 clears parent users/options/selection and counters, preserves the exact journal, then reauthorizes by explicit reload', async () => {
    const storageKey = quotaStorageKey(identity), raw = JSON.stringify({schemaVersion: 1, ...identity, input: input()}); localStorage.setItem(storageKey, raw);
    const initial = view(); initial.counters.chargedTokens = '200'; io.read.mockResolvedValueOnce(initial);
    await toggle(container.querySelector('details')!); await select(identity.userEmail); expect(container.textContent).toContain('200');
    await toggle(container.querySelector('details.model-token-quotas__more')!); io.read.mockRejectedValueOnce(failure(403)); await click('Обновить сведения');
    expect(container.querySelectorAll('option').length).toBe(1); expect((container.querySelector('select') as HTMLSelectElement).value).toBe(''); expect(container.textContent).not.toContain(identity.userEmail); expect(container.textContent).not.toContain('Сотрудник без вызовов'); expect(container.textContent).not.toContain('200'); expect(localStorage.getItem(storageKey)).toBe(raw);
    await click('Проверить доступ'); expect(io.users).toHaveBeenCalledTimes(2); await select(identity.userEmail); expect(container.textContent).toContain('Сохранённый запрос ожидает подтверждения'); expect(io.write).not.toHaveBeenCalled(); expect(localStorage.getItem(storageKey)).toBe(raw);
});
it('a late old-user403 cannot erase a newer user choice or its private view', async () => {
    await toggle(container.querySelector('details')!); const old = deferred<unknown>(); io.read.mockReturnValueOnce(old.promise); await select(identity.userEmail);
    const fresh = view({userEmail: 'second@example.test'}); fresh.counters.chargedTokens = '307'; io.read.mockResolvedValueOnce(fresh); await select('second@example.test');
    await act(async () => {old.reject(failure(403)); await Promise.resolve();});
    const roster = container.querySelector('select[aria-label="Пользователь персональной квоты"]') as HTMLSelectElement;
    expect((container.querySelector('select') as HTMLSelectElement).value).toBe('second@example.test'); expect(container.textContent).toContain('307'); expect(roster.options.length).toBe(3); expect([...roster.options].map(option => option.value)).toEqual(['', identity.userEmail, 'second@example.test']); expect(container.textContent).not.toContain('Доступ администратора не подтверждён');
});
