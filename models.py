import os
import psycopg2
import psycopg2.extras
import psycopg2.extensions


class PGConnWrapper:
    """Gives a psycopg2 connection sqlite3.Connection-style conn.execute(...),
    and closes the underlying connection on context exit. psycopg2 connections
    don't auto-close (unlike this codebase's old assumption, which was only
    safe because SQLite has no real per-connection resource cost) — without
    this, every request would leak a Postgres connection."""

    def __init__(self, pg_conn):
        self._conn = pg_conn

    def execute(self, sql, params=()):
        cur = self._conn.cursor()
        cur.execute(sql, params)
        return cur

    def __getattr__(self, name):
        return getattr(self._conn, name)

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        try:
            if exc_type is not None:
                self._conn.rollback()
            elif self._conn.get_transaction_status() == psycopg2.extensions.TRANSACTION_STATUS_INERROR:
                self._conn.rollback()
            else:
                self._conn.commit()
        finally:
            self._conn.close()
        return False


def get_db():
    conn = psycopg2.connect(
        host=os.environ['POSTGRES_HOST'],
        port=os.environ.get('POSTGRES_PORT', '5432'),
        dbname=os.environ['POSTGRES_DB'],
        user=os.environ['POSTGRES_USER'],
        password=os.environ['POSTGRES_PASSWORD'],
        cursor_factory=psycopg2.extras.DictCursor,
        connect_timeout=5,
    )
    return PGConnWrapper(conn)


def init_db():
    with get_db() as conn:
        conn.execute('''
            CREATE TABLE IF NOT EXISTS users (
                id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                email         TEXT NOT NULL UNIQUE,
                name          TEXT NOT NULL,
                password_hash TEXT NOT NULL,
                role          TEXT NOT NULL DEFAULT 'user'
            )
        ''')
        conn.execute('''
            CREATE TABLE IF NOT EXISTS workspaces (
                id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                name       TEXT NOT NULL UNIQUE,
                color      TEXT DEFAULT '#0052cc',
                created_at TEXT DEFAULT (to_char((now() AT TIME ZONE 'UTC') + interval '5 hours', 'YYYY-MM-DD HH24:MI:SS'))
            )
        ''')
        conn.execute('''
            CREATE TABLE IF NOT EXISTS boards (
                id           INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                name         TEXT NOT NULL,
                company      TEXT DEFAULT '',
                color        TEXT DEFAULT '#0052cc',
                workspace_id INTEGER REFERENCES workspaces(id) ON DELETE SET NULL,
                description  TEXT DEFAULT ''
            )
        ''')
        conn.execute('''
            CREATE TABLE IF NOT EXISTS board_access (
                user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
                PRIMARY KEY (user_id, board_id)
            )
        ''')
        conn.execute('''
            CREATE TABLE IF NOT EXISTS columns (
                id       INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
                name     TEXT NOT NULL,
                position INTEGER DEFAULT 0
            )
        ''')
        conn.execute('''
            CREATE TABLE IF NOT EXISTS cards (
                id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                column_id   INTEGER NOT NULL REFERENCES columns(id) ON DELETE CASCADE,
                title       TEXT NOT NULL,
                description TEXT DEFAULT '',
                label       TEXT DEFAULT '',
                label_color TEXT DEFAULT '',
                due_date    TEXT DEFAULT '',
                start_date  TEXT DEFAULT '',
                position    INTEGER DEFAULT 0,
                completed   INTEGER DEFAULT 0,
                created_at  TEXT DEFAULT (to_char((now() AT TIME ZONE 'UTC') + interval '5 hours', 'YYYY-MM-DD HH24:MI:SS'))
            )
        ''')
        conn.execute('''
            CREATE TABLE IF NOT EXISTS comments (
                id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                card_id    INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
                author     TEXT NOT NULL DEFAULT 'Пользователь',
                text       TEXT NOT NULL,
                created_at TEXT DEFAULT (to_char((now() AT TIME ZONE 'UTC') + interval '5 hours', 'YYYY-MM-DD HH24:MI:SS'))
            )
        ''')
        conn.execute('''
            CREATE TABLE IF NOT EXISTS attachments (
                id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                card_id     INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
                filename    TEXT NOT NULL,
                filesize    TEXT NOT NULL,
                filetype    TEXT NOT NULL,
                filepath    TEXT NOT NULL,
                uploaded_at TEXT DEFAULT (to_char((now() AT TIME ZONE 'UTC') + interval '5 hours', 'YYYY-MM-DD HH24:MI:SS'))
            )
        ''')
        conn.execute('''
            CREATE TABLE IF NOT EXISTS invites (
                id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                token       TEXT NOT NULL UNIQUE,
                email       TEXT NOT NULL,
                role        TEXT NOT NULL DEFAULT 'user',
                board_ids   TEXT DEFAULT '',
                created_by  TEXT NOT NULL,
                created_at  TEXT DEFAULT (to_char((now() AT TIME ZONE 'UTC') + interval '5 hours', 'YYYY-MM-DD HH24:MI:SS')),
                expires_at  TEXT DEFAULT '',
                used_at     TEXT DEFAULT ''
            )
        ''')
        conn.execute('''
            CREATE TABLE IF NOT EXISTS card_watchers (
                card_id    INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
                user_email TEXT NOT NULL,
                created_at TEXT DEFAULT (to_char((now() AT TIME ZONE 'UTC') + interval '5 hours', 'YYYY-MM-DD HH24:MI:SS')),
                PRIMARY KEY (card_id, user_email)
            )
        ''')
        conn.execute('''
            CREATE TABLE IF NOT EXISTS board_watchers (
                board_id   INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
                user_email TEXT NOT NULL,
                created_at TEXT DEFAULT (to_char((now() AT TIME ZONE 'UTC') + interval '5 hours', 'YYYY-MM-DD HH24:MI:SS')),
                PRIMARY KEY (board_id, user_email)
            )
        ''')
        conn.execute('''
            CREATE TABLE IF NOT EXISTS api_tokens (
                id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                user_email TEXT NOT NULL,
                name       TEXT NOT NULL DEFAULT '',
                token_hash TEXT NOT NULL UNIQUE,
                created_at TEXT DEFAULT (to_char((now() AT TIME ZONE 'UTC') + interval '5 hours', 'YYYY-MM-DD HH24:MI:SS')),
                last_used  TEXT DEFAULT ''
            )
        ''')
        conn.execute('''
            CREATE TABLE IF NOT EXISTS webhooks (
                id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                url        TEXT NOT NULL,
                events     TEXT NOT NULL DEFAULT '*',
                board_id   INTEGER DEFAULT 0,
                secret     TEXT NOT NULL DEFAULT '',
                active     INTEGER DEFAULT 1,
                created_by TEXT NOT NULL,
                created_at TEXT DEFAULT (to_char((now() AT TIME ZONE 'UTC') + interval '5 hours', 'YYYY-MM-DD HH24:MI:SS'))
            )
        ''')
        conn.execute('''
            CREATE TABLE IF NOT EXISTS slack_settings (
                id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                webhook_url TEXT NOT NULL DEFAULT '',
                board_id   INTEGER DEFAULT 0,
                events     TEXT NOT NULL DEFAULT '*',
                active     INTEGER DEFAULT 1,
                updated_at TEXT DEFAULT (to_char((now() AT TIME ZONE 'UTC') + interval '5 hours', 'YYYY-MM-DD HH24:MI:SS'))
            )
        ''')
        conn.execute('''
            CREATE TABLE IF NOT EXISTS automation_log (
                id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                rule_id    INTEGER,
                card_id    INTEGER,
                action     TEXT NOT NULL,
                details    TEXT DEFAULT '',
                created_at TEXT DEFAULT (to_char((now() AT TIME ZONE 'UTC') + interval '5 hours', 'YYYY-MM-DD HH24:MI:SS'))
            )
        ''')

        if conn.execute('SELECT COUNT(*) FROM boards').fetchone()[0] == 0:
            _seed(conn)
        if conn.execute('SELECT COUNT(*) FROM users').fetchone()[0] == 0:
            _seed_users(conn)


