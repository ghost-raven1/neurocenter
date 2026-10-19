/** После таймаута CLI останавливает только подтверждённый контейнер своей одноразовой операции. */
export async function stopOwnedSyncContainer(name, label, token, runDocker) {
    const owned = async () => {
        const output = await runDocker(['ps', '--all', '--no-trunc', '--filter', `name=^/${name}$`,
            '--filter', `label=${label}=${token}`, '--format', '{{.ID}}'], { timeout: 60000 });
        if (!output.trim()) { return ''; }
        if (!/^[a-f0-9]{64}$/.test(output.trim())) { throw new Error('Не подтверждён контейнер синхронизации.'); }
        return output.trim();
    };
    const id = await owned();
    if (!id) { return; }
    try { await runDocker(['rm', '--force', id], { timeout: 60000 }); }
    catch (error) { if (await owned()) { throw error; } }
    if (await owned()) { throw new Error('Контейнер синхронизации продолжает работать.'); }
}
