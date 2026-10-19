import { Controller, Delete, NotImplementedException, Param, Post } from '@nestjs/common';

/** Команды снимков отделены от каталога; до реализации хранилища они возвращают явный отказ. */
@Controller('api/projects/:id')
export class SnapshotCommandsController {
    /** Активация требует проверенного снимка и атомарного CAS. */
    @Post('versions/:sid/activate')
    public activateHead(@Param('id') _id: string, @Param('sid') _sid: string): never {
        throw new NotImplementedException('Активация снимка пока недоступна. Текущая версия не изменена.');
    }

    /** Откат нельзя считать успешным без изменения сохранённого head. */
    @Post('versions/:sid/rollback')
    public rollbackHead(@Param('id') _id: string, @Param('sid') _sid: string): never {
        throw new NotImplementedException('Откат снимка пока недоступен. Текущая версия не изменена.');
    }

    /** Удаление требует реального tombstone и процедуры очистки. */
    @Delete('versions/:sid')
    public deleteSnapshot(@Param('id') _id: string, @Param('sid') _sid: string): never {
        throw new NotImplementedException('Удаление снимка пока недоступно. Данные не изменены.');
    }

    /** Публикация профиля требует сохранения версий и проверки связанных активов. */
    @Post('release-profile')
    public releaseProfile(@Param('id') _id: string): never {
        throw new NotImplementedException('Публикация релизного профиля пока недоступна. Профиль не изменён.');
    }
}
