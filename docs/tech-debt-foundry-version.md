# Cyberpunk2020VTT → Foundry VTT 14: актуальный статус и техдолг

Дата сверки: 2026-09-08. Целевая сборка: Foundry VTT `14.365` (Stable 7), система `2.0.0`.

## Что уже перенесено

| Область | Состояние |
|---|---|
| Manifest | V14-only: `minimum: 14.365`, `verified: 14.365`, `maximum: 14`; удалены устаревшие/нестандартные верхнеуровневые поля |
| Пространственная механика | `MeasuredTemplate` удалён из runtime; AoE и suppressive fire используют публичные `RegionLayer.placeRegion` и `RegionDocument.testPoint` |
| Grid/token API | расстояние считается через `BaseGrid.measurePath`, центры токенов — через `TokenDocument.getCenterPoint` |
| Roll/chat API | `Die` берётся из `foundry.dice.terms`; приватный `Roll._evaluated` и legacy chat `type` удалены |
| Hooks | chat actions подключаются только через V14 `renderChatMessageHTML` |
| Compendia | 28 объявленных LevelDB pack-ов, 2 124 документа, мигрированы на `system`/`ownership` и V14 RollTable schema |
| Проверки | единый runner, manifest contract, non-mutating pack audit и release packaging workflow |

## Блокер стабильного релиза

Единственный обязательный незакрытый слой — live QA на лицензированном Foundry `14.365` с копией реального мира. Node-тесты проверяют наши контракты, но не эмулируют серверную валидацию Foundry, WebGL canvas, права игроков, core migration V13→V14 и взаимодействие с модулями.

До production-миграции нужно пройти [V14 upgrade guide](./v14-upgrade-guide.md) и [verification checklist](./verification-checklist.md). Номер релиза `2.0.0` не заменяет live sign-off: статических тестов для production-world недостаточно.

## Оставшийся техдолг, не блокирующий V14

### 1. ApplicationV1 sheets и диалоги

`CyberpunkActorSheet`, `CyberpunkItemSheet` и `ModifiersDialog` используют ApplicationV1/jQuery lifecycle. Эти классы присутствуют в V14, поэтому переписывать весь UI для запуска на V14 не требуется. Однако это отдельный будущий проект:

- `ActorSheetV2` / `ItemSheetV2` + `HandlebarsApplicationMixin`;
- `DocumentSheetConfig.registerSheet`;
- native DOM actions вместо `html.find(...)`;
- `DialogV2` для форм и подтверждений.

Такой перенос нельзя смешивать с core-world migration: он меняет почти все sheet lifecycle contracts и потребует отдельного UI regression cycle.

### 2. Legacy `template.json`

Система всё ещё определяет Actor/Item data через `template.json`, а не через собственные `TypeDataModel`. Этот путь работает в целевой V14, но не даёт строгой клиентской модели и удобных field migrations. Переход нужно проектировать отдельно вместе с server-sanitization `documentTypes` в manifest и миграциями persisted data.

### 3. Стабильность Compendium ID

Исторические collection ID `netrunningEquipment`, `heavyWeapons` и `weapons_other` соответствуют фактическому валидатору V14 и сохранены без изменений вместе с путями паков. Это оставляет рабочими существующие UUID, макросы и прямые обращения сторонних модулей. Любое будущее переименование этих ID будет отдельным breaking change и потребует собственной миграции ссылок.

### 4. Persisted и derived state

Часть derived actor values по-прежнему формируется прямой записью в `this.system` во время `prepareData()`. Для derived state это допустимо, но паттерн нельзя переносить на persisted поля. Любые пользовательские изменения должны продолжать идти через `update()` / `updateEmbeddedDocuments()`.

### 5. Migration performance

World Actors/Items и документы world-owned compendia обходятся последовательно. Locked world packs временно открываются и обязательно закрываются в `finally`; package-owned packs не изменяются во время запуска мира. Это безопаснее для данных, но на большом мире миграция может быть заметной. Нужен замер на копии реального мира до оптимизации concurrency.

### 6. CSS scope

В стилях остаются широкие селекторы и зависимость от ApplicationV1 DOM. Их следует локализовать под root-класс системы до будущего перехода на ApplicationV2, но это не является API-блокером V14.

## Осознанно сохранённая совместимость данных

- Имена функций и chat `data-template-id` оставлены как legacy aliases, хотя внутри они теперь обозначают Region ID. Это сохраняет старые combat evidence и обработчики.
- Tracker читает suppressive-fire flags и из старого `cyberpunk2020`, и из текущего `cyberpunk2020-rilerena` namespace.
- System ID не менялся, поэтому существующий мир продолжает ссылаться на тот же game system во время core migration.

## Критерии production sign-off релиза

1. Полный automated suite и pack audit проходят без изменений рабочего дерева.
2. Чистый V14 world и копия V13 campaign world проходят manual checklist.
3. Region placement проверен GM и игроком, включая cancel/error/elevation/expiry.
4. Все обязательные модули включены партиями и проверены на V14; посторонние 79 установленных модулей не включаются автоматически.
5. Проверено восстановление V13 backup; downgrade migrated world не используется как rollback.
6. Release tag совпадает с `system.json.version`, а manifest ссылается на неизменяемый release archive.
