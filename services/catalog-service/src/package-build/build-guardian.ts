/** IPC исчезает и после SIGKILL сервера; дочерние npm/esbuild не остаются писать в старый staging. */
if (process.send && process.platform !== 'win32') {
    process.once('disconnect', () => {
        try {process.kill(-process.pid, 'SIGKILL');} catch {process.exit(1);}
    });
    process.channel?.unref();
}
