import {BadRequestException, ConflictException, ForbiddenException, HttpException, ServiceUnavailableException} from '@nestjs/common';

/** Saved failures expose the owned quota denial while provider details remain private. */
export function savedChatFailureMessage(error: unknown, cancelled: boolean): string {
    if (cancelled) return 'Запрос остановлен. Можно повторить его.';
    if (error instanceof HttpException && error.getStatus() === 403) {
        const response = error.getResponse();
        if (typeof response === 'object' && response !== null && 'code' in response && response.code === 'PERSONAL_PROVIDER_KEY_REQUIRED')
            return 'Откройте «Мой доступ» в карточке этой модели и сохраните свой API-ключ.';
    }
    if (error instanceof HttpException && error.getStatus() === 429) {
        const response = error.getResponse();
        if (typeof response === 'object' && response !== null && 'code' in response && response.code === 'MODEL_TOKEN_QUOTA_EXCEEDED')
            return 'Персональный бюджет модели исчерпан с учётом расхода и резерва. Дождитесь доступного бюджета или обратитесь к главному администратору.';
    }
    return error instanceof BadRequestException || error instanceof ServiceUnavailableException || error instanceof ConflictException
        || error instanceof ForbiddenException && error.message.startsWith('Функция «')
        ? error.message : 'Модель не выполнила запрос. Проверьте подключение и повторите.';
}