def _seed(conn):
    ws_data = [
        ('Компания А', '#0052cc'),
        ('Компания Б', '#6554c0'),
        ('Компания В', '#00875a'),
    ]
    ws_ids = {}
    for ws_name, ws_color in ws_data:
        cur = conn.execute('INSERT INTO workspaces (name, color) VALUES(%s,%s) RETURNING id', (ws_name, ws_color))
        ws_ids[ws_name] = cur.fetchone()['id']

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
            'INSERT INTO boards (name,company,color,workspace_id) VALUES(%s,%s,%s,%s)',
            (name, company, color, ws_ids.get(company))
        )

    col_ids = []
    for pos, name in enumerate(['📋 К выполнению', '🔄 В работе', '👁 На проверке', '✅ Готово']):
        cur = conn.execute('INSERT INTO columns (board_id,name,position) VALUES(1,%s,%s) RETURNING id', (name, pos))
        col_ids.append(cur.fetchone()['id'])

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
                'INSERT INTO cards (column_id,title,label,label_color,due_date,position) VALUES(%s,%s,%s,%s,%s,%s)',
                (col_id, title, label, color, due, pos)
            )


def _seed_users(conn):
    from werkzeug.security import generate_password_hash
    cur = conn.execute(
        "INSERT INTO users (email, name, password_hash, role) VALUES (%s,%s,%s,%s) RETURNING id",
        ('admin@almaly.kz', 'Администратор', generate_password_hash('admin123'), 'admin')
    )
    admin_id = cur.fetchone()['id']
    cur = conn.execute(
        "INSERT INTO users (email, name, password_hash, role) VALUES (%s,%s,%s,%s) RETURNING id",
        ('user@almaly.kz', 'Пользователь', generate_password_hash('user123'), 'user')
    )
    user_id = cur.fetchone()['id']

    for row in conn.execute('SELECT id FROM boards ORDER BY id LIMIT 2'):
        conn.execute(
            'INSERT INTO board_access (user_id, board_id) VALUES (%s,%s) ON CONFLICT DO NOTHING',
            (user_id, row['id'])
        )
