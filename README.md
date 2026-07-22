# Kanban App

Внутреннее Kanban-приложение (Trello-подобная доска задач) для Almaly AMC. Backend на Flask + SQLite, авторизация через Google Sheets с fallback на локальную БД.

## Возможности

- **Рабочие пространства (workspaces) и доски** — группировка досок по компаниям/проектам, свой цвет и фон у каждой доски.
- **Колонки и карточки** — drag-and-drop, изменение порядка, дублирование карточек, архив с восстановлением.
- **Карточки**: описание, метки (label + цвет), срок выполнения, чек-листы, комментарии, вложения, участники (members).
- **Профиль пользователя** — имя, цвет/фото аватара, смена пароля.
- **Экспорт в CSV** — по доске или по рабочему пространству.
- **Импорт из Trello** — см. `import_trello.py`.
- **Поиск** по карточкам (`/api/search`).
- **Права доступа** — админ видит все доски, обычный пользователь — только назначенные (`board_access` / столбец «Доски» в Google Sheets).
- **Мобильная адаптация** — панель фильтров и адаптивная сетка колонок.

## Стек

- Python 3.11, Flask
- SQLite (файл `kanban.db`, создаётся и мигрируется автоматически при старте)
- Google Sheets API (`gspread`) — опционально, для управления пользователями из таблицы
- Waitress — production WSGI-сервер (Windows)

## Структура проекта

```
app.py                  # роуты и бизнес-логика (Flask)
models.py               # схема SQLite, init_db(), сид тестовых данных
sheets.py               # интеграция с Google Sheets (пользователи и права)
import_trello.py        # импорт экспортированной доски Trello в БД
serve.py                # запуск через waitress (production)
requirements.txt
.env.example             # шаблон переменных окружения
DEPLOY_ROADMAP.md        # чек-лист и инструкции по развёртыванию на сервере
templates/               # HTML (Jinja2)
static/                  # CSS, JS, загруженные фоны досок
uploads/                 # вложения карточек (по board_id)
kanban.db                # база данных SQLite (создаётся автоматически)
google_credentials.json  # сервисный аккаунт Google (секрет, не в git)
google_oauth_client.json # не используется кодом — можно удалить, если не нужен
```

## Установка (локальный запуск)

```
pip install -r requirements.txt
```

Скопировать `.env.example` в `.env` и задать значения:

```
SECRET_KEY=<случайная строка 32+ символов>
GOOGLE_CREDENTIALS_PATH=google_credentials.json
USERS_SHEET_ID=<ID таблицы, опционально>
```

Сгенерировать `SECRET_KEY`:
```
python -c "import secrets; print(secrets.token_hex(32))"
```

Запуск для разработки:
```
python app.py
```
Приложение поднимется на `http://localhost:5001`. При первом запуске БД и тестовые данные создаются автоматически.

Запуск в режиме, близком к production (без debug, через waitress):
```
python serve.py
```

## Авторизация

Приложение поддерживает два режима, переключается автоматически:

1. **Google Sheets** (приоритетный) — активен, если задан `USERS_SHEET_ID` и существует файл из `GOOGLE_CREDENTIALS_PATH`. Структура листа: `Email | Имя | Пароль | Роль | Доски` (роль `admin`/`user`, «Доски» — ID через запятую или `*` для всех).
2. **Локальная SQLite** (fallback) — если Google Sheets не настроен.

## Импорт из Trello

```
python import_trello.py board-export.json --board-id 3
python import_trello.py board-export.json --board-id 3 --skip-archived
```

Экспорт доски из Trello: *Меню доски → Показать меню → Ещё → Печать и экспорт → Экспорт в JSON*. Доска с указанным `--board-id` должна уже существовать в приложении.

## Развёртывание на сервере

Полный чек-лист и варианты (Windows/Linux/VPS, WSGI, reverse proxy, бэкапы, мониторинг) — см. **`DEPLOY_ROADMAP.md`**.

Коротко для Windows:
```
pip install -r requirements.txt
python serve.py
```
Для автозапуска как службы Windows — NSSM (см. `DEPLOY_ROADMAP.md`, Фаза 4).

## Известные ограничения

- В `templates/board.html` пока не реализованы JS-функции профиля пользователя (аналогичный функционал уже есть в `boards.html`).
- Пароли в Google Sheets хранятся в открытом виде — приемлемо только если доступ к таблице ограничен администраторами.
