import { expect, it, vi } from 'vitest';
import { createContext, runInContext } from 'node:vm';
import { accountsPage } from '../page.js';

/** Runs the actual private page against a DOM/event boundary and a controlled HTTP ACK. */
it('editing a key while preparation is pending cannot enable saving the previous key', async () => {
    const nodes = new Map<string, any>();
    for (const id of ['key', 'save', 'form', 'message', 'accounts', 'recovery', 'refresh', 'resume', 'close'])
        nodes.set(id, {
            value: '',
            disabled: id === 'save',
            hidden: false,
            textContent: '',
            replaceChildren: vi.fn(),
            append: vi.fn(),
        });
    let resolvePrepare!: (value: unknown) => void;
    const prepared = new Promise((resolve) => {
        resolvePrepare = resolve;
    });
    const requests: Array<{ route: string; body: Record<string, unknown> }> = [];
    const fetch = vi.fn(async (route: string, init: { body: string }) => {
        const body = JSON.parse(init.body);
        requests.push({ route, body });
        if (route === '/session') return { ok: true, json: async () => ({ csrf: 'fixture' }) };
        if (route === '/inventory')
            return { ok: true, json: async () => ({ accountInventory: { accounts: [], issues: [] } }) };
        if (route === '/prepare') return { ok: true, json: () => prepared };
        throw Error('Unexpected mutation');
    });
    const context = createContext({
        fetch,
        history: { replaceState: vi.fn() },
        location: { hash: '#fixture', pathname: '/' },
        document: {
            getElementById: (id: string) => nodes.get(id),
            createElement: () => ({}),
            querySelectorAll: () => [...nodes.values()],
        },
    });
    const script = accountsPage.split('<script>')[1]?.split('</script>')[0];
    if (!script) throw Error('Page script missing');
    runInContext(script, context);
    await vi.waitFor(() => expect(nodes.get('message').textContent).toBe('Сохранённых учётных записей нет.'));
    nodes.get('key').value = 'key-before-edit';
    nodes.get('form').onsubmit({ preventDefault: vi.fn() });
    await vi.waitFor(() => expect(requests.filter((item) => item.route === '/prepare')).toHaveLength(1));
    nodes.get('key').value = 'key-after-edit';
    nodes.get('form').oninput();
    resolvePrepare({ previewId: 'previous-key-preview', providerId: 'anthropic' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(nodes.get('save').disabled).toBe(true);
    nodes.get('save').onclick();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(requests.filter((item) => item.route === '/save')).toEqual([]);
    expect(nodes.get('key').value).toBe('key-after-edit');
});
