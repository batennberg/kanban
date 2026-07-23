import sqlite3, os

DB_PATH = os.path.join(os.path.dirname(__file__), 'kanban.db')

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA foreign_keys = ON')
    return conn

def init_db():
    with get_db() as conn:
        conn.executescript('''
            CREATE TABLE IF NOT EXISTS users (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                email         TEXT NOT NULL UNIQUE,
                name          TEXT NOT NULL,
                password_hash TEXT NOT NULL,
                role          TEXT NOT NULL DEFAULT 'user'
            );
            CREATE TABLE IF NOT EXISTS workspaces (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                name       TEXT NOT NULL UNIQUE,
                color      TEXT DEFAULT '#0052cc',
                created_at TEXT DEFAULT (datetime('now','localtime'))
            );
            CREATE TABLE IF NOT EXISTS boards (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                name         TEXT NOT NULL,
                company      TEXT DEFAULT '',
                color        TEXT DEFAULT '#0052cc',
                workspace_id INTEGER REFERENCES workspaces(id) ON DELETE SET NULL,
                description  TEXT DEFAULT ''
            );
            CREATE TABLE IF NOT EXISTS board_access (
                user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
                PRIMARY KEY (user_id, board_id)
            );
            CREATE TABLE IF NOT EXISTS columns (
                id       INTEGER PRIMARY KEY AUTOINCREMENT,
                board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
                name     TEXT NOT NULL,
                position INTEGER DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS cards (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                column_id   INTEGER NOT NULL REFERENCES columns(id) ON DELETE CASCADE,
                title       TEXT NOT NULL,
                description TEXT DEFAULT '',
                label       TEXT DEFAULT '',
                label_color TEXT DEFAULT '',
                due_date    TEXT DEFAULT '',
                start_date  TEXT DEFAULT '',
                position    INTEGER DEFAULT 0,
                completed   INTEGER DEFAULT 0,
                created_at  TEXT DEFAULT (datetime('now','localtime'))
            );
            CREATE TABLE IF NOT EXISTS comments (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                card_id    INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
                author     TEXT NOT NULL DEFAULT 'Пользователь',
                text       TEXT NOT NULL,
                created_at TEXT DEFAULT (datetime('now','localtime'))
            );
            CREATE TABLE IF NOT EXISTS attachments (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                card_id     INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
                filename    TEXT NOT NULL,
                filesize    TEXT NOT NULL,
                filetype    TEXT NOT NULL,
                filepath    TEXT NOT NULL,
                uploaded_at TEXT DEFAULT (datetime('now','localtime'))
            );
        ''')
        if conn.execute('SELECT COUNT(*) FROM boards').fetchone()[0] == 0:
            _seed(conn)
        if conn.execute('SELECT COUNT(*) FROM users').fetchone()[0] == 0:
            _seed_users(conn)

def _seed(conn):
    # Создаём workspaces
    ws_data = [
        ('Компания А', '#0052cc'),
        ('Компания Б', '#6554c0'),
        ('Компания В', '#00875a'),
    ]
    ws_ids = {}
    for ws_name, ws_color in ws_data:
        cur = conn.execute('INSERT INTO workspaces (name, color) VALUES(?,?)', (ws_name, ws_color))
        ws_ids[ws_name] = cur.lastrowid

    # Создаём доски с workspace_id
    boards = [
        ('IT-задачи',          'Компания А', '#0052cc'),
        ('Проекты клиента Б',  'Компания Б', '#6554c0'),
        ('Компания В — SMM',   'Компания В', '#00875a'),
        ('Инфраструктура',     'Компания А', '#de350b'),
        ('HR и кадры',         'Компания А', '#ff8b00'),
        ('Маркетинг',          'Компания Б', '#00b8d9'),
    ]
    for name, company, color in boards:
        conn.execute(
            'INSERT INTO boards (name,company,color,workspace_id) VALUES(?,?,?,?)',
            (name, company, color, ws_ids.get(company))
        )

    col_ids = []
    for pos, name in enumerate(['📋 К выполнению', '🔄 В работе', '👁 На проверке', '✅ Готово']):
        cur = conn.execute('INSERT INTO columns (board_id,name,position) VALUES(1,?,?)', (name, pos))
        col_ids.append(cur.lastrowid)

    seed = [
        (col_ids[0], [
            ('Обновить Wi-Fi точки доступа и контроллер', 'Сеть', '#0052cc', '01.07.2026'),
            ('Оформить подписки на ПО для отдела', 'ПО', '#6554c0', ''),
            ('Настроить сетевой контроллер', 'Сеть', '#0052cc', ''),
            ('Найти оборудование для видеоконференций', 'Железо', '#de350b', ''),
        ]),
        (col_ids[1], [
            ('HelpDesk бот — авторизация', 'Разработка', '#de350b', '01.07.2026'),
            ('FAQ: дописать 6 инструкций', 'Контент', '#00875a', '01.07.2026'),
        ]),
        (col_ids[2], [
            ('Подпись для писем — клиент Б', 'Email', '#ff8b00', ''),
        ]),
        (col_ids[3], [
            ('Ноутбуки для новых сотрудников', 'Железо', '#00875a', ''),
            ('Выгрузить почту уволенного сотрудника', 'Google', '#0052cc', ''),
            ('Заблокировать учётную запись уволенного сотрудника', 'Безопасность', '#de350b', ''),
        ]),
    ]
    for col_id, cards in seed:
        for pos, (title, label, color, due) in enumerate(cards):
            conn.execute(
                'INSERT INTO cards (column_id,title,label,label_color,due_date,position) VALUES(?,?,?,?,?,?)',
                (col_id, title, label, color, due, pos)
            )

def _seed_users(conn):
    from werkzeug.security import generate_password_hash
    cur = conn.execute(
        "INSERT INTO users (email, name, password_hash, role) VALUES (?,?,?,?)",
        ('admin@almaly.kz', 'Администратор', generate_password_hash('admin123'), 'admin')
    )
    admin_id = cur.lastrowid
    cur = conn.execute(
        "INSERT INTO users (email, name, password_hash, role) VALUES (?,?,?,?)",
        ('user@almaly.kz', 'Пользователь', generate_password_hash('user123'), 'user')
    )
    user_id = cur.lastrowid

    # Даём пользователю доступ к первым двум доскам
    for row in conn.execute('SELECT id FROM boards ORDER BY id LIMIT 2'):
        conn.execute(
            'INSERT OR IGNORE INTO board_access (user_id, board_id) VALUES (?,?)',
            (user_id, row['id'])
        )
