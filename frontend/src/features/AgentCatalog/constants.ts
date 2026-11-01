/** Agent definition limits and OpenCode defaults. */
export const AGENT_PROMPT_MAX_BYTES = 64 * 1024;
export const AGENT_DESCRIPTION_MAX_BYTES = 1024;
export const agentModeLabels = { primary: 'Основной агент', subagent: 'Подагент', all: 'Основной и подагент' };
export const agentPermissionLabels: Record<string, string> = {
    read: 'Чтение файлов',
    edit: 'Изменение файлов',
    bash: 'Команды терминала',
    glob: 'Поиск файлов',
    grep: 'Поиск по содержимому',
    list: 'Просмотр папок',
    task: 'Вызов других агентов',
    external_directory: 'Файлы вне проекта',
    todowrite: 'Список задач',
    question: 'Вопросы пользователю',
    webfetch: 'Загрузка веб-страниц',
    websearch: 'Поиск в интернете',
    lsp: 'Анализ кода',
    doom_loop: 'Повторяющиеся действия',
    skill: 'Скиллы',
};
export const defaultAgentPermission = {
    read: 'allow',
    glob: 'allow',
    grep: 'allow',
    list: 'allow',
    edit: 'ask',
    bash: 'ask',
    task: 'ask',
    external_directory: 'ask',
} as const;
export const agentSlugPattern = /^nc-[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const agentModelPattern = /^(?!.*:\/\/)[a-zA-Z0-9][a-zA-Z0-9._-]*\/[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/;
