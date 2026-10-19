/** Готовый legacy-плагин: регистрация не запускает команды и не обращается к сети. */
export default async function projectContext() {
    return {
        'experimental.chat.system.transform': async (_input, output) => {
            output.system.push('Объясняй изменения коротко и сохраняй стиль существующего проекта.');
        },
    };
}
