"""
Импорт целого workspace из Trello в Kanban-приложение.

Использование:
    python import_trello_workspace.py ./trello_export --workspace "Компания А"
    python import_trello_workspace.py ./trello_export --workspace "Компания А" --skip-archived

Как получить данные:
    В Trello UI нет экспорта всего workspace целиком — экспортируется
    каждая доска отдельно (Меню доски → Показать меню → Ещё → Печать и
    экспорт → Экспорт в JSON). Сохрани все получившиеся *.json файлы
    досок нужного workspace в одну папку и передай её этому скрипту.

Что делает скрипт:
    1. Находит workspace с указанным именем в нашей БД или создаёт новый.
    2. Для каждого *.json файла в папке создаёт новую доску в этом workspace.
    3. Импортирует в неё списки/карточки/чеклисты/комментарии — так же,
       как это делает import_trello.py для одной доски.

Если один из файлов не проходит импорт — скрипт сообщает об ошибке,
пропускает файл и переходит к следующему (успешно импортированные доски
уже зафиксированы в БД).
"""

import json
import sqlite3
import argparse
import os
import sys
import glob

if sys.stdout.encoding and sys.stdout.encoding.lower() != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')

from import_trello import import_board_data, TRELLO_COLORS

DB_PATH = os.path.join(os.path.dirname(__file__), 'kanban.db')

DEFAULT_BOARD_COLOR = '#0052cc'


def get_or_create_workspace(conn, name, color):
    ws = conn.execute('SELECT id, name, color FROM workspaces WHERE name=?', (name,)).fetchone()
    if ws:
        return ws['id'], False
    cur = conn.execute('INSERT INTO workspaces (name, color) VALUES (?, ?)', (name, color))
    return cur.lastrowid, True


def guess_board_color(data, fallback):
    bg = ((data.get('prefs') or {}).get('backgroundColor') or '').strip()
    if bg.startswith('#'):
        return bg
    if bg in TRELLO_COLORS:
        return TRELLO_COLORS[bg]
    return fallback


def run(folder, workspace_name, workspace_color, skip_archived, board_color_override):
    if not os.path.isdir(folder):
        print(f'Папка не найдена: {folder}')
        sys.exit(1)

    json_files = sorted(glob.glob(os.path.join(folder, '**', '*.json'), recursive=True))
    if not json_files:
        print(f'В папке {folder} не найдено ни одного *.json файла.')
        sys.exit(1)

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA foreign_keys = ON')

    ws_id, ws_created = get_or_create_workspace(conn, workspace_name, workspace_color)
    conn.commit()
    print(f'\nWorkspace: «{workspace_name}» [{ws_id}] {"(создан)" if ws_created else "(существующий)"}')
    print(f'Файлов найдено: {len(json_files)}\n')

    totals = {
        'boards': 0, 'columns': 0, 'cards': 0,
        'labels': 0, 'card_members': 0,
        'checklists': 0, 'checklist_items': 0,
        'attachments': 0, 'attachments_skipped': 0,
        'comments': 0,
    }
    all_unmatched_names = set()
    skipped_non_board = []   # не похоже на экспорт доски (manifest.json и т.п.) — не ошибка
    failed = []              # реальные исключения при импорте

    for path in json_files:
        filename = os.path.basename(path)
        try:
            with open(path, encoding='utf-8') as f:
                data = json.load(f)
        except (OSError, json.JSONDecodeError) as e:
            print(f'  [пропущено] {filename}: не удалось прочитать JSON ({e})')
            failed.append(filename)
            continue

        if 'lists' not in data or 'cards' not in data:
            skipped_non_board.append(filename)
            continue

        board_name = data.get('name', '').strip() or filename
        board_color = guess_board_color(data, board_color_override or DEFAULT_BOARD_COLOR)
        source_dir = os.path.dirname(os.path.abspath(path))

        try:
            cur = conn.execute(
                'INSERT INTO boards (name, company, color, workspace_id, description) VALUES (?, ?, ?, ?, ?)',
                (board_name, workspace_name, board_color, ws_id, data.get('desc', ''))
            )
            board_id = cur.lastrowid

            print(f'  → «{board_name}» (из {filename})')
            stats = import_board_data(conn, board_id, data, skip_archived, source_dir=source_dir)
            conn.commit()

            print(f'      колонок: {stats["columns"]}, карточек: {stats["cards"]}, меток: {stats["labels"]}, '
                  f'участников: {stats["card_members"]}, чек-листов: {stats["checklists"]} '
                  f'(пунктов: {stats["checklist_items"]}), вложений: {stats["attachments"]}, '
                  f'комментариев: {stats["comments"]}')

            totals['boards'] += 1
            totals['columns'] += stats['columns']
            totals['cards'] += stats['cards']
            totals['labels'] += stats['labels']
            totals['card_members'] += stats['card_members']
            totals['checklists'] += stats['checklists']
            totals['checklist_items'] += stats['checklist_items']
            totals['attachments'] += stats['attachments']
            totals['attachments_skipped'] += stats['attachments_skipped']
            totals['comments'] += stats['comments']
            all_unmatched_names |= stats['unmatched_names']
        except Exception as e:
            conn.rollback()
            print(f'  [ошибка] {filename}: {e}')
            failed.append(filename)

    conn.close()

    print('\nИтого:')
    print(f'  Досок импортировано: {totals["boards"]}')
    print(f'  Колонок: {totals["columns"]}')
    print(f'  Карточек: {totals["cards"]}')
    print(f'  Меток: {totals["labels"]}')
    print(f'  Участников карточек: {totals["card_members"]}')
    print(f'  Чек-листов: {totals["checklists"]} (пунктов: {totals["checklist_items"]})')
    print(f'  Вложений: {totals["attachments"]}')
    if totals['attachments_skipped']:
        print(f'  Вложений пропущено (файл не найден): {totals["attachments_skipped"]}')
    print(f'  Комментариев: {totals["comments"]}')
    if all_unmatched_names:
        print(f'\nНесопоставленные участники Trello ({len(all_unmatched_names)}, без учёта совпадений с '
              f'существующими пользователями — переносятся как текст без привязки к аккаунту):')
        print(f'  {", ".join(sorted(all_unmatched_names))}')
    if skipped_non_board:
        print(f'\nПропущено файлов, не похожих на экспорт доски ({len(skipped_non_board)}): '
              f'{", ".join(skipped_non_board)}')
    if failed:
        print(f'\nНе импортированы из-за ошибки ({len(failed)}): {", ".join(failed)}')

    print('\nИмпорт workspace завершён.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Импорт целого workspace Trello (папка JSON-файлов досок) в Kanban DB')
    parser.add_argument('folder',                     help='Путь к папке с *.json файлами экспорта досок Trello')
    parser.add_argument('--workspace',  required=True, help='Название workspace в нашем приложении (создаётся, если не существует)')
    parser.add_argument('--workspace-color', default=DEFAULT_BOARD_COLOR, help='Цвет workspace при создании (hex, по умолчанию #0052cc)')
    parser.add_argument('--board-color',     default=None, help='Принудительный цвет для всех досок (hex). По умолчанию цвет угадывается из фона доски Trello')
    parser.add_argument('--skip-archived',   action='store_true', help='Пропустить архивированные списки и карточки Trello')
    args = parser.parse_args()

    run(args.folder, args.workspace, args.workspace_color, args.skip_archived, args.board_color)
