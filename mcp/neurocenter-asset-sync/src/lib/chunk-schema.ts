import {
    Field,
    FixedSizeList,
    Float32,
    Int32,
    Schema,
    Utf8,
} from 'apache-arrow';

/** Явная схема позволяет создать таблицу даже при полностью пустой колонке описаний. */
export function chunkSchema(dimension: number): Schema {
    if (!Number.isSafeInteger(dimension) || dimension < 1) {
        throw new Error(
            'Неизвестна размерность векторов. Нельзя создать локальную LanceDB.',
        );
    }
    return new Schema([
        ...[
            'id',
            'content',
            'description',
            'filePath',
            'language',
            'kind',
            'role',
            'quirkType',
            'tags',
        ].map((name) => new Field(name, new Utf8(), name !== 'id')),
        new Field('startLine', new Int32(), true),
        new Field('endLine', new Int32(), true),
        new Field(
            'embedding',
            new FixedSizeList(
                dimension,
                new Field('item', new Float32(), true),
            ),
            true,
        ),
    ]);
}
