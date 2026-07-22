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
import uuid
import shutil
from datetime import datetime
from urllib.parse import unquote

DB_PATH        = os.path.join(os.path.dirname(__file__), 'kanban.db')
UPLOAD_FOLDER  = os.path.join(os.path.dirname(__file__), 'uploads')

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


def _fmt_size(n):
    for unit in ('Б', 'КБ', 'МБ', 'ГБ'):
        if n < 1024:
            return f'{n:.0f} {unit}'
        n /= 1024
    return f'{n:.0f} ГБ'


def _file_type(filename):
    ext = filename.rsplit('.', 1)[-1].lower() if '.' in filename else ''
    images = {'jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp'}
    docs   = {'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'csv'}
    if ext in images: return 'image'
    if ext in docs:   return 'document'
    return 'file'


def parse_due(due_str):
    """ISO 8601 → ДД.ММ.ГГГГ (формат, который использует фронт для срока), или пустая строка."""
    if not due_str:
        return ''
    try:
        dt = datetime.fromisoformat(due_str.replace('Z', '+00:00'))
        return dt.astimezone().strftime('%d.%m.%Y')
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


def match_existing_users(conn, member_map):
    """Сопоставляет участников Trello (id→имя) с уже существующими пользователями
    приложения по точному имени (без учёта регистра). Trello не отдаёт email в
    экспорте, поэтому это единственный доступный способ связки.
    Возвращает {trello_member_id: (email, имя_у_нас)} — только для совпавших."""
    rows = conn.execute('SELECT email, name FROM users').fetchall()
    by_name = {r['name'].strip().lower(): (r['email'], r['name']) for r in rows if r['name']}
    matched = {}
    for trello_id, name in member_map.items():
        hit = by_name.get(name.strip().lower())
        if hit:
            matched[trello_id] = hit
    return matched


def import_board_data(conn, board_id, data, skip_archived, source_dir=None):
    """Импортирует списки/карточки/метки/участников/чеклисты/вложения/комментарии
    Trello-доски (data) в существующую доску board_id. source_dir — папка с исходным
    JSON доски (в ней же лежит подпапка attachments/ с физическими файлами; без неё
    вложения не переносятся). Возвращает словарь со статистикой."""

    # ── Участники: сопоставляем Trello-участников доски с уже существующими
    #    пользователями приложения по имени (Trello не отдаёт email в экспорте) ──
    member_map      = build_member_map(data.get('members', []))   # trello_id → имя
    matched_users   = match_existing_users(conn, member_map)       # trello_id → (email, имя)
    unmatched_names = set()

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

    # Позиция внутри каждой колонки
    col_positions = {}

    card_map          = {}   # trello card id → наш card id
    card_by_trello_id = {}   # trello card id → исходный объект карточки Trello
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

        due      = parse_due(card.get('due'))
        done     = 1 if card.get('dueComplete') else 0
        archived = 1 if card.get('closed') else 0

        cur = conn.execute(
            '''INSERT INTO cards (column_id, title, description, due_date, position, completed, archived)
               VALUES (?, ?, ?, ?, ?, ?, ?)''',
            (
                col_id,
                card.get('name', '').strip() or '(без названия)',
                card.get('desc', ''),
                due,
                pos,
                done,
                archived,
            )
        )
        our_card_id = cur.lastrowid
        card_map[card['id']] = our_card_id
        card_by_trello_id[card['id']] = card
        card_count += 1

    print(f'  Карточек импортировано: {card_count}')
    if skipped:
        print(f'  Пропущено (архив): {skipped}')

    # ── Метки (все метки карточки, не только первая — через card_labels) ────
    label_count = 0
    for trello_card_id, our_card_id in card_map.items():
        card = card_by_trello_id[trello_card_id]
        for lbl_pos, lbl in enumerate(card.get('labels', [])):
            name  = (lbl.get('name') or '').strip()
            color = TRELLO_COLORS.get(lbl.get('color', ''), '#6b778c')
            conn.execute(
                'INSERT OR IGNORE INTO card_labels (card_id, name, color, position) VALUES (?,?,?,?)',
                (our_card_id, name, color, lbl_pos)
            )
            label_count += 1

    print(f'  Меток перенесено: {label_count}')

    # ── Участники карточки (только совпавшие с существующими пользователями) ─
    member_count = 0
    for trello_card_id, our_card_id in card_map.items():
        card = card_by_trello_id[trello_card_id]
        for trello_member_id in card.get('idMembers', []):
            hit = matched_users.get(trello_member_id)
            if hit:
                email, name = hit
                conn.execute(
                    'INSERT OR IGNORE INTO card_members (card_id, user_email, user_name) VALUES (?,?,?)',
                    (our_card_id, email, name)
                )
                member_count += 1
            else:
                name = member_map.get(trello_member_id, '')
                if name:
                    unmatched_names.add(name)

    print(f'  Участников карточек перенесено: {member_count}')

    # ── Чеклисты (именованные, со сроком/исполнителем на пункт) ─────────────
    # В экспорте Trello чек-листы карточки лежат внутри неё самой (card['checklists']),
    # отдельного top-level массива checklists в этом формате экспорта нет.
    checklist_count = 0
    item_count = 0
    for trello_card_id, our_card_id in card_map.items():
        card = card_by_trello_id[trello_card_id]
        checklists = sorted(card.get('checklists', []), key=lambda c: c.get('pos', 0))
        for cl_pos, cl in enumerate(checklists):
            title = (cl.get('name') or '').strip() or 'Чек-лист'
            cur = conn.execute(
                'INSERT INTO checklists (card_id, title, position) VALUES (?, ?, ?)',
                (our_card_id, title, cl_pos)
            )
            our_checklist_id = cur.lastrowid
            checklist_count += 1

            items = sorted(cl.get('checkItems', []), key=lambda x: x.get('pos', 0))
            for item_pos, item in enumerate(items):
                text    = item.get('name', '').strip()
                checked = 1 if item.get('state') == 'complete' else 0
                due     = parse_due(item.get('due'))

                assignee_email, assignee_name = '', ''
                trello_member_id = item.get('idMember')
                if trello_member_id:
                    hit = matched_users.get(trello_member_id)
                    if hit:
                        assignee_email, assignee_name = hit
                    else:
                        assignee_name = member_map.get(trello_member_id, '')
                        if assignee_name:
                            unmatched_names.add(assignee_name)

                conn.execute(
                    '''INSERT INTO checklist_items
                       (card_id, checklist_id, text, checked, position, due_date, assignee_email, assignee_name)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?)''',
                    (our_card_id, our_checklist_id, text, checked, item_pos, due, assignee_email, assignee_name)
                )
                item_count += 1

    print(f'  Чек-листов создано: {checklist_count}, пунктов: {item_count}')

    # ── Вложения (физические файлы из attachments/) ──────────────────────────
    attachment_count   = 0
    attachment_skipped = 0
    attachments_dir = os.path.join(source_dir, 'attachments') if source_dir else None
    for trello_card_id, our_card_id in card_map.items():
        card = card_by_trello_id[trello_card_id]
        for att in card.get('attachments', []):
            stored_name = att.get('fileName') or ''
            src_path = os.path.join(attachments_dir, stored_name) if (attachments_dir and stored_name) else ''
            if not src_path or not os.path.exists(src_path):
                attachment_skipped += 1
                continue

            original_name = unquote(att.get('originalFileName') or stored_name)
            ext       = ('.' + original_name.rsplit('.', 1)[-1]) if '.' in original_name else ''
            dest_name = uuid.uuid4().hex + ext
            card_dir  = os.path.join(UPLOAD_FOLDER, str(our_card_id))
            os.makedirs(card_dir, exist_ok=True)
            dest_path = os.path.join(card_dir, dest_name)
            shutil.copyfile(src_path, dest_path)

            size_str    = _fmt_size(os.path.getsize(dest_path))
            ftype       = _file_type(original_name)
            uploaded_at = parse_datetime(att.get('date'))

            if uploaded_at:
                conn.execute(
                    '''INSERT INTO attachments (card_id, filename, filesize, filetype, filepath, uploaded_at)
                       VALUES (?,?,?,?,?,?)''',
                    (our_card_id, original_name, size_str, ftype, dest_path, uploaded_at)
                )
            else:
                conn.execute(
                    'INSERT INTO attachments (card_id, filename, filesize, filetype, filepath) VALUES (?,?,?,?,?)',
                    (our_card_id, original_name, size_str, ftype, dest_path)
                )
            attachment_count += 1

    if attachments_dir:
        print(f'  Вложений перенесено: {attachment_count}')
        if attachment_skipped:
            print(f'  Вложений пропущено (файл не найден): {attachment_skipped}')
    else:
        attachment_skipped = sum(len(c.get('attachments', [])) for c in card_by_trello_id.values())
        if attachment_skipped:
            print(f'  Вложения не перенесены — не передана папка с исходным JSON ({attachment_skipped} шт.)')

    # ── Комментарии (actions → commentCard) ─────────────────────────────────
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

    if unmatched_names:
        print(f'  Несопоставленные участники ({len(unmatched_names)}): {", ".join(sorted(unmatched_names))}')

    return {
        'columns': col_count,
        'cards': card_count,
        'cards_skipped': skipped,
        'labels': label_count,
        'card_members': member_count,
        'checklists': checklist_count,
        'checklist_items': item_count,
        'attachments': attachment_count,
        'attachments_skipped': attachment_skipped,
        'comments': comment_count,
        'comments_skipped': skipped_comments,
        'unmatched_names': unmatched_names,
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

    source_dir = os.path.dirname(os.path.abspath(json_path))
    import_board_data(conn, board_id, data, skip_archived, source_dir=source_dir)

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
