# SQLite → PostgreSQL Code Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the kanban app's data layer from raw `sqlite3` to PostgreSQL (`psycopg2`), with zero behavior change visible to users, so the app runs correctly against Postgres — as a standalone milestone, before any Docker/Linux work begins.

**Architecture:** Direct SQL-dialect port (spec's "Approach A" — no ORM). `models.py:get_db()` returns a thin wrapper around a `psycopg2` connection that preserves the existing `conn.execute(...)` calling convention and `row['col']`/`dict(row)`/`row[0]` access patterns used throughout `app.py`, so ~594 call sites only need their SQL *text* changed, not their calling code.

**Tech Stack:** Python 3.11, Flask, `psycopg2` (replaces `sqlite3`), PostgreSQL 16 (local dev instance via `docker run`, no compose yet — that's a separate follow-up plan).

**Spec:** `docs/superpowers/specs/2026-11-10-postgres-docker-migration-design.md`

**Scope note:** This plan covers the *code and schema* migration only — making the app run correctly against Postgres, with a tested data-migration script. Dockerizing the app (`Dockerfile`, `docker-compose.yml`), moving to the Linux server, and the real production cutover window are a **separate follow-up plan** (per the spec's own phasing: "сначала Postgres, потом Docker"), written after this one is implemented and working. This plan's own scope check: it is one coherent subsystem (the data layer), not several independent ones, so it stays as a single plan.

## Global Constraints

- No ORM / query builder (SQLAlchemy etc.) — direct `psycopg2` port only, per spec's "Approach A".
- Timestamp strings use a fixed `UTC+5` offset: `to_char((now() AT TIME ZONE 'UTC') + interval '5 hours', 'YYYY-MM-DD HH24:MI:SS')` — never a named IANA zone, never relying on host OS timezone.
- `completed`, `archived`, `active`, `is_read`, `enabled`, `checked`, `show_on_card` and similar flags stay `INTEGER` (0/1) — do **not** convert to native Postgres `BOOLEAN`.
- `attachments.filepath` changes meaning from an absolute filesystem path to a path *relative to* `UPLOAD_FOLDER` — every read site must be updated alongside the write site (spec finding).
- Existing row IDs must be preserved exactly during data migration (foreign keys depend on them) — no identity renumbering.
- Cursor factory is `psycopg2.extras.DictCursor` (not `RealDictCursor` — see Task 2 for why: this codebase uses both `row['col']` *and* `row[0]` positional access in ~15 places, and only `DictCursor`'s `DictRow` supports both without touching those call sites).

## Review Focus

- **Case-sensitive `LIKE` regression in free-text search** (`/api/search`, `app.py` ~line 4509): SQLite's `LIKE` case-folds ASCII; Postgres's does not. Latin-text searches that worked regardless of case before will silently return fewer results after the port. Pinned in Task 15.
- **`RETURNING id` must be read from the same cursor object the `INSERT` was run on**, before that cursor is reused for anything else — a copy-paste mistake silently returns the wrong id. Pinned in Task 11 (one create-and-verify-id check per converted route, via the running app, not just a syntax check).
- **Timestamp string format drift**: `to_char(...)` must produce the *exact* shape `YYYY-MM-DD HH24:MI:SS` (zero-padded) that templates/JS already parse as plain text — a subtly wrong format string breaks date rendering with no error thrown. Pinned in Task 4 with an explicit regex check against a real generated value.
- **ETL script is not resumable**: if `migrate_to_postgres.py` fails partway through the ordered table list, the Postgres database is left half-populated (some tables committed, later ones not). Re-running it without first truncating already-migrated tables will crash on primary-key conflicts. Documented and guarded explicitly in Task 17 — not something to "fix" by adding idempotency (out of scope — this is a one-shot script for a single cutover, see spec), but something the runbook step must call out so a retry doesn't quietly corrupt data.
- **Dynamic placeholder generation sites** (`','.join('?' * len(x))`, 15 occurrences in `app.py`): a naive text-level regex replace of `?` → `%s` does **not** fix these, because `'%s' * n` is not the same string shape as `'?' * n` (two characters vs one) — `','.join('%s' * 3)` produces `'%,s,%,s,%,s'`, not `'%s,%s,%s'`. These need their own explicit rewrite to `','.join(['%s'] * len(x))`, pinned as its own step in Task 3.

---

## Task 1: Local Postgres dev environment

**Files:**
- Modify: `requirements.txt`
- Modify: `.env.example`
- Create/modify: `.env` (local only, already gitignored — confirm, don't commit)

**Interfaces:**
- Produces: a running local Postgres instance + env vars (`POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`) that every later task's `get_db()` work depends on.

- [ ] **Step 1: Add the Postgres driver dependency**

Edit `requirements.txt`, add one line:
```
psycopg2-binary>=2.9.9
```

- [ ] **Step 2: Install it**

Run: `pip install -r requirements.txt`
Expected: `psycopg2-binary` installs without error.

- [ ] **Step 3: Start a local Postgres container for development**

Run:
```bash
docker run -d --name kanban-pg-dev \
  -e POSTGRES_DB=kanban \
  -e POSTGRES_USER=kanban \
  -e POSTGRES_PASSWORD=devpass \
  -p 5432:5432 \
  postgres:16
```
Expected: container starts; `docker ps` shows `kanban-pg-dev` as `Up`.

- [ ] **Step 4: Add Postgres env vars**

Add to `.env.example`:
```
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_DB=kanban
POSTGRES_USER=kanban
POSTGRES_PASSWORD=
```
Add the same to your local `.env`, with the real dev password (`devpass` from Step 3).

- [ ] **Step 5: Verify connectivity**

Run:
```bash
python -c "
import os, psycopg2
from dotenv import load_dotenv
load_dotenv()
conn = psycopg2.connect(
    host=os.environ['POSTGRES_HOST'], port=os.environ['POSTGRES_PORT'],
    dbname=os.environ['POSTGRES_DB'], user=os.environ['POSTGRES_USER'],
    password=os.environ['POSTGRES_PASSWORD'],
)
print(conn.server_version)
conn.close()
"
```
Expected: prints a version number (e.g. `160001`), no exception.

- [ ] **Step 6: Commit**

```bash
git add requirements.txt .env.example
git commit -m "Add psycopg2 dependency and Postgres env vars for local dev"
```

---

## Task 2: Port `models.py` (`get_db`, `init_db`, seed functions)

**Files:**
- Modify: `models.py` (entire file — it's 216 lines, small enough to rewrite wholesale)

**Interfaces:**
- Consumes: `POSTGRES_*` env vars from Task 1.
- Produces: `get_db()` returning a `PGConnWrapper` that every later task (and all of `app.py`) calls as `with get_db() as conn: conn.execute(sql, params)` — this exact signature is what Tasks 3–17 build on. `init_db()` creates the base schema; `_seed()`/`_seed_users()` unchanged in behavior.

**Why `DictCursor`, not `RealDictCursor`:** `app.py` has ~15 call sites doing `conn.execute(...).fetchone()[0]` (positional access, e.g. `SELECT COUNT(*) FROM boards`). `psycopg2.extras.RealDictRow` is dict-only and does not support `row[0]`. `psycopg2.extras.DictRow` (from `DictCursor`) supports *both* `row[0]` and `row['col']`, and is `dict()`-convertible — so neither the 15 positional sites nor the hundreds of `row['col']`/`dict(row)` sites need to change.

- [ ] **Step 1: Write the new `models.py`**

```python
import os
import psycopg2
import psycopg2.extras


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
            if exc_type is None:
                self._conn.commit()
            else:
                self._conn.rollback()
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
```

- [ ] **Step 2: Reset the dev database and verify schema creation**

```bash
docker exec kanban-pg-dev psql -U kanban -d kanban -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
python -c "
from dotenv import load_dotenv; load_dotenv()
from models import init_db
init_db()
print('init_db OK')
"
```
Expected: prints `init_db OK`, no traceback.

- [ ] **Step 3: Verify the seed data and both access patterns work**

```bash
python -c "
from dotenv import load_dotenv; load_dotenv()
from models import get_db
with get_db() as conn:
    row = conn.execute('SELECT COUNT(*) FROM boards').fetchone()
    print('positional access row[0]:', row[0])
    row2 = conn.execute('SELECT * FROM boards LIMIT 1').fetchone()
    print('key access row[\"name\"]:', row2['name'])
    print('dict(row):', dict(row2)['name'])
"
```
Expected: prints `positional access row[0]: 6`, the first board's name twice, no exception. This confirms `DictCursor` supports both access styles — the core assumption every later task depends on.

- [ ] **Step 4: Commit**

```bash
git add models.py
git commit -m "Port models.py to PostgreSQL (psycopg2, DictCursor-based get_db wrapper)"
```

---

## Task 3: Mechanical `?` → `%s` placeholder port across `app.py`

**Files:**
- Create: `scratch_convert_placeholders.py` (temporary, delete after use — not committed)
- Modify: `app.py`

**Interfaces:**
- Consumes: nothing new.
- Produces: `app.py` with all SQL placeholders in `psycopg2` form. Tasks 4–14 assume this is already done — they do not re-touch `?` syntax.

**Important:** after this task, `python app.py` will **not** yet run successfully — `migrate_db()` still contains SQLite-only DDL syntax (`AUTOINCREMENT`, `datetime('now','localtime')`, `sqlite3.OperationalError`) that Tasks 4–10 fix next. This task's own verification is narrower (syntax + placeholder completeness), not a full app run.

- [ ] **Step 1: Fix the 15 dynamic placeholder-generation sites**

These build a `?,?,?` string via `'?' * len(x)`, which does not become `%s,%s,%s` under a naive character-level replace (the generic Task Step 3 script below would silently break these). Fix them first, by hand, at these exact `app.py` line numbers (before any other port work shifts line numbers): **724, 798, 822, 882, 916, 928, 970, 1007, 1061, 1276, 1279, 2411, 4306, 4533, 4691**.

Each follows the same shape. Example (line 724):
```python
# before
ph   = ','.join('?' * len(board_ids))
# after
ph   = ','.join(['%s'] * len(board_ids))
```
Apply the identical transform — replace `'?' * len(X)` with `['%s'] * len(X)` — at each of the 15 lines listed above. The variable name on the left of `=` differs (`ph` vs `placeholders`) but the right-hand side pattern is identical everywhere.

- [ ] **Step 2: Verify no dynamic-placeholder sites remain**

Run: `grep -n "'?' \* len" app.py`
Expected: no output (empty).

- [ ] **Step 3: Write and run the mechanical conversion script for literal `?` placeholders**

Create `scratch_convert_placeholders.py`:
```python
#!/usr/bin/env python3
"""One-off: converts literal '?' placeholders to '%s' inside the SQL-string
argument of conn.execute(...) / conn.executemany(...) calls. Run once, then
review the full diff by hand before committing. Delete this file afterward —
it is not part of the application."""
import re
import sys

PATTERN = re.compile(
    r"(conn\.execute(?:many)?\(\s*(?:f?'''.*?'''|f?\"\"\".*?\"\"\"|f?'[^']*'|f?\"[^\"]*\"))",
    re.DOTALL,
)


def convert(text):
    def repl(m):
        return m.group(1).replace('?', '%s')
    return PATTERN.sub(repl, text)


for path in sys.argv[1:]:
    with open(path, encoding='utf-8') as f:
        original = f.read()
    converted = convert(original)
    with open(path, 'w', encoding='utf-8') as f:
        f.write(converted)
    print(f'{path}: converted — review the diff by hand before committing')
```

Run: `python scratch_convert_placeholders.py app.py`
Expected: prints `app.py: converted — review the diff by hand before committing`.

- [ ] **Step 4: Review the diff by hand**

Run: `git diff app.py | less`

Check for each hunk: the only character changed is `?` → `%s` inside a SQL string that was passed to `conn.execute`/`conn.executemany`. Watch specifically for:
- Any `?` that was inside a *comment* or a *non-SQL string* accidentally caught by the regex (unlikely given the pattern requires `conn.execute(` directly before the string, but check).
- Lines the regex *missed* because the SQL string wasn't a simple literal right after `execute(` (e.g., built from a variable) — grep for these next.

- [ ] **Step 5: Find any remaining un-converted placeholders**

Run: `grep -n "conn\.execute" app.py | grep "?"`
Expected: no output. If there is output, the regex missed that call site (e.g. SQL built into a variable first, then passed to `execute`) — fix it by hand, following the same `?` → `%s` substitution.

- [ ] **Step 6: Verify the file still compiles**

Run: `python -m py_compile app.py`
Expected: no output, exit code 0.

- [ ] **Step 7: Clean up and commit**

```bash
rm scratch_convert_placeholders.py
git add app.py
git commit -m "Convert SQL placeholders from '?' (sqlite) to '%s' (psycopg2) across app.py"
```

---

## Task 4: `migrate_db()` block 1 — legacy ALTERs + workspaces (`app.py` ~3977–4052)

**Files:**
- Modify: `app.py:3977-4052` (function `migrate_db`, its opening section)

**Interfaces:**
- Consumes: `get_db()` from Task 2, placeholder-converted SQL from Task 3.
- Produces: `users`/`cards`/`columns` extra columns, `card_members`/`checklist_items` tables, `workspaces` table + backfill — all idempotent against Postgres. Later blocks (Tasks 5–10) continue appending to the same `migrate_db()` function body.

- [ ] **Step 1: Replace the function's opening section**

In `app.py`, replace from `def migrate_db():` through the end of the workspaces backfill (just before `# ── Множественные именованные чек-листы`) with:

```python
def migrate_db():
    with get_db() as conn:
        for stmt in [
            "ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_color  TEXT DEFAULT '#4361EE'",
            "ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_photo  TEXT",
            "ALTER TABLE cards ADD COLUMN IF NOT EXISTS completed        INTEGER DEFAULT 0",
            "ALTER TABLE cards ADD COLUMN IF NOT EXISTS cover_color      TEXT    DEFAULT ''",
            "ALTER TABLE cards ADD COLUMN IF NOT EXISTS linked_board_id  INTEGER REFERENCES boards(id) ON DELETE SET NULL",
            "ALTER TABLE cards ADD COLUMN IF NOT EXISTS archived         INTEGER DEFAULT 0",
            "ALTER TABLE cards ADD COLUMN IF NOT EXISTS archived_at      TEXT",
            "ALTER TABLE cards ADD COLUMN IF NOT EXISTS start_date       TEXT    DEFAULT ''",
            "ALTER TABLE cards ADD COLUMN IF NOT EXISTS importance       TEXT    DEFAULT ''",
            "ALTER TABLE columns ADD COLUMN IF NOT EXISTS archived       INTEGER DEFAULT 0",
            "ALTER TABLE columns ADD COLUMN IF NOT EXISTS archived_at    TEXT",
            "ALTER TABLE columns ADD COLUMN IF NOT EXISTS wip_limit      INTEGER DEFAULT 0",
            '''CREATE TABLE IF NOT EXISTS card_members (
                id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                card_id    INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
                user_email TEXT    NOT NULL,
                user_name  TEXT    NOT NULL DEFAULT '',
                UNIQUE(card_id, user_email)
            )''',
            '''CREATE TABLE IF NOT EXISTS checklist_items (
                id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                card_id    INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
                text       TEXT    NOT NULL,
                checked    INTEGER DEFAULT 0,
                position   INTEGER DEFAULT 0,
                created_at TEXT    DEFAULT (to_char((now() AT TIME ZONE 'UTC') + interval '5 hours', 'YYYY-MM-DD HH24:MI:SS'))
            )''',
        ]:
            conn.execute(stmt)

        # ── Workspaces (шаг 1) ──
        conn.execute('''
            CREATE TABLE IF NOT EXISTS workspaces (
                id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                name       TEXT NOT NULL UNIQUE,
                color      TEXT DEFAULT '#0052cc',
                created_at TEXT DEFAULT (to_char((now() AT TIME ZONE 'UTC') + interval '5 hours', 'YYYY-MM-DD HH24:MI:SS'))
            )
        ''')
        for col_stmt in [
            "ALTER TABLE boards ADD COLUMN IF NOT EXISTS workspace_id INTEGER REFERENCES workspaces(id) ON DELETE SET NULL",
            "ALTER TABLE boards ADD COLUMN IF NOT EXISTS description  TEXT DEFAULT ''",
            "ALTER TABLE boards ADD COLUMN IF NOT EXISTS bg_image     TEXT",
        ]:
            conn.execute(col_stmt)

        companies = conn.execute(
            "SELECT company, MIN(color) as color FROM boards "
            "WHERE company != '' AND company IS NOT NULL "
            "GROUP BY company ORDER BY MIN(id)"
        ).fetchall()
        for row in companies:
            conn.execute(
                'INSERT INTO workspaces (name, color) VALUES (%s, %s) ON CONFLICT (name) DO NOTHING',
                (row['company'], row['color'])
            )

        conn.execute('''
            UPDATE boards
            SET workspace_id = (
                SELECT id FROM workspaces WHERE workspaces.name = boards.company
            )
            WHERE workspace_id IS NULL AND company != '' AND company IS NOT NULL
        ''')
```

- [ ] **Step 2: Run it against the local dev Postgres and verify idempotency**

```bash
docker exec kanban-pg-dev psql -U kanban -d kanban -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
python -c "
from dotenv import load_dotenv; load_dotenv()
from models import init_db
init_db()
import importlib, app as app_module
importlib.reload(app_module)
app_module.migrate_db()
app_module.migrate_db()  # run twice — must not error
print('migrate_db block 1 OK (twice, idempotent)')
"
```
Expected: prints `migrate_db block 1 OK (twice, idempotent)`. (This will currently fail partway through, because the rest of `migrate_db()` — not yet ported — still has SQLite-only syntax below this point. For this task, instead run the equivalent check by temporarily truncating the function body in a scratch copy, or simply confirm via `python -m py_compile app.py` plus a manual read of the block — full end-to-end `migrate_db()` execution is the Task 10 verification, once every block is ported.)

- [ ] **Step 3: Verify the exact timestamp format (Review Focus item)**

```bash
docker exec kanban-pg-dev psql -U kanban -d kanban -c \
  "SELECT to_char((now() AT TIME ZONE 'UTC') + interval '5 hours', 'YYYY-MM-DD HH24:MI:SS');"
```
Expected: one row, format exactly `YYYY-MM-DD HH24:MI:SS` shaped, e.g. `2026-11-10 14:32:07` — verify with:
```bash
python -c "
import re
s = '2026-11-10 14:32:07'  # paste the psql output here
assert re.match(r'^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\$', s), 'format mismatch!'
print('timestamp format OK')
"
```

- [ ] **Step 4: Commit**

```bash
git add app.py
git commit -m "Port migrate_db() block 1 (legacy ALTERs + workspaces) to Postgres"
```

---

## Task 5: `migrate_db()` block 2 — checklists/labels/links/mentions/inbox (`app.py` ~4054–4154)

**Files:**
- Modify: `app.py` (continues `migrate_db()`, section immediately after Task 4's block)

- [ ] **Step 1: Replace the section**

Replace from `# ── Множественные именованные чек-листы` through the `board_access.expires_at` ALTER (just before `# ── История активности карточки`) with:

```python
        # ── Множественные именованные чек-листы + срок/исполнитель на пункт ──
        conn.execute('''
            CREATE TABLE IF NOT EXISTS checklists (
                id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                card_id    INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
                title      TEXT NOT NULL DEFAULT 'Чек-лист',
                position   INTEGER DEFAULT 0,
                created_at TEXT DEFAULT (to_char((now() AT TIME ZONE 'UTC') + interval '5 hours', 'YYYY-MM-DD HH24:MI:SS'))
            )
        ''')
        for col_stmt in [
            "ALTER TABLE checklist_items ADD COLUMN IF NOT EXISTS checklist_id   INTEGER REFERENCES checklists(id) ON DELETE CASCADE",
            "ALTER TABLE checklist_items ADD COLUMN IF NOT EXISTS due_date       TEXT DEFAULT ''",
            "ALTER TABLE checklist_items ADD COLUMN IF NOT EXISTS assignee_email TEXT DEFAULT ''",
            "ALTER TABLE checklist_items ADD COLUMN IF NOT EXISTS assignee_name  TEXT DEFAULT ''",
        ]:
            conn.execute(col_stmt)

        orphan_cards = conn.execute(
            'SELECT DISTINCT card_id FROM checklist_items WHERE checklist_id IS NULL'
        ).fetchall()
        for row in orphan_cards:
            cid = row['card_id']
            cur = conn.execute(
                "INSERT INTO checklists (card_id, title, position) VALUES (%s,%s,0) RETURNING id",
                (cid, 'Чек-лист')
            )
            new_checklist_id = cur.fetchone()['id']
            conn.execute(
                'UPDATE checklist_items SET checklist_id=%s WHERE card_id=%s AND checklist_id IS NULL',
                (new_checklist_id, cid)
            )

        # ── Множественные метки на карточке ──
        conn.execute('''
            CREATE TABLE IF NOT EXISTS card_labels (
                id       INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                card_id  INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
                name     TEXT NOT NULL DEFAULT '',
                color    TEXT NOT NULL DEFAULT '',
                position INTEGER DEFAULT 0,
                UNIQUE(card_id, name)
            )
        ''')
        conn.execute('''
            INSERT INTO card_labels (card_id, name, color, position)
            SELECT id, label, label_color, 0 FROM cards
            WHERE TRIM(COALESCE(label, '')) != ''
            ON CONFLICT (card_id, name) DO NOTHING
        ''')

        # ── Несколько ссылок на карточке (Google Drive и т.п.) ──
        conn.execute('''
            CREATE TABLE IF NOT EXISTS card_links (
                id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                card_id    INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
                url        TEXT    NOT NULL,
                title      TEXT    NOT NULL DEFAULT '',
                position   INTEGER DEFAULT 0,
                created_at TEXT    DEFAULT (to_char((now() AT TIME ZONE 'UTC') + interval '5 hours', 'YYYY-MM-DD HH24:MI:SS'))
            )
        ''')
        conn.execute('''
            CREATE TABLE IF NOT EXISTS comment_mentions (
                id                INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                comment_id        INTEGER NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
                mentioned_email  TEXT    NOT NULL,
                mentioned_name   TEXT    NOT NULL DEFAULT '',
                created_at       TEXT    DEFAULT (to_char((now() AT TIME ZONE 'UTC') + interval '5 hours', 'YYYY-MM-DD HH24:MI:SS')),
                UNIQUE(comment_id, mentioned_email)
            )
        ''')
        conn.execute('''
            CREATE TABLE IF NOT EXISTS inbox_entries (
                id             INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                recipient_email TEXT    NOT NULL,
                type           TEXT    NOT NULL DEFAULT 'comment_mention',
                card_id        INTEGER NOT NULL,
                comment_id     INTEGER,
                payload        TEXT,
                is_read        INTEGER DEFAULT 0,
                created_at     TEXT    DEFAULT (to_char((now() AT TIME ZONE 'UTC') + interval '5 hours', 'YYYY-MM-DD HH24:MI:SS'))
            )
        ''')
        conn.execute('ALTER TABLE inbox_entries ADD COLUMN IF NOT EXISTS board_id INTEGER')
        conn.execute('ALTER TABLE board_access ADD COLUMN IF NOT EXISTS expires_at TEXT')
```

Note: `card_labels`'s one-time backfill changed from `INSERT OR IGNORE` to `INSERT ... ON CONFLICT (card_id, name) DO NOTHING` — this is one of the spec's 17 `INSERT OR IGNORE` sites, already handled here since it's inside this `migrate_db()` block (Task 12 covers the remaining 15 sites that live in regular route handlers, not in `migrate_db()`).

- [ ] **Step 2: Verify this block's DDL is syntactically valid Postgres**

```bash
docker exec kanban-pg-dev psql -U kanban -d kanban -c "\d checklists" 2>&1 | head -5
```
(Run after Task 10 completes and `migrate_db()` runs fully — for now, confirm via `python -m py_compile app.py`.)

- [ ] **Step 3: Commit**

```bash
git add app.py
git commit -m "Port migrate_db() block 2 (checklists/labels/links/mentions/inbox) to Postgres"
```

---

## Task 6: `migrate_db()` block 3 — activity/custom fields/mirrors/automation/relations (`app.py` ~4155–4227)

**Files:**
- Modify: `app.py` (continues `migrate_db()`)

- [ ] **Step 1: Replace the section**

Replace from `# ── История активности карточки` through the `card_relations` table (just before `# ── Шаблоны досок`) with:

```python
        # ── История активности карточки (audit) ──
        conn.execute('''
            CREATE TABLE IF NOT EXISTS card_activity (
                id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                card_id    INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
                event_type TEXT    NOT NULL,
                actor_name TEXT    NOT NULL DEFAULT '',
                detail     TEXT    NOT NULL DEFAULT '',
                created_at TEXT    DEFAULT (to_char((now() AT TIME ZONE 'UTC') + interval '5 hours', 'YYYY-MM-DD HH24:MI:SS'))
            )
        ''')

        # ── Кастомные поля ──
        conn.execute('''
            CREATE TABLE IF NOT EXISTS custom_fields (
                id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                board_id      INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
                name          TEXT    NOT NULL,
                type          TEXT    NOT NULL,
                options       TEXT    NOT NULL DEFAULT '',
                show_on_card  INTEGER NOT NULL DEFAULT 0,
                position      INTEGER NOT NULL DEFAULT 0
            )
        ''')
        conn.execute('''
            CREATE TABLE IF NOT EXISTS card_custom_field_values (
                id       INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                card_id  INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
                field_id INTEGER NOT NULL REFERENCES custom_fields(id) ON DELETE CASCADE,
                value    TEXT    NOT NULL DEFAULT '',
                UNIQUE(card_id, field_id)
            )
        ''')

        # ── Зеркальные карточки (Should №30) ──
        conn.execute('''
            CREATE TABLE IF NOT EXISTS card_mirrors (
                id             INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                source_card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
                column_id      INTEGER NOT NULL REFERENCES columns(id) ON DELETE CASCADE,
                position       INTEGER DEFAULT 0,
                created_at     TEXT    DEFAULT (to_char((now() AT TIME ZONE 'UTC') + interval '5 hours', 'YYYY-MM-DD HH24:MI:SS'))
            )
        ''')

        # ── Автоматизация по триггеру (Should №52) ──
        conn.execute('''
            CREATE TABLE IF NOT EXISTS automation_rules (
                id                INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                board_id          INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
                name              TEXT    NOT NULL DEFAULT '',
                trigger_column_id INTEGER NOT NULL REFERENCES columns(id) ON DELETE CASCADE,
                action_type       TEXT    NOT NULL,
                action_value      TEXT    DEFAULT '',
                enabled           INTEGER DEFAULT 1,
                created_at        TEXT    DEFAULT (to_char((now() AT TIME ZONE 'UTC') + interval '5 hours', 'YYYY-MM-DD HH24:MI:SS'))
            )
        ''')

        # ── Двусторонняя связь карточка↔карточка (Should №31) ──
        conn.execute('''
            CREATE TABLE IF NOT EXISTS card_relations (
                id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                card_a_id  INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
                card_b_id  INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
                created_at TEXT    DEFAULT (to_char((now() AT TIME ZONE 'UTC') + interval '5 hours', 'YYYY-MM-DD HH24:MI:SS')),
                UNIQUE(card_a_id, card_b_id)
            )
        ''')
```

- [ ] **Step 2: Commit**

```bash
git add app.py
git commit -m "Port migrate_db() block 3 (activity/custom_fields/mirrors/automation/relations) to Postgres"
```

---

## Task 7: `migrate_db()` block 4 — board & card templates (`app.py` ~4229–4300)

**Files:**
- Modify: `app.py` (continues `migrate_db()`)

- [ ] **Step 1: Replace the section**

Replace from `# ── Шаблоны досок (Should №9)` through `card_template_custom_fields` (just before the importance-migration comment) with:

```python
        # ── Шаблоны досок (Should №9) ──
        conn.execute('''
            CREATE TABLE IF NOT EXISTS board_templates (
                id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                name       TEXT    NOT NULL,
                created_at TEXT    DEFAULT (to_char((now() AT TIME ZONE 'UTC') + interval '5 hours', 'YYYY-MM-DD HH24:MI:SS'))
            )
        ''')
        conn.execute('''
            CREATE TABLE IF NOT EXISTS board_template_columns (
                id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                template_id INTEGER NOT NULL REFERENCES board_templates(id) ON DELETE CASCADE,
                name        TEXT    NOT NULL,
                position    INTEGER DEFAULT 0
            )
        ''')
        conn.execute('''
            CREATE TABLE IF NOT EXISTS board_template_custom_fields (
                id           INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                template_id  INTEGER NOT NULL REFERENCES board_templates(id) ON DELETE CASCADE,
                name         TEXT    NOT NULL,
                type         TEXT    NOT NULL,
                options      TEXT    DEFAULT '',
                show_on_card INTEGER DEFAULT 0,
                position     INTEGER DEFAULT 0
            )
        ''')

        # ── Шаблоны карточек (Should №10) ──
        conn.execute('''
            CREATE TABLE IF NOT EXISTS card_templates (
                id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                board_id    INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
                name        TEXT    NOT NULL,
                title       TEXT    NOT NULL DEFAULT '',
                description TEXT    DEFAULT '',
                importance  TEXT    DEFAULT '',
                created_at  TEXT    DEFAULT (to_char((now() AT TIME ZONE 'UTC') + interval '5 hours', 'YYYY-MM-DD HH24:MI:SS'))
            )
        ''')
        conn.execute('''
            CREATE TABLE IF NOT EXISTS card_template_labels (
                id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                template_id INTEGER NOT NULL REFERENCES card_templates(id) ON DELETE CASCADE,
                name        TEXT    NOT NULL DEFAULT '',
                color       TEXT    NOT NULL DEFAULT ''
            )
        ''')
        conn.execute('''
            CREATE TABLE IF NOT EXISTS card_template_checklists (
                id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                template_id INTEGER NOT NULL REFERENCES card_templates(id) ON DELETE CASCADE,
                title       TEXT    NOT NULL DEFAULT 'Чек-лист',
                position    INTEGER DEFAULT 0
            )
        ''')
        conn.execute('''
            CREATE TABLE IF NOT EXISTS card_template_checklist_items (
                id                     INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                template_checklist_id  INTEGER NOT NULL REFERENCES card_template_checklists(id) ON DELETE CASCADE,
                text                   TEXT    NOT NULL,
                position               INTEGER DEFAULT 0
            )
        ''')
        conn.execute('''
            CREATE TABLE IF NOT EXISTS card_template_custom_fields (
                id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                template_id INTEGER NOT NULL REFERENCES card_templates(id) ON DELETE CASCADE,
                field_id    INTEGER NOT NULL REFERENCES custom_fields(id) ON DELETE CASCADE,
                value       TEXT    DEFAULT ''
            )
        ''')
```

- [ ] **Step 2: Commit**

```bash
git add app.py
git commit -m "Port migrate_db() block 4 (board & card templates) to Postgres"
```

---

## Task 8: `migrate_db()` block 5 — importance data transform + ALTERs (`app.py` ~4302–4353)

**Files:**
- Modify: `app.py` (continues `migrate_db()`)

- [ ] **Step 1: Replace the section**

Replace from `# ── Разовый перенос меток-приоритетов` through the `target_board_id` ALTER (just before `# ── Реакции на комментариях`) with:

```python
        # ── Разовый перенос меток-приоритетов (введённых временно 27.07) в cards.importance ──
        placeholders = ','.join(['%s'] * len(IMPORTANCE_LEVELS))
        importance_rows = conn.execute(
            f'SELECT card_id, name FROM card_labels WHERE name IN ({placeholders}) ORDER BY id DESC',
            [l['name'] for l in IMPORTANCE_LEVELS]
        ).fetchall()
        seen_cards = set()
        for row in importance_rows:
            if row['card_id'] in seen_cards:
                continue
            seen_cards.add(row['card_id'])
            conn.execute('UPDATE cards SET importance=%s WHERE id=%s', (row['name'], row['card_id']))
        conn.execute(
            f'DELETE FROM card_labels WHERE name IN ({placeholders})',
            [l['name'] for l in IMPORTANCE_LEVELS]
        )

        # ── Повторяющиеся карточки (Should №60) ──
        conn.execute("ALTER TABLE cards ADD COLUMN IF NOT EXISTS repeat_pattern TEXT DEFAULT ''")

        # ── Автоматизация по приближению срока (Should №55) ──
        conn.execute("ALTER TABLE automation_rules ADD COLUMN IF NOT EXISTS trigger_type TEXT DEFAULT 'column'")
        conn.execute("ALTER TABLE automation_rules ADD COLUMN IF NOT EXISTS trigger_value TEXT DEFAULT ''")

        # ── Условия в правилах (Should №56) ──
        conn.execute("ALTER TABLE automation_rules ADD COLUMN IF NOT EXISTS condition_type TEXT DEFAULT 'none'")
        conn.execute("ALTER TABLE automation_rules ADD COLUMN IF NOT EXISTS condition_value TEXT DEFAULT ''")

        # ── Автоматизация между досками (Should №57) ──
        conn.execute("ALTER TABLE automation_rules ADD COLUMN IF NOT EXISTS target_board_id INTEGER DEFAULT 0")
```

Note: `placeholders` here is already a Python variable name used in the *original* code — this is the 15th dynamic-placeholder site from Task 3 Step 1 (`app.py:4306`), already fixed there. Confirm it reads `','.join(['%s'] * len(...))` when you reach this line — don't re-fix it.

- [ ] **Step 2: Commit**

```bash
git add app.py
git commit -m "Port migrate_db() block 5 (importance transfer + remaining ALTERs) to Postgres"
```

---

## Task 9: `migrate_db()` block 6 — reactions/cycle-time/votes/webhook format/ai_summary (`app.py` ~4354–4404)

**Files:**
- Modify: `app.py` (continues `migrate_db()`)

- [ ] **Step 1: Replace the section**

Replace from `# ── Реакции на комментариях` through the `ai_summary` ALTER (just before `# ── Персональные настройки уведомлений`) with:

```python
        # ── Реакции на комментариях (Nice №26) ──
        conn.execute('''
            CREATE TABLE IF NOT EXISTS comment_reactions (
                id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                comment_id INTEGER NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
                user_email TEXT    NOT NULL,
                emoji      TEXT    NOT NULL,
                created_at TEXT    DEFAULT (to_char((now() AT TIME ZONE 'UTC') + interval '5 hours', 'YYYY-MM-DD HH24:MI:SS')),
                UNIQUE(comment_id, user_email, emoji)
            )
        ''')

        # ── Cycle time — история колонок (Nice №101) ──
        conn.execute('''
            CREATE TABLE IF NOT EXISTS card_column_history (
                id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                card_id    INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
                column_id  INTEGER NOT NULL,
                entered_at TEXT    DEFAULT (to_char((now() AT TIME ZONE 'UTC') + interval '5 hours', 'YYYY-MM-DD HH24:MI:SS')),
                left_at    TEXT
            )
        ''')

        # ── Зависимости задач (Nice №32) ──
        conn.execute("ALTER TABLE card_relations ADD COLUMN IF NOT EXISTS relation_type TEXT DEFAULT 'related'")

        # ── Голосование (Nice №33) ──
        conn.execute('''
            CREATE TABLE IF NOT EXISTS card_votes (
                card_id    INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
                user_email TEXT    NOT NULL,
                vote       INTEGER NOT NULL DEFAULT 1,
                created_at TEXT    DEFAULT (to_char((now() AT TIME ZONE 'UTC') + interval '5 hours', 'YYYY-MM-DD HH24:MI:SS')),
                PRIMARY KEY (card_id, user_email)
            )
        ''')

        # ── Webhook форматы (Nice №70) ──
        conn.execute("ALTER TABLE webhooks ADD COLUMN IF NOT EXISTS format TEXT DEFAULT 'raw'")

        # ── AI-суммаризация — столбец кэша (Nice №75) ──
        conn.execute("ALTER TABLE cards ADD COLUMN IF NOT EXISTS ai_summary TEXT")
```

- [ ] **Step 2: Commit**

```bash
git add app.py
git commit -m "Port migrate_db() block 6 (reactions/cycle-time/votes/webhook format/ai_summary) to Postgres"
```

---

## Task 10: `migrate_db()` block 7 — notification settings/automation log/scheduled automations (`app.py` ~4406–4441), and first full end-to-end run

**Files:**
- Modify: `app.py` (final section of `migrate_db()`)

**Interfaces:**
- Produces: a fully Postgres-compatible `migrate_db()`. This is the first point where `python app.py` can be expected to start up cleanly against Postgres — the real milestone this task verifies.

- [ ] **Step 1: Replace the final section**

Replace from `# ── Персональные настройки уведомлений` through the end of the function (`scheduled_automations` table) with:

```python
        # ── Персональные настройки уведомлений ──
        conn.execute('''
            CREATE TABLE IF NOT EXISTS notification_settings (
                user_email TEXT PRIMARY KEY,
                settings   TEXT DEFAULT '{}',
                updated_at TEXT DEFAULT (to_char((now() AT TIME ZONE 'UTC') + interval '5 hours', 'YYYY-MM-DD HH24:MI:SS'))
            )
        ''')

        # ── Журнал автоматизаций (Should №59) ──
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

        # ── Автоматизация по расписанию (Should №54) ──
        conn.execute('''
            CREATE TABLE IF NOT EXISTS scheduled_automations (
                id           INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                board_id     INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
                name         TEXT    NOT NULL DEFAULT '',
                action_type  TEXT    NOT NULL,
                action_value TEXT    DEFAULT '',
                target_column_id INTEGER REFERENCES columns(id) ON DELETE SET NULL,
                schedule     TEXT    NOT NULL,
                enabled      INTEGER DEFAULT 1,
                last_run     TEXT,
                created_at   TEXT DEFAULT (to_char((now() AT TIME ZONE 'UTC') + interval '5 hours', 'YYYY-MM-DD HH24:MI:SS'))
            )
        ''')
```

Note: `app.py` still has `import sqlite3` at the top (line 8) and no other code references `sqlite3.OperationalError` any more after this task (every `try/except sqlite3.OperationalError` in `migrate_db()` is gone). Remove `sqlite3` from the top-level import line now, since the module no longer uses it anywhere.

- [ ] **Step 2: Remove the now-unused `sqlite3` import**

In `app.py` line 8, change:
```python
import sqlite3, os, uuid, csv, io, shutil, re, json
```
to:
```python
import os, uuid, csv, io, shutil, re, json
```

- [ ] **Step 3: Full end-to-end run against a clean local Postgres**

```bash
docker exec kanban-pg-dev psql -U kanban -d kanban -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
python -c "
from dotenv import load_dotenv; load_dotenv()
import app  # runs init_db() + migrate_db() at import time (app.py module-level code)
print('app imported OK — init_db + migrate_db ran cleanly')
"
```
Expected: prints `app imported OK — init_db + migrate_db ran cleanly`, no traceback.

- [ ] **Step 4: Verify idempotency (run twice)**

```bash
python -c "
from dotenv import load_dotenv; load_dotenv()
from models import init_db
from app import migrate_db
init_db()
migrate_db()
migrate_db()
print('idempotent OK')
"
```
Expected: prints `idempotent OK`.

- [ ] **Step 5: Verify every table exists**

```bash
docker exec kanban-pg-dev psql -U kanban -d kanban -c "\dt" | wc -l
```
Expected: 41 application tables listed (plus the `\dt` header/footer lines).

- [ ] **Step 6: Commit**

```bash
git add app.py
git commit -m "Port migrate_db() block 7 (notifications/automation log/scheduled automations); drop sqlite3 import"
```

---

## Task 11: Port `lastrowid` → `RETURNING id` across `app.py` (remaining ~30 sites)

**Files:**
- Modify: `app.py` at lines: 417, 473, 481, 531, 546, 555, 1087, 1139, 1323, 1412, 1831, 2084, 2130, 2243, 2452, 2502, 2512, 2559, 2603, 2865, 3054, 3141, 3154, 3196, 3213, 3299, 3380, 3430, 3470, 4683

**Interfaces:**
- Consumes: placeholder-converted SQL (Task 3).
- Produces: every route that creates a row and needs its new id keeps working identically from the caller's point of view (same JSON responses).

The pattern is identical at every site — the `INSERT` gains `RETURNING id`, and `cur.lastrowid` becomes `cur.fetchone()['id']`.

- [ ] **Step 1: Convert each site**

For each of the 30 line numbers below, find the `INSERT INTO ... VALUES (...)` statement that the `.lastrowid` on that line reads from (always the nearest preceding `conn.execute('INSERT ...')` assigned to the same cursor variable), add `RETURNING id` to its SQL string, and change the `.lastrowid` read. Two representative examples from the list (apply the same shape to all 30):

```python
# app.py:417 — before
cur = conn.execute(
    'INSERT INTO cards (...) VALUES (...)',
    (...)
)
new_id = cur.lastrowid
# after
cur = conn.execute(
    'INSERT INTO cards (...) VALUES (...) RETURNING id',
    (...)
)
new_id = cur.fetchone()['id']
```

```python
# app.py:2865 — before
row = dict(conn.execute('SELECT * FROM attachments WHERE id=?', (cur.lastrowid,)).fetchone())
# (the `?` here is already `%s` from Task 3) after:
row = dict(conn.execute('SELECT * FROM attachments WHERE id=%s', (cur.fetchone()['id'],)).fetchone())
```

For sites where the id is immediately used only to re-`SELECT` the just-inserted row (e.g. lines 2452, 2512, 2559, 2865, 3054, 3299, 3380, 3430), the pattern is: add `RETURNING id` to the `INSERT`, read `new_id = cur.fetchone()['id']`, then use `new_id` in the following `SELECT ... WHERE id=%s` instead of re-reading `cur.lastrowid` inline.

Work through all 30 sites. This is mechanical but each one must be hand-verified (not scripted) because the surrounding code differs (some assign to a named variable, some inline the read).

- [ ] **Step 2: Verify no `.lastrowid` remains**

Run: `grep -n "lastrowid" app.py`
Expected: no output.

- [ ] **Step 3: Syntax check**

Run: `python -m py_compile app.py`
Expected: no output, exit code 0.

- [ ] **Step 4: Functional check — create one row through each converted route and confirm its id comes back correctly (Review Focus item)**

With the local dev stack up (`docker exec kanban-pg-dev ...` schema reset + `python app.py` running against Postgres), exercise a representative sample that covers the riskiest category (id used immediately in a follow-up query, not just returned as-is):

```bash
curl -s -X POST http://localhost:5001/api/columns -H "Content-Type: application/json" \
  --cookie "<your session cookie>" -d '{"board_id":1,"name":"Test Col"}' | python -m json.tool
```
Expected: JSON response includes a numeric `id` field that is not null and increases monotonically on repeat calls. Repeat for: create card (`POST /api/cards`), create comment (`POST /api/cards/<id>/comments`), create checklist item (`POST /api/checklists/<id>/items`), upload attachment (`POST /api/cards/<id>/attachments`) — these five cover every distinct "read the new id back out" shape in the 30 sites.

- [ ] **Step 5: Commit**

```bash
git add app.py
git commit -m "Port lastrowid to RETURNING id across app.py (psycopg2 has no cursor.lastrowid)"
```

---

## Task 12: Port `INSERT OR IGNORE` → `ON CONFLICT DO NOTHING` across `app.py` (remaining 15 sites)

**Files:**
- Modify: `app.py` at lines: 108, 309, 495, 500, 564, 1416, 1453, 1560, 1630, 1647, 2914, 3201, 3516, 3687, 3750

**Interfaces:**
- Consumes: placeholder-converted SQL (Task 3). (The other 2 of the original 17 `INSERT OR IGNORE` sites, at old lines 4041 and 4106-4108, were already converted in Tasks 4 and 5 as part of porting `migrate_db()`.)

Each site needs the actual conflicting column(s) named explicitly — Postgres's `ON CONFLICT` (unlike SQLite's `OR IGNORE`) requires naming the unique constraint it's resolving against. Convert each using the table's unique constraint (from the schema in Tasks 2/4-10):

- [ ] **Step 1: `comment_mentions` (line 108)** — unique on `(comment_id, mentioned_email)`:
```python
# before
'INSERT OR IGNORE INTO comment_mentions (comment_id, mentioned_email, mentioned_name) VALUES (?,?,?)',
# after
'INSERT INTO comment_mentions (comment_id, mentioned_email, mentioned_name) VALUES (%s,%s,%s) ON CONFLICT (comment_id, mentioned_email) DO NOTHING',
```

- [ ] **Step 2: `card_labels` (lines 309, 500, 3201)** — unique on `(card_id, name)`:
```python
# before (line 309)
conn.execute('INSERT OR IGNORE INTO card_labels (card_id, name, color) VALUES (?,?,?)', (card_id, name, color))
# after
conn.execute('INSERT INTO card_labels (card_id, name, color) VALUES (%s,%s,%s) ON CONFLICT (card_id, name) DO NOTHING', (card_id, name, color))
```
Apply the same `ON CONFLICT (card_id, name) DO NOTHING` at lines 500 and 3201 (both insert into `card_labels` with a `position` column too — keep that column, just add the conflict clause).

- [ ] **Step 3: `card_members` (lines 495, 2914)** — unique on `(card_id, user_email)`:
```python
# before (line 495)
'INSERT OR IGNORE INTO card_members (card_id, user_email, user_name) VALUES (?,?,?)',
# after
'INSERT INTO card_members (card_id, user_email, user_name) VALUES (%s,%s,%s) ON CONFLICT (card_id, user_email) DO NOTHING',
```
Same at line 2914.

- [ ] **Step 4: `board_access` (lines 564, 1416, 1453, 1560)** — primary key `(user_id, board_id)`, so `ON CONFLICT` needs no column list (the whole PK is the conflict target):
```python
# before (line 564)
'INSERT OR IGNORE INTO board_access (user_id, board_id, expires_at) VALUES (?,?,?)',
# after
'INSERT INTO board_access (user_id, board_id, expires_at) VALUES (%s,%s,%s) ON CONFLICT (user_id, board_id) DO NOTHING',
```
Lines 1416, 1453, 1560 insert only `(user_id, board_id)` (no `expires_at`) — same conflict clause, `ON CONFLICT (user_id, board_id) DO NOTHING`.

- [ ] **Step 5: `card_watchers` (line 1630)** — primary key `(card_id, user_email)`:
```python
conn.execute('INSERT INTO card_watchers (card_id, user_email) VALUES (%s,%s) ON CONFLICT (card_id, user_email) DO NOTHING', (card_id, email))
```

- [ ] **Step 6: `board_watchers` (line 1647)** — primary key `(board_id, user_email)`:
```python
conn.execute('INSERT INTO board_watchers (board_id, user_email) VALUES (%s,%s) ON CONFLICT (board_id, user_email) DO NOTHING', (board_id, email))
```

- [ ] **Step 7: `card_relations` (line 3516)** — unique on `(card_a_id, card_b_id)`:
```python
conn.execute('INSERT INTO card_relations (card_a_id, card_b_id, relation_type) VALUES (%s,%s,%s) ON CONFLICT (card_a_id, card_b_id) DO NOTHING', (a, b, relation_type))
```

- [ ] **Step 8: `users` (lines 3687, 3750)** — unique on `email`:
```python
# before
"INSERT OR IGNORE INTO users (email, name, password_hash, role) VALUES (?, ?, ?, ?)",
# after
"INSERT INTO users (email, name, password_hash, role) VALUES (%s, %s, %s, %s) ON CONFLICT (email) DO NOTHING",
```

- [ ] **Step 9: Verify no `INSERT OR IGNORE` remains**

Run: `grep -n "INSERT OR IGNORE" app.py`
Expected: no output.

- [ ] **Step 10: Syntax check**

Run: `python -m py_compile app.py`

- [ ] **Step 11: Commit**

```bash
git add app.py
git commit -m "Port INSERT OR IGNORE to INSERT ... ON CONFLICT DO NOTHING across app.py"
```

---

## Task 13: Port `datetime('now','localtime')` outside DDL (7 sites)

**Files:**
- Modify: `app.py` at lines: 249, 297, 1685-1686, 2354-2356, 2809-2812, 3655-3657, 4692-4695

**Interfaces:**
- Consumes: the same fixed-offset expression already used in Tasks 4-10's DDL defaults — must match exactly for consistency.

- [ ] **Step 1: Convert each site**

```python
# app.py:249 — before
conn.execute(
    "UPDATE card_column_history SET left_at=datetime('now','localtime') WHERE card_id=? AND left_at IS NULL",
    (card_id,)
)
# after
conn.execute(
    "UPDATE card_column_history SET left_at=(to_char((now() AT TIME ZONE 'UTC') + interval '5 hours', 'YYYY-MM-DD HH24:MI:SS')) WHERE card_id=%s AND left_at IS NULL",
    (card_id,)
)
```

```python
# app.py:297 — before
conn.execute("UPDATE cards SET archived=1, archived_at=datetime('now','localtime') WHERE id=?", (card_id,))
# after
conn.execute("UPDATE cards SET archived=1, archived_at=(to_char((now() AT TIME ZONE 'UTC') + interval '5 hours', 'YYYY-MM-DD HH24:MI:SS')) WHERE id=%s", (card_id,))
```

```python
# app.py:1685-1686 — before
conn.execute("UPDATE api_tokens SET last_used=datetime('now','localtime') WHERE token_hash=?",
             (token_hash,))
# after
conn.execute("UPDATE api_tokens SET last_used=(to_char((now() AT TIME ZONE 'UTC') + interval '5 hours', 'YYYY-MM-DD HH24:MI:SS')) WHERE token_hash=%s",
             (token_hash,))
```

```python
# app.py:2354-2356 — before
conn.execute(
    "UPDATE cards SET archived=1, archived_at=datetime('now','localtime') WHERE id=?",
    (card_id,)
)
# after
conn.execute(
    "UPDATE cards SET archived=1, archived_at=(to_char((now() AT TIME ZONE 'UTC') + interval '5 hours', 'YYYY-MM-DD HH24:MI:SS')) WHERE id=%s",
    (card_id,)
)
```

```python
# app.py:2809-2812 — before
conn.execute('''
    INSERT INTO notification_settings (user_email, settings, updated_at)
    VALUES (?, ?, datetime('now','localtime'))
    ON CONFLICT(user_email) DO UPDATE SET settings=?, updated_at=datetime('now','localtime')
''', (email, json.dumps(settings), json.dumps(settings)))
# after
conn.execute('''
    INSERT INTO notification_settings (user_email, settings, updated_at)
    VALUES (%s, %s, (to_char((now() AT TIME ZONE 'UTC') + interval '5 hours', 'YYYY-MM-DD HH24:MI:SS')))
    ON CONFLICT(user_email) DO UPDATE SET settings=%s, updated_at=(to_char((now() AT TIME ZONE 'UTC') + interval '5 hours', 'YYYY-MM-DD HH24:MI:SS'))
''', (email, json.dumps(settings), json.dumps(settings)))
```
(Note: this site already used `ON CONFLICT(user_email) DO UPDATE SET ...` — valid SQLite *and* Postgres upsert syntax — only the placeholders and the `datetime(...)` call needed changing.)

```python
# app.py:3655-3657 — before
conn.execute(
    "UPDATE columns SET archived=1, archived_at=datetime('now','localtime') WHERE id=?",
    (col_id,)
)
# after
conn.execute(
    "UPDATE columns SET archived=1, archived_at=(to_char((now() AT TIME ZONE 'UTC') + interval '5 hours', 'YYYY-MM-DD HH24:MI:SS')) WHERE id=%s",
    (col_id,)
)
```

```python
# app.py:4692-4695 — before
conn.execute(
    f"UPDATE cards SET archived=1, archived_at=datetime('now','localtime') WHERE column_id IN ({ph}) AND completed=1 AND (archived=0 OR archived IS NULL)",
    col_ids
)
# after
conn.execute(
    f"UPDATE cards SET archived=1, archived_at=(to_char((now() AT TIME ZONE 'UTC') + interval '5 hours', 'YYYY-MM-DD HH24:MI:SS')) WHERE column_id IN ({ph}) AND completed=1 AND (archived=0 OR archived IS NULL)",
    col_ids
)
```
(`ph` here is built from `','.join(['%s'] * len(col_ids))` — already fixed in Task 3 Step 1, line 4691.)

- [ ] **Step 2: Verify no `datetime('now'` remains**

Run: `grep -n "datetime('now'" app.py`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add app.py
git commit -m "Port datetime('now','localtime') to Postgres UTC+5 expression outside DDL"
```

---

## Task 14: Fix `attachments.filepath` to store a relative path, not absolute

**Files:**
- Modify: `app.py` at lines ~2853-2865 (upload), ~2868-2876 (download), ~2879-2888 (delete), ~3875-3906 (zip export)

**Interfaces:**
- Produces: `attachments.filepath` now holds `"<card_id>/<stored_filename>"` (relative to `UPLOAD_FOLDER`), not an absolute filesystem path — this is what the ETL script (Task 17) must also produce when migrating existing rows, since the column's meaning changes.

- [ ] **Step 1: Fix the upload route**

Read the current code at `app.py:2845-2866` first to get exact context, then change:
```python
# before
card_dir = os.path.join(UPLOAD_FOLDER, str(card_id))
os.makedirs(card_dir, exist_ok=True)
filepath = os.path.join(card_dir, stored)
f.save(filepath)
size_str = _fmt_size(os.path.getsize(filepath))
ftype = _file_type(original)
with get_db() as conn:
    cur = conn.execute(
        'INSERT INTO attachments (card_id,filename,filesize,filetype,filepath) VALUES(%s,%s,%s,%s,%s)',
        (card_id, original, size_str, ftype, filepath)
    )
```
to:
```python
# after
card_dir = os.path.join(UPLOAD_FOLDER, str(card_id))
os.makedirs(card_dir, exist_ok=True)
abs_filepath = os.path.join(card_dir, stored)
f.save(abs_filepath)
rel_filepath = f'{card_id}/{stored}'
size_str = _fmt_size(os.path.getsize(abs_filepath))
ftype = _file_type(original)
with get_db() as conn:
    cur = conn.execute(
        'INSERT INTO attachments (card_id,filename,filesize,filetype,filepath) VALUES(%s,%s,%s,%s,%s) RETURNING id',
        (card_id, original, size_str, ftype, rel_filepath)
    )
```
(The rest of that route, reading the new row back via `RETURNING id`, is already covered by Task 11 for this same site — don't duplicate that edit, just confirm it reads `rel_filepath` was what got inserted.)

- [ ] **Step 2: Fix the download route**

Read `app.py:2868-2878` first, then change:
```python
# before
if not att or not os.path.exists(att['filepath']):
    ...
return send_file(att['filepath'], download_name=att['filename'], ...)
```
to:
```python
# after
abs_path = os.path.join(UPLOAD_FOLDER, att['filepath'])
if not att or not os.path.exists(abs_path):
    ...
return send_file(abs_path, download_name=att['filename'], ...)
```

- [ ] **Step 3: Fix the delete route**

Read `app.py:2879-2896` first, then change:
```python
# before
os.remove(att['filepath'])
```
to:
```python
# after
os.remove(os.path.join(UPLOAD_FOLDER, att['filepath']))
```

- [ ] **Step 4: Fix the zip export route**

Read `app.py:3870-3910` first, then change:
```python
# before
if os.path.isfile(att['filepath']):
    zf.write(att['filepath'], arcname)
```
to:
```python
# after
abs_path = os.path.join(UPLOAD_FOLDER, att['filepath'])
if os.path.isfile(abs_path):
    zf.write(abs_path, arcname)
```

- [ ] **Step 5: Verify no remaining direct `att['filepath']` filesystem use**

Run: `grep -n "att\['filepath'\]" app.py`
Expected: every result is now either building `abs_path = os.path.join(UPLOAD_FOLDER, att['filepath'])` or reading `att['filepath']` as plain data (e.g. logging) — not passed directly to `os.path.exists`/`send_file`/`os.remove`/`zf.write`.

- [ ] **Step 6: Functional check**

Upload a file to a card through the running app, then download it, then delete it — confirm all three succeed (200 responses, file content matches on download).

```bash
curl -s -X POST http://localhost:5001/api/cards/1/attachments -H "Cookie: <session>" -F "file=@/tmp/test.txt" | python -m json.tool
# note the returned attachment id, then:
curl -s -o /tmp/downloaded.txt http://localhost:5001/api/attachments/<id> -H "Cookie: <session>"
diff /tmp/test.txt /tmp/downloaded.txt  # expect no output (files identical)
```

- [ ] **Step 7: Commit**

```bash
git add app.py
git commit -m "Store attachments.filepath as relative path (fixes Linux-move incompatibility)"
```

---

## Task 15: Fix case-insensitive free-text search (`/api/search`)

**Files:**
- Modify: `app.py:4458-4540` (function `api_search`)

**Interfaces:**
- Consumes: placeholder-converted SQL (Task 3).

- [ ] **Step 1: Read the current function**

Read `app.py:4458-4540` to confirm exact current state (placeholders should already be `%s` from Task 3).

- [ ] **Step 2: Change the free-text `LIKE` to `ILIKE`**

Change line ~4509 from:
```python
ors = ' OR '.join(['c.title LIKE %s OR c.description LIKE %s'] * len(variants))
```
to:
```python
ors = ' OR '.join(['c.title ILIKE %s OR c.description ILIKE %s'] * len(variants))
```
(The other two `LIKE` sites in this function, lines 4503 and 4515, already wrap both the column and the parameter in `LOWER(...)` — they're already case-insensitive regardless of DB, leave them as `LIKE`.)

- [ ] **Step 3: Write a verification script proving the regression this fixes**

```bash
python -c "
from dotenv import load_dotenv; load_dotenv()
from models import get_db
with get_db() as conn:
    conn.execute('INSERT INTO boards (name) VALUES (%s)', ('ZZZ Test Board',))
    conn.execute('''INSERT INTO columns (board_id, name, position)
                     SELECT id, %s, 0 FROM boards WHERE name=%s''', ('Col', 'ZZZ Test Board'))
    conn.execute('''INSERT INTO cards (column_id, title)
                     SELECT c.id, %s FROM columns c JOIN boards b ON b.id=c.board_id WHERE b.name=%s''',
                     ('WiFi Router Setup', 'ZZZ Test Board'))
"
curl -s "http://localhost:5001/api/search?q=wifi" -H "Cookie: <session>" | python -m json.tool
```
Expected: the response includes the "WiFi Router Setup" card even though the query (`wifi`) is lowercase and the title has mixed case `WiFi` — before this fix, Postgres's case-sensitive `LIKE` would return zero results for this query.

- [ ] **Step 4: Commit**

```bash
git add app.py
git commit -m "Fix case-insensitive free-text search (LIKE -> ILIKE) broken by Postgres port"
```

---

## Task 16: `/health` — real Postgres connectivity check

**Files:**
- Modify: `app.py:4543-4545` (route `health`)

- [ ] **Step 1: Change the route**

```python
# before
@app.route('/health')
def health():
    return jsonify({'status': 'ok'})

# after
@app.route('/health')
def health():
    try:
        with get_db() as conn:
            conn.execute('SELECT 1')
        return jsonify({'status': 'ok'})
    except Exception as e:
        return jsonify({'status': 'error', 'detail': str(e)}), 503
```

- [ ] **Step 2: Verify both paths**

```bash
curl -s http://localhost:5001/health
# expected: {"status": "ok"}

docker stop kanban-pg-dev
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:5001/health
# expected: 503
docker start kanban-pg-dev
```

- [ ] **Step 3: Commit**

```bash
git add app.py
git commit -m "Make /health verify actual Postgres connectivity, not just process liveness"
```

---

## Task 17: ETL script `migrate_to_postgres.py`

**Files:**
- Create: `migrate_to_postgres.py` (repo root, alongside `import_trello.py`/`import_trello_workspace.py` — matches this project's existing convention of standalone one-off scripts at repo root)

**Interfaces:**
- Consumes: a `kanban.db` file and a running empty-but-schema-initialized Postgres database (i.e., `init_db()` + `migrate_db()` already run against it, per Tasks 2-10).
- Produces: all rows copied with original IDs preserved and Postgres sequences advanced to match — this is what the production cutover (follow-up Docker/Linux plan) runs during the maintenance window.

- [ ] **Step 1: Write the script**

```python
#!/usr/bin/env python3
"""One-off ETL: copies all data from kanban.db (SQLite) into PostgreSQL,
preserving primary key IDs, then resets Postgres identity sequences so that
future INSERTs continue after the highest migrated id.

Must be run against a Postgres database that already has the schema applied
(via `from models import init_db; from app import migrate_db; init_db(); migrate_db()`
pointed at the target Postgres connection).

NOT resumable: if this script fails partway through, do not re-run it against
the same Postgres database — it will hit primary-key conflicts on tables it
already committed. Instead, wipe the schema (`DROP SCHEMA public CASCADE;
CREATE SCHEMA public;`), re-apply init_db()/migrate_db(), and re-run from
scratch.

Usage:
    python migrate_to_postgres.py --sqlite kanban.db \\
        --pg-host localhost --pg-port 5432 --pg-db kanban \\
        --pg-user kanban --pg-password <password>
"""
import argparse
import os
import sqlite3

import psycopg2
import psycopg2.extras

# Table order respects foreign-key dependencies: a table only appears after
# every table it references.
TABLE_ORDER = [
    'users', 'workspaces', 'boards', 'board_access', 'columns', 'cards',
    'comments', 'attachments', 'invites', 'card_watchers', 'board_watchers',
    'api_tokens', 'webhooks', 'slack_settings', 'automation_log',
    'card_members', 'checklists', 'checklist_items', 'card_labels',
    'card_links', 'comment_mentions', 'inbox_entries', 'card_activity',
    'custom_fields', 'card_custom_field_values', 'card_mirrors',
    'automation_rules', 'card_relations', 'board_templates',
    'board_template_columns', 'board_template_custom_fields',
    'card_templates', 'card_template_labels', 'card_template_checklists',
    'card_template_checklist_items', 'card_template_custom_fields',
    'comment_reactions', 'card_column_history', 'card_votes',
    'notification_settings', 'scheduled_automations',
]


def _relativize_attachment_path(upload_folder, old_filepath):
    """attachments.filepath used to store a full absolute path built from the
    OLD server's UPLOAD_FOLDER; the new schema stores a path relative to the
    NEW server's UPLOAD_FOLDER (see Task 14). The last two path segments
    (card_id dir + filename) are always preserved regardless of OS or
    UPLOAD_FOLDER prefix, so we reconstruct the relative form from those."""
    normalized = old_filepath.replace('\\', '/')
    parts = normalized.split('/')
    card_dir, filename = parts[-2], parts[-1]
    return f'{card_dir}/{filename}'


def migrate_table(sqlite_conn, pg_conn, table):
    sq_cur = sqlite_conn.execute(f'SELECT * FROM {table}')
    rows = sq_cur.fetchall()
    if not rows:
        print(f'  {table}: 0 rows, skipping')
        return 0

    columns = rows[0].keys()
    values = [tuple(row[col] for col in columns) for row in rows]

    if table == 'attachments':
        filepath_idx = list(columns).index('filepath')
        values = [
            tuple(
                _relativize_attachment_path(None, v) if i == filepath_idx else v
                for i, v in enumerate(row)
            )
            for row in values
        ]

    col_list = ', '.join(columns)
    placeholders = ', '.join(['%s'] * len(columns))
    insert_sql = f'INSERT INTO {table} ({col_list}) VALUES ({placeholders})'

    with pg_conn.cursor() as pg_cur:
        psycopg2.extras.execute_batch(pg_cur, insert_sql, values, page_size=500)

        if 'id' in columns:
            pg_cur.execute("SELECT pg_get_serial_sequence(%s, 'id')", (table,))
            seq_name = pg_cur.fetchone()[0]
            if seq_name:
                pg_cur.execute(
                    f"SELECT setval(%s, (SELECT MAX(id) FROM {table}))",
                    (seq_name,)
                )
    pg_conn.commit()
    print(f'  {table}: {len(rows)} rows migrated')
    return len(rows)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sqlite', required=True, help='Path to kanban.db')
    parser.add_argument('--pg-host', required=True)
    parser.add_argument('--pg-port', default='5432')
    parser.add_argument('--pg-db', required=True)
    parser.add_argument('--pg-user', required=True)
    parser.add_argument('--pg-password', required=True)
    args = parser.parse_args()

    sqlite_conn = sqlite3.connect(args.sqlite)
    sqlite_conn.row_factory = sqlite3.Row

    pg_conn = psycopg2.connect(
        host=args.pg_host, port=args.pg_port, dbname=args.pg_db,
        user=args.pg_user, password=args.pg_password,
    )

    print(f'Migrating {args.sqlite} -> postgres://{args.pg_host}:{args.pg_port}/{args.pg_db}')
    total = 0
    for table in TABLE_ORDER:
        total += migrate_table(sqlite_conn, pg_conn, table)

    print(f'Done. {total} rows migrated across {len(TABLE_ORDER)} tables.')
    sqlite_conn.close()
    pg_conn.close()


if __name__ == '__main__':
    main()
```

- [ ] **Step 2: Verify the table list matches the live schema exactly**

```bash
python -c "
import sqlite3
conn = sqlite3.connect('kanban.db')
sqlite_tables = {r[0] for r in conn.execute(\"SELECT name FROM sqlite_master WHERE type='table'\")}
from migrate_to_postgres import TABLE_ORDER
missing = sqlite_tables - set(TABLE_ORDER)
extra = set(TABLE_ORDER) - sqlite_tables
print('in sqlite but not in TABLE_ORDER:', missing)
print('in TABLE_ORDER but not in sqlite:', extra)
"
```
Expected: both sets empty (or `extra` containing only tables that exist in the new Postgres schema but didn't exist yet in this particular `kanban.db` snapshot — acceptable; `missing` must always be empty).

- [ ] **Step 3: Dry run against a copy of real dev data**

```bash
cp kanban.db /tmp/kanban-test.db
docker exec kanban-pg-dev psql -U kanban -d kanban -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
python -c "
from dotenv import load_dotenv; load_dotenv()
from models import init_db
from app import migrate_db
init_db(); migrate_db()
"
python migrate_to_postgres.py --sqlite /tmp/kanban-test.db \
  --pg-host localhost --pg-port 5432 --pg-db kanban --pg-user kanban --pg-password devpass
```
Expected: one line per non-empty table, no errors, final `Done. N rows migrated across 41 tables.`

- [ ] **Step 4: Verify row counts match**

```bash
python -c "
import sqlite3, psycopg2
from dotenv import load_dotenv; load_dotenv()
import os
sq = sqlite3.connect('/tmp/kanban-test.db')
pg = psycopg2.connect(host='localhost', port='5432', dbname='kanban', user='kanban', password='devpass')
from migrate_to_postgres import TABLE_ORDER
mismatches = []
for t in TABLE_ORDER:
    sq_count = sq.execute(f'SELECT COUNT(*) FROM {t}').fetchone()[0]
    with pg.cursor() as cur:
        cur.execute(f'SELECT COUNT(*) FROM {t}')
        pg_count = cur.fetchone()[0]
    if sq_count != pg_count:
        mismatches.append((t, sq_count, pg_count))
print('mismatches:', mismatches)
"
```
Expected: `mismatches: []`.

- [ ] **Step 5: Verify a new row can be created after migration (sequence reset worked)**

```bash
python -c "
from dotenv import load_dotenv; load_dotenv()
from models import get_db
with get_db() as conn:
    cur = conn.execute(\"INSERT INTO boards (name) VALUES ('post-migration test') RETURNING id\")
    new_id = cur.fetchone()['id']
    print('new board id:', new_id)
    max_old_id = conn.execute('SELECT MAX(id) FROM boards WHERE name != %s', ('post-migration test',)).fetchone()[0]
    assert new_id > max_old_id, f'sequence not advanced past migrated data! new_id={new_id} max_old_id={max_old_id}'
    print('sequence reset OK')
"
```
Expected: prints the new id and `sequence reset OK`, no `AssertionError`.

- [ ] **Step 6: Commit**

```bash
git add migrate_to_postgres.py
git commit -m "Add one-off ETL script to migrate kanban.db data into PostgreSQL"
```

---

## Task 18: Final rehearsal — full local migration run + smoke-test checklist

**Files:** none (verification-only task; no code changes)

**Interfaces:**
- Consumes: everything from Tasks 1-17.
- Produces: confidence that this plan, run start-to-finish against a real copy of production data, produces a working app — this is the gate before writing the follow-up Docker/Linux/cutover plan.

- [ ] **Step 1: Get a real copy of the current production `kanban.db` and `uploads/`**

Copy the actual production `kanban.db` (from the Windows server) to this dev machine as `/tmp/kanban-prod-copy.db`, and the `uploads/` directory to `/tmp/uploads-prod-copy/`. (Do not modify the production files — copy only.)

- [ ] **Step 2: Reset local Postgres and apply schema**

```bash
docker exec kanban-pg-dev psql -U kanban -d kanban -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
python -c "
from dotenv import load_dotenv; load_dotenv()
from models import init_db
from app import migrate_db
init_db(); migrate_db()
"
```

- [ ] **Step 3: Run the ETL script against the real data copy**

```bash
python migrate_to_postgres.py --sqlite /tmp/kanban-prod-copy.db \
  --pg-host localhost --pg-port 5432 --pg-db kanban --pg-user kanban --pg-password devpass
```
Expected: completes with no errors, row counts logged per table.

- [ ] **Step 4: Row-count and FK-integrity verification (per spec)**

Run the row-count comparison script from Task 17 Step 4, pointed at `/tmp/kanban-prod-copy.db`. Then check FK integrity explicitly (should always be zero, since SQLite enforced FKs too, but confirm post-migration):
```bash
python -c "
import psycopg2
conn = psycopg2.connect(host='localhost', port='5432', dbname='kanban', user='kanban', password='devpass')
with conn.cursor() as cur:
    cur.execute('''
        SELECT c.id FROM cards c
        LEFT JOIN columns col ON col.id = c.column_id
        WHERE col.id IS NULL
    ''')
    orphans = cur.fetchall()
    print('orphaned cards (should be empty):', orphans)
"
```
Expected: `orphaned cards (should be empty): []`.

- [ ] **Step 5: Point `UPLOAD_FOLDER` at the copied uploads directory and run the full smoke-test checklist**

Set `UPLOAD_FOLDER`-equivalent env/constant to `/tmp/uploads-prod-copy/` (temporarily, for this test run — this becomes a proper env var in the follow-up Docker plan), start the app (`python app.py`), and work through:

1. Login (local users fallback, and Google Sheets if configured) — confirm success.
2. Open a board with real data → columns/cards present, drag a card between columns → confirm it persists.
3. Open a card that has a real attachment → download it → confirm the downloaded file is byte-identical to the original in `/tmp/uploads-prod-copy/`.
4. Add a comment and a checklist item on a real card → confirm both appear and persist across a page reload.
5. Create a new card and a new board → confirm no primary-key conflict (sequences correctly reset).
6. Export a board to CSV and a workspace to CSV → confirm both downloads succeed and contain the expected rows.
7. `GET /health` → confirm `200 {"status": "ok"}`.

- [ ] **Step 6: Record the result**

If all 7 checklist items pass: this plan is complete and verified against real data. Report this to the user and note that the next step is a separate plan for Dockerizing + moving to the Linux server + the actual production cutover (per the spec's phasing).

If anything fails: do not proceed to writing the follow-up plan — fix the root cause in the relevant task above, re-run from Step 2, and re-verify.

---

## Self-Review Notes

- **Spec coverage:** every section of the spec's "Изменения в коде приложения" and "Перенос данных работающего приложения" (data-migration parts) is covered by Tasks 1-18. The spec's Docker/compose/backups/cutover sections are explicitly deferred to a follow-up plan (stated in this plan's header and Task 18 Step 6) — this is a scope split, not a gap.
- **Type consistency:** `get_db()` → `PGConnWrapper` (Task 2) is used identically in every later task (`with get_db() as conn: conn.execute(sql, params)`); `RETURNING id` → `cur.fetchone()['id']` is the one new pattern introduced, used consistently everywhere a former `.lastrowid` read existed — in `models.py` (Task 2, 4 sites in `_seed`/`_seed_users`), inside `migrate_db()` (Task 5, 1 site), and across the rest of `app.py` (Task 11, the other 30 listed sites) — the original file-wide count of 31 `.lastrowid` occurrences is fully accounted for across these three tasks.
- **Review Focus:** all 5 items have an owning task with a pinned verification step (Task 3/Task 15/Task 4/Task 11/Task 17, respectively — cross-referenced above).
