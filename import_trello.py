"""
Импорт доски из Trello в Kanban-приложение.

Использование:
    python import_trello.py board-export.json --board-id 3
    python import_trello.py board-export.json --board-id 3 --skip-archived

Экспорт из Trello:
    Меню доски → Показать меню → Ещё → Печать и экспорт → Экспорт в JSON

Комментарии берутся из массива actions (type=commentCard).
В JSON-экспорте Trello включает не более 1000 последних действий на доске.
"""

import json
import sqlite3
import argparse
import os
import sys
from datetime import datetime, timezone

DB_PATH = os.path.join(os.path.dirname(__file__), 'kanban.db')

# Соответствие цветов Trello → наши hex
TRELLO_COLORS = {
    'red':    '#de350b',
    'orange': '#ff8b00',
    'yellow': '#f6c000',
    'green':  '#00875a',
    'blue':   '#4361EE',
    'purple': '#6554c0',
    'pink':   '#e91e8c',
    'sky':    '#00b8d9',
    'lime':   '#4bce97',
    'black':  '#1a1a2e',
}


def parse_due(due_str):
    """ISO 8601 → YYYY-MM-DD, или пустая строка."""
    if not due_str:
        return ''
    try:
        dt = datetime.fromisoformat(due_str.replace('Z', '+00:00'))
        return dt.astimezone(timezone.utc).strftime('%Y-%m-%d')
    except Exception:
        return ''


def parse_datetime(iso_str):
    """ISO 8601 → YYYY-MM-DD HH:MM:SS (локальное время), или пустая строка."""
    if not iso_str:
        return ''
    try:
        dt = datetime.fromisoformat(iso_str.replace('Z', '+00:00'))
        return dt.astimezone().strftime('%Y-%m-%d %H:%M:%S')
    except Exception:
        return ''


def build_member_map(members):
    """id участника Trello → отображаемое имя."""
    result = {}
    for m in members:
        name = (m.get('fullName') or m.get('username') or '').strip()
        if name:
            result[m['id']] = name
    return result


def get_comment_author(action, member_map):
    """Имя автора комментария из action."""
    creator = action.get('memberCreator') or {}
    name = (creator.get('fullName') or creator.get('username') or '').strip()
    if name:
        return name
    member_id = action.get('idMemberCreator')
    if member_id:
        return member_map.get(member_id, 'Пользователь')
    return 'Пользователь'


def get_label(labels):
    """Берём первую непустую метку из списка."""
    for lbl in labels:
        name  = (lbl.get('name') or '').strip()
        color = TRELLO_COLORS.get(lbl.get('color', ''), '')
        if name or color:
            return name, color
    return '', ''


