/** После commit каталог перечитывает новый pin; отказ онлайн-канала не откатывает данные. */
export async function notifyModelCatalogChange(): Promise<void> {
    const token = process.env.NEUROCENTER_INTERNAL_TOKEN;
    if (!token) {
        return;
    }
    await fetch((process.env.API_GATEWAY_URL || 'http://localhost:4000').replace(/\/$/, '') + '/internal/events', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-neurocenter-internal': token },
        body: JSON.stringify({ sections: ['catalog', 'projects', 'audit', 'operations'] }),
        signal: AbortSignal.timeout(1500),
    })
        .then((response) => response.body?.cancel())
        .catch(() => undefined);
}
