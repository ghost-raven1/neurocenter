/** Owner IPC remains open for the service lifetime; EOF kills this launch's own current group. */
if (process.env.NEUROCENTER_DEV_LAUNCH_ACK === '1') {
    delete process.env.NEUROCENTER_DEV_LAUNCH_ACK;
    const launchId = process.env.NEUROCENTER_DEV_LAUNCH_ID ?? null, nonce = process.env.NEUROCENTER_DEV_OWNER_NONCE;
    delete process.env.NEUROCENTER_DEV_OWNER_NONCE;
    const uuid = value => /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value ?? '');
    if (!uuid(nonce) || launchId !== null && !uuid(launchId) || !process.send || process.platform === 'win32') process.exit(1);
    process.once('disconnect', () => { process.kill(0, 'SIGKILL'); });
    process.send({kind: 'dev-launch-ack', launchId, nonce, pid: process.pid}, error => {
        if (error) process.exit(1);
        else process.channel?.unref();
    });
}