def import_board_data(conn, board_id, data, skip_archived):
    """Импортирует списки/карточки/чеклисты/комментарии Trello-доски (data)
    в существующую доску board_id. Возвращает словарь со статистикой."""

    # ── Списки (→ колонки) ──────────────────────────────────────────────────
    lists_raw = data.get('lists', [])
    if skip_archived:
        lists_raw = [l for l in lists_raw if not l.get('closed')]
    lists_sorted = sorted(lists_raw, key=lambda l: l.get('pos', 0))

    # Узнаём текущий макс. position в доске
    max_pos = conn.execute(
        'SELECT COALESCE(MAX(position), -1) FROM columns WHERE board_id=?', (board_id,)
    ).fetchone()[0]

    # id Trello → id нашей колонки
    list_map = {}
    col_count = 0
    for i, lst in enumerate(lists_sorted):
        cur = conn.execute(
            'INSERT INTO columns (board_id, name, position) VALUES (?, ?, ?)',
            (board_id, lst['name'], max_pos + 1 + i)
        )
        list_map[lst['id']] = cur.lastrowid
        col_count += 1

    print(f'  Колонок создано: {col_count}')

    # ── Карточки ────────────────────────────────────────────────────────────
    cards_raw = data.get('cards', [])
    if skip_archived:
        cards_raw = [c for c in cards_raw if not c.get('closed')]

    # Строим индекс чеклистов по idCard
    checklists_by_card = {}
    for cl in data.get('checklists', []):
        card_id_trello = cl.get('idCard')
        checklists_by_card.setdefault(card_id_trello, []).append(cl)

    # Позиция внутри каждой колонки
    col_positions = {}

    card_map = {}   # trello card id → наш card id
    card_count = 0
    skipped = 0

    cards_sorted = sorted(cards_raw, key=lambda c: c.get('pos', 0))

    for card in cards_sorted:
        trello_list_id = card.get('idList')
        col_id = list_map.get(trello_list_id)
        if col_id is None:
            skipped += 1
            continue  # карточка в архивированном списке, который не импортировали

        pos = col_positions.get(col_id, 0)
        col_positions[col_id] = pos + 1

        label_name, label_color = get_label(card.get('labels', []))
        due     = parse_due(card.get('due'))
        done    = 1 if card.get('dueComplete') else 0
        archived = 1 if card.get('closed') else 0

        cur = conn.execute(
            '''INSERT INTO cards
               (column_id, title, description, label, label_color,
                due_date, position, completed, archived)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)''',
            (
                col_id,
                card.get('name', '').strip() or '(без названия)',
                card.get('desc', ''),
                label_name,
                label_color,
                due,
                pos,
                done,
                archived,
            )
        )
        our_card_id = cur.lastrowid
        card_map[card['id']] = our_card_id
        card_count += 1

    print(f'  Карточек импортировано: {card_count}')
    if skipped:
        print(f'  Пропущено (архив): {skipped}')

    # ── Чеклисты ────────────────────────────────────────────────────────────
    item_count = 0
    for trello_card_id, our_card_id in card_map.items():
        checklists = checklists_by_card.get(trello_card_id, [])
        pos = 0
        for cl in checklists:
            items = sorted(cl.get('checkItems', []), key=lambda x: x.get('pos', 0))
            for item in items:
                text    = item.get('name', '').strip()
                checked = 1 if item.get('state') == 'complete' else 0
                conn.execute(
                    'INSERT INTO checklist_items (card_id, text, checked, position) VALUES (?, ?, ?, ?)',
                    (our_card_id, text, checked, pos)
                )
                pos += 1
                item_count += 1

    print(f'  Пунктов чеклистов: {item_count}')

    # ── Комментарии (actions → commentCard) ─────────────────────────────────
    member_map = build_member_map(data.get('members', []))
    comment_count = 0
    skipped_comments = 0

    # Trello хранит комментарии в actions; в JSON-экспорте — не более 1000 последних
    comment_actions = [
        a for a in data.get('actions', [])
        if a.get('type') in ('commentCard', 'copyCommentCard')
    ]
    comment_actions.sort(key=lambda a: a.get('date', ''))

    for action in comment_actions:
        card_data = (action.get('data') or {}).get('card') or {}
        trello_card_id = card_data.get('id')
        our_card_id = card_map.get(trello_card_id)
        if our_card_id is None:
            skipped_comments += 1
            continue

        text = ((action.get('data') or {}).get('text') or '').strip()
        if not text:
            continue

        author = get_comment_author(action, member_map)
        created_at = parse_datetime(action.get('date'))

        if created_at:
            conn.execute(
                'INSERT INTO comments (card_id, author, text, created_at) VALUES (?, ?, ?, ?)',
                (our_card_id, author, text, created_at),
            )
        else:
            conn.execute(
                'INSERT INTO comments (card_id, author, text) VALUES (?, ?, ?)',
                (our_card_id, author, text),
            )
        comment_count += 1

    print(f'  Комментариев импортировано: {comment_count}')
    if skipped_comments:
        print(f'  Комментариев пропущено (карточка не импортирована): {skipped_comments}')

    return {
        'columns': col_count,
        'cards': card_count,
        'cards_skipped': skipped,
        'checklist_items': item_count,
        'comments': comment_count,
        'comments_skipped': skipped_comments,
    }


def run(json_path, board_id, skip_archived):
    # Проверяем файл
    if not os.path.exists(json_path):
        print(f'Файл не найден: {json_path}')
        sys.exit(1)

    with open(json_path, encoding='utf-8') as f:
        data = json.load(f)

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA foreign_keys = ON')

    # Проверяем доску
    board = conn.execute('SELECT id, name FROM boards WHERE id=?', (board_id,)).fetchone()
    if not board:
        print(f'Доска с id={board_id} не найдена в базе данных.')
        conn.close()
        sys.exit(1)

    board_name = data.get('name', '(без названия)')
    print(f'\nИмпорт из Trello: «{board_name}»')
    print(f'Целевая доска: [{board_id}] {board["name"]}\n')

    import_board_data(conn, board_id, data, skip_archived)

    conn.commit()
    conn.close()

    print('\nИмпорт завершён успешно.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Импорт Trello JSON в Kanban DB')
    parser.add_argument('json_file',              help='Путь к JSON-файлу экспорта Trello')
    parser.add_argument('--board-id', type=int,   required=True, help='ID доски в нашем приложении')
    parser.add_argument('--skip-archived',         action='store_true',
                        help='Пропустить архивированные списки и карточки Trello')
    args = parser.parse_args()

    run(args.json_file, args.board_id, args.skip_archived)
