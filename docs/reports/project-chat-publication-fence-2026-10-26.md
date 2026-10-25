# Проверка источников при публикации ответа проекта

Backport от `550394a1632389569ad82508780aabe52a4a02e8`, без MCP43 и без изменения схемы. В B42 inference проверял tool sources после ответа модели, но runner при последующем сохранении проверял только права комнаты и snapshot агента. Закрытие публичного источника между этими этапами позволяло сохранить его старый текст в общем ответе.

Контролируемый тест использует настоящие ProjectChatRunner, ProjectChatInferenceService и AgentToolsService с bounded planner. Provider, durable storage и домен публичного поиска — fixtures. На исходном main оба порядка `provider ACK → revoke → owner transaction` и `provider ACK → UPDATE → revoke → commit` публиковали sentinel как done: **2 RED / 2 GREEN**. После правки публичный текст не сохраняется, а результат получает failed. Штатные ответы с инструментами и без них остаются done; запроса модели или инструмента повторно нет.

Inference передаёт приватный final-source callback владельцу записи. Runner вызывает его на своём db до и после UPDATE. Допускается только собственный done recipient того же исходного сообщения и generation; отменённый родитель не проходит. Public search reader использует этот же db, заново проверяет доступ и удерживает source room/message/revision/vector locks до commit. Pin и RAG identity также проверяются на переданном соединении. Новый pool внутри owner transaction не запрашивается.

Финальный малый набор: **91/91** (6 новых сценариев и относящиеся project/search/context unit). Отдельно подтверждены чтение текущей public visibility через настоящий ChatSearchService и отказ от повторного захвата единственного соединения. Сохранены `.run/publication-red.json` и `.run/publication-related.json`.

SQL, native, tsc, широкое покрытие и production здесь не запускались. Два дополнительных SQL-данных в существующей owned-PG fixture задают фактическую embedding-модель и её назначение для новой проверки pin; этот PG-набор остаётся отдельной проверкой владельца выпуска. Frozen schema и миграции не менялись.
