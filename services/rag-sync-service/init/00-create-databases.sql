-- Создаёт БД микросервисов lancedb-storage (fresh-том Postgres).
-- Изначальный скрипт docker-entrypoint запускается от ${POSTGRES_DB} (rag) как
-- superuser. Остальные БД создаём здесь и вешаем pgvector.
CREATE DATABASE catalog;
CREATE DATABASE skills;

\c catalog
CREATE EXTENSION IF NOT EXISTS vector;

\c skills
CREATE EXTENSION IF NOT EXISTS vector;

\c rag
