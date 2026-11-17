#!/usr/bin/env python3
"""One-off ETL: copies all data from kanban.db (SQLite) into PostgreSQL,
preserving primary key IDs, then resets Postgres identity sequences so that
future INSERTs continue after the highest migrated id.

Must be run against a Postgres database that already has the schema applied
(via `from models import init_db; from app import migrate_db; init_db(); migrate_db()`
pointed at the target Postgres connection) -- AND whose target tables are
empty. init_db() seeds demo rows into users/workspaces/boards/columns/cards
whenever they're empty, which this script's own primary-key preservation
will then conflict with. This script checks for that and aborts with a
clear message rather than failing confusingly partway through; if it
aborts, truncate the seeded tables first:
    TRUNCATE cards, columns, boards, workspaces, users RESTART IDENTITY CASCADE;

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
    if len(parts) < 2:
        return normalized
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
    # Every id column in this schema is GENERATED ALWAYS AS IDENTITY (see
    # models.py/app.py), so inserting an explicit id value requires
    # OVERRIDING SYSTEM VALUE or Postgres rejects the insert outright.
    overriding = 'OVERRIDING SYSTEM VALUE ' if 'id' in columns else ''
    insert_sql = f'INSERT INTO {table} ({col_list}) {overriding}VALUES ({placeholders})'

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
    parser.add_argument('--pg-password', default=os.environ.get('PGPASSWORD'),
                         help='Postgres password. Prefer the PGPASSWORD env var over this flag '
                              '(a CLI arg is visible in shell history and the process list).')
    args = parser.parse_args()
    if not args.pg_password:
        parser.error('--pg-password or the PGPASSWORD env var is required')

    sqlite_conn = sqlite3.connect(args.sqlite)
    sqlite_conn.row_factory = sqlite3.Row

    pg_conn = psycopg2.connect(
        host=args.pg_host, port=args.pg_port, dbname=args.pg_db,
        user=args.pg_user, password=args.pg_password,
    )

    with pg_conn.cursor() as check_cur:
        non_empty = []
        for table in TABLE_ORDER:
            check_cur.execute(f'SELECT COUNT(*) FROM {table}')
            if check_cur.fetchone()[0] > 0:
                non_empty.append(table)
    if non_empty:
        print(f'ERROR: target tables are not empty: {non_empty}')
        print("init_db() seeds demo data whenever users/workspaces/boards/columns/cards")
        print("are empty -- truncate them before running this script:")
        print("  TRUNCATE cards, columns, boards, workspaces, users RESTART IDENTITY CASCADE;")
        sqlite_conn.close()
        pg_conn.close()
        return 1

    print(f'Migrating {args.sqlite} -> postgres://{args.pg_host}:{args.pg_port}/{args.pg_db}')
    total = 0
    for table in TABLE_ORDER:
        total += migrate_table(sqlite_conn, pg_conn, table)

    print(f'Done. {total} rows migrated across {len(TABLE_ORDER)} tables.')
    sqlite_conn.close()
    pg_conn.close()
    return 0


if __name__ == '__main__':
    import sys
    sys.exit(main() or 0)
