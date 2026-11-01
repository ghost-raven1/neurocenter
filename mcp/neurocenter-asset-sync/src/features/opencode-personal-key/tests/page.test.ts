import { createContext, runInContext } from 'node:vm';
import { expect, it, vi } from 'vitest';
import { personalKeyPage } from '../page.js';
interface INode {
    disabled: boolean;
    textContent: string;
    onclick?: () => Promise<void>;
}
it('opening and preparing never transmit a key; explicit confirmation sends only a preview identity', async () => {
    const nodes = new Map<string, INode>(
        ['recipient', 'prepare', 'save', 'receipt', 'close', 'status'].map((id) => [
            id,
            { disabled: id !== 'close', textContent: '' },
        ]),
    );
    const requests: Array<{ route: string; body: unknown }> = [];
    const fetch = vi.fn(async (route: string, init: { body: string }) => {
        requests.push({ route, body: JSON.parse(init.body) });
        const value =
            route === '/session'
                ? { csrf: 'fixture' }
                : route === '/prepare'
                  ? { previewId: 'one-preview' }
                  : route === '/save'
                    ? { receipt: { hasKey: true } }
                    : {
                          inventory: {
                              recipient: {
                                  ownerEmail: 'owner@example.test',
                                  modelName: 'OpenAI',
                                  providerUrl: 'https://api.openai.com/v1',
                                  connectionRevision: 2,
                                  credentialRevision: 0,
                              },
                              siteOrigin: 'https://site.example.test',
                              apiOrigin: 'https://api.example.test',
                              source: 'stored API key',
                          },
                          lastSave: null,
                      };
        return { ok: true, json: async () => value };
    });
    const script = personalKeyPage.split('<script>')[1]?.split('</script>')[0];
    if (!script) throw Error('Missing page');
    runInContext(
        script,
        createContext({
            fetch,
            history: { replaceState: vi.fn() },
            location: { hash: '#fixture', pathname: '/' },
            document: { getElementById: (id: string) => nodes.get(id) },
            window: { close: vi.fn() },
        }),
    );
    await vi.waitFor(() => expect(nodes.get('prepare')?.disabled).toBe(false));
    expect(nodes.get('recipient')?.textContent).toContain('https://api.example.test');
    expect(requests.map((x) => x.route)).toEqual(['/session', '/inventory']);
    await nodes.get('prepare')?.onclick?.();
    expect(nodes.get('save')?.disabled).toBe(false);
    expect(requests.some((x) => x.route === '/save')).toBe(false);
    await nodes.get('save')?.onclick?.();
    expect(requests.at(-1)).toEqual({ route: '/save', body: { previewId: 'one-preview' } });
    expect(nodes.get('save')?.disabled).toBe(true);
    expect(nodes.get('status')?.textContent).toContain('Ключ сохранён');
});
