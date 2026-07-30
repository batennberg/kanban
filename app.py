from dotenv import load_dotenv
load_dotenv()

from flask import Flask, render_template, redirect, url_for, session, request, jsonify, send_file
from models import get_db, init_db
from werkzeug.utils import secure_filename
from werkzeug.security import check_password_hash, generate_password_hash
import sqlite3, os, uuid, csv, io, shutil, re, json
from datetime import timedelta, datetime
from urllib.parse import quote as url_quote

UPLOAD_FOLDER   = os.path.join(os.path.dirname(__file__), 'uploads')
AVATARS_FOLDER  = os.path.join(os.path.dirname(__file__), 'static', 'uploads', 'avatars')
BOARD_BG_FOLDER = os.path.join(os.path.dirname(__file__), 'static', 'uploads', 'board-bg')
os.makedirs(UPLOAD_FOLDER,   exist_ok=True)
os.makedirs(AVATARS_FOLDER,  exist_ok=True)
os.makedirs(BOARD_BG_FOLDER, exist_ok=True)

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


def _normalize_mention_token(token):
    token = (token or '').strip().lstrip('@').rstrip('.,;:!?')
    return token.strip()


def _mention_matches(user_email, user_name, mention):
    mention = (mention or '').strip().lower()
    if not mention:
        return False
    email = (user_email or '').strip().lower()
    name = (user_name or '').strip().lower()
    if not email and not name:
        return False
    if mention in {email, name}:
        return True
    email_local = email.split('@', 1)[0] if '@' in email else ''
    if mention in {email_local}:
        return True
    name_parts = {p for p in re.split(r'[\s._-]+', name) if p}
    return mention in name_parts


def _extract_mentions(text):
    pattern = re.compile(r'(?<!\w)@([A-Za-z0-9._%+-]+(?:@[A-Za-z0-9.-]+\.[A-Za-z]{2,})?|[А-Яа-яЁёA-Za-z0-9._-]+)')
    return [_normalize_mention_token(match.group(1)) for match in pattern.finditer(text or '')]


def _find_mentioned_users(conn, text):
    seen = set()
    users = []
    for raw in _extract_mentions(text):
        mention = _normalize_mention_token(raw)
        if not mention or mention in seen:
            continue
        seen.add(mention)
        from sheets import is_configured, get_all_users
        if is_configured():
            for rec in get_all_users():
                email = str(rec.get('Email', '')).strip().lower()
                name = str(rec.get('Имя', email)).strip()
                if _mention_matches(email, name, mention):
                    users.append({'email': email, 'name': name, 'mention': mention})
                    break
        else:
            rows = conn.execute(
                '''
                SELECT email, name FROM users
                WHERE LOWER(email)=? OR LOWER(name)=? OR LOWER(name)=? OR LOWER(SUBSTR(email, 1, CASE WHEN INSTR(email, '@') > 0 THEN INSTR(email, '@') - 1 ELSE LENGTH(email) END))=?
                ''',
                (mention, mention, mention, mention)
            ).fetchall()
            if rows:
                row = rows[0]
                users.append({'email': row['email'], 'name': row['name'], 'mention': mention})
    return users


def _create_comment_mentions(conn, card_id, comment_id, text, actor_email, actor_name):
    mentions = []
    card_row = conn.execute('''
        SELECT c.title AS card_title, col.board_id, b.name AS board_name
        FROM cards c
        JOIN columns col ON col.id = c.column_id
        JOIN boards b ON b.id = col.board_id
        WHERE c.id = ?
    ''', (card_id,)).fetchone()
    for user in _find_mentioned_users(conn, text):
        if user['email'] == (actor_email or '').strip().lower():
            continue
        conn.execute(
            'INSERT OR IGNORE INTO comment_mentions (comment_id, mentioned_email, mentioned_name) VALUES (?,?,?)',
            (comment_id, user['email'], user['name'])
        )
        payload = json.dumps({
            'type': 'comment_mention',
            'card_id': card_id,
            'card_title': card_row['card_title'] if card_row else '',
            'board_id': card_row['board_id'] if card_row else None,
            'board_name': card_row['board_name'] if card_row else '',
            'comment_id': comment_id,
            'actor_email': actor_email,
            'actor_name': actor_name,
            'mention': user['mention'],
            'comment_excerpt': (text or '')[:180],
        })
        conn.execute(
            'INSERT INTO inbox_entries (recipient_email, type, card_id, comment_id, payload, board_id) VALUES (?,?,?,?,?,?)',
            (user['email'], 'comment_mention', card_id, comment_id, payload, card_row['board_id'] if card_row else None)
        )
        mentions.append(user)
    return mentions


def _admin_emails(conn):
    """Email-адреса всех admin — для уведомлений «какой пользователь удалил/архивировал» (Must №82)."""
    from sheets import is_configured, get_all_users
    if is_configured():
        return [
            str(u.get('Email', '')).strip().lower()
            for u in get_all_users()
            if str(u.get('Роль', 'user')).strip().lower() == 'admin'
        ]
    return [r['email'].strip().lower() for r in conn.execute("SELECT email FROM users WHERE role='admin'").fetchall()]


def _notify_admins(conn, type_, board_id, board_name, extra, card_id=0):
    """Уведомляет всех admin, кроме самого actor-а (Must №82: кто удалил карточку / перенёс в архив)."""
    actor = session.get('user') or {}
    actor_email = (actor.get('email') or '').strip().lower()
    payload = {
        'type': type_, 'board_id': board_id, 'board_name': board_name,
        'actor_email': actor.get('email'), 'actor_name': actor.get('name'),
        **extra,
    }
    payload_json = json.dumps(payload)
    for email in _admin_emails(conn):
        if email == actor_email:
            continue
        conn.execute(
            'INSERT INTO inbox_entries (recipient_email, type, card_id, payload, board_id) VALUES (?,?,?,?,?)',
            (email, type_, card_id, payload_json, board_id)
        )


def _sync_due_date_notifications(conn, user_email):
    """Лениво (при каждом открытии инбокса) проверяет карточки пользователя на просрочку
    и приближение срока — «срок сегодня» — и один раз создаёт уведомление по каждой,
    без фоновых задач/cron (Must №82, Should №23 «напоминания о сроке»)."""
    today_key = datetime.now().strftime('%Y%m%d')
    rows = conn.execute('''
        SELECT ca.id AS card_id, ca.title AS card_title, ca.due_date,
               col.board_id, b.name AS board_name,
               (substr(ca.due_date,7,4) || substr(ca.due_date,4,2) || substr(ca.due_date,1,2)) AS due_key
        FROM cards ca
        JOIN card_members cm ON cm.card_id = ca.id
        JOIN columns col ON col.id = ca.column_id
        JOIN boards b ON b.id = col.board_id
        WHERE cm.user_email = ?
          AND (ca.completed = 0 OR ca.completed IS NULL)
          AND (ca.archived = 0 OR ca.archived IS NULL)
          AND TRIM(COALESCE(ca.due_date, '')) != ''
          AND (substr(ca.due_date,7,4) || substr(ca.due_date,4,2) || substr(ca.due_date,1,2)) <= ?
    ''', (user_email, today_key)).fetchall()

    for r in rows:
        type_ = 'card_overdue' if r['due_key'] < today_key else 'card_due_today'
        exists = conn.execute(
            "SELECT 1 FROM inbox_entries WHERE recipient_email=? AND type=? AND card_id=?",
            (user_email, type_, r['card_id'])
        ).fetchone()
        if exists:
            continue
        payload = json.dumps({
            'type': type_, 'card_id': r['card_id'], 'card_title': r['card_title'],
            'board_id': r['board_id'], 'board_name': r['board_name'], 'due_date': r['due_date'],
        })
        conn.execute(
            'INSERT INTO inbox_entries (recipient_email, type, card_id, payload, board_id) VALUES (?,?,?,?,?)',
            (user_email, type_, r['card_id'], payload, r['board_id'])
        )


def _log_activity(conn, card_id, event_type, detail=''):
    actor = (session.get('user') or {}).get('name', '') if session else ''
    conn.execute(
        'INSERT INTO card_activity (card_id, event_type, actor_name, detail) VALUES (?,?,?,?)',
        (card_id, event_type, actor, detail)
    )


def _log_card_update_activity(conn, card_id, before, d):
    if 'title' in d and d['title'] != before['title']:
        _log_activity(conn, card_id, 'renamed', f"{before['title']} → {d['title']}")
    if 'description' in d and (d['description'] or '') != (before['description'] or ''):
        _log_activity(conn, card_id, 'description_changed')
    if 'due_date' in d and (d['due_date'] or '') != (before['due_date'] or ''):
        _log_activity(conn, card_id, 'due_date_changed' if d['due_date'] else 'due_date_removed', d['due_date'] or '')
    if 'start_date' in d and (d['start_date'] or '') != (before['start_date'] or ''):
        _log_activity(conn, card_id, 'start_date_changed' if d['start_date'] else 'start_date_removed', d['start_date'] or '')
    if 'completed' in d and bool(d['completed']) != bool(before['completed']):
        _log_activity(conn, card_id, 'completed' if d['completed'] else 'reopened')
    if 'column_id' in d and d['column_id'] and d['column_id'] != before['column_id']:
        cols = conn.execute(
            'SELECT id, name FROM columns WHERE id IN (?,?)', (before['column_id'], d['column_id'])
        ).fetchall()
        names = {c['id']: c['name'] for c in cols}
        _log_activity(conn, card_id, 'moved_column',
                      f"{names.get(before['column_id'], '?')} → {names.get(d['column_id'], '?')}")


# ===== ВАЖНОСТЬ =====
# Отдельная от произвольных меток характеристика карточки: ровно один уровень
# важности из фиксированного набора. При назначении карточка получает обложку
# того же цвета, при снятии обложка сбрасывается.

IMPORTANCE_LEVELS = [
    {'name': 'Срочно',            'color': '#de350b'},
    {'name': 'Средняя важность',  'color': '#ffab00'},
    {'name': 'Низкий приоритет',  'color': '#00875a'},
]
IMPORTANCE_COLORS = {l['name']: l['color'] for l in IMPORTANCE_LEVELS}


# ===== КАСТОМНЫЕ ПОЛЯ =====

CUSTOM_FIELD_TYPES = {'text', 'number', 'date', 'list', 'checkbox'}

def _card_custom_fields(conn, card_id):
    row = conn.execute(
        'SELECT co.board_id FROM cards c JOIN columns co ON co.id=c.column_id WHERE c.id=?',
        (card_id,)
    ).fetchone()
    if not row:
        return []
    values = {v['field_id']: v['value'] for v in conn.execute(
        'SELECT field_id, value FROM card_custom_field_values WHERE card_id=?', (card_id,)
    )}
    out = []
    for f in conn.execute(
        'SELECT * FROM custom_fields WHERE board_id=? ORDER BY position, id', (row['board_id'],)
    ):
        item = dict(f)
        item['value'] = values.get(f['id'], '')
        out.append(item)
    return out


# ===== DUPLICATE HELPERS (карточка → список → доска) =====
# Комментарии и вложения сознательно не копируются (как в Trello) — это история
# оригинала, а не шаблон для копии.

def _duplicate_card(conn, src_card_id, target_column_id, position, title_suffix='', field_id_map=None):
    src = conn.execute('SELECT * FROM cards WHERE id=?', (src_card_id,)).fetchone()
    cur = conn.execute(
        '''INSERT INTO cards
           (column_id, title, description, label, label_color, due_date, start_date, position, cover_color, importance)
           VALUES (?,?,?,?,?,?,?,?,?,?)''',
        (target_column_id, src['title'] + title_suffix, src['description'],
         src['label'], src['label_color'], src['due_date'], src['start_date'], position, src['cover_color'],
         src['importance'])
    )
    new_card_id = cur.lastrowid

    checklist_id_map = {}
    for cl in conn.execute('SELECT * FROM checklists WHERE card_id=? ORDER BY position', (src_card_id,)):
        new_cl = conn.execute(
            'INSERT INTO checklists (card_id, title, position) VALUES (?,?,?)',
            (new_card_id, cl['title'], cl['position'])
        )
        checklist_id_map[cl['id']] = new_cl.lastrowid

    for item in conn.execute(
        'SELECT * FROM checklist_items WHERE card_id=? ORDER BY position', (src_card_id,)
    ):
        conn.execute(
            '''INSERT INTO checklist_items
               (card_id, checklist_id, text, checked, position, due_date, assignee_email, assignee_name)
               VALUES (?,?,?,?,?,?,?,?)''',
            (new_card_id, checklist_id_map.get(item['checklist_id']), item['text'], item['checked'],
             item['position'], item['due_date'], item['assignee_email'], item['assignee_name'])
        )
    for m in conn.execute('SELECT * FROM card_members WHERE card_id=?', (src_card_id,)):
        conn.execute(
            'INSERT OR IGNORE INTO card_members (card_id, user_email, user_name) VALUES (?,?,?)',
            (new_card_id, m['user_email'], m['user_name'])
        )
    for lbl in conn.execute('SELECT * FROM card_labels WHERE card_id=? ORDER BY position', (src_card_id,)):
        conn.execute(
            'INSERT OR IGNORE INTO card_labels (card_id, name, color, position) VALUES (?,?,?,?)',
            (new_card_id, lbl['name'], lbl['color'], lbl['position'])
        )
    for lnk in conn.execute('SELECT * FROM card_links WHERE card_id=? ORDER BY position', (src_card_id,)):
        conn.execute(
            'INSERT INTO card_links (card_id, url, title, position) VALUES (?,?,?,?)',
            (new_card_id, lnk['url'], lnk['title'], lnk['position'])
        )

    src_board_id = conn.execute(
        'SELECT board_id FROM columns WHERE id=?', (src['column_id'],)
    ).fetchone()['board_id']
    target_board_id = conn.execute(
        'SELECT board_id FROM columns WHERE id=?', (target_column_id,)
    ).fetchone()['board_id']
    if field_id_map is not None or target_board_id == src_board_id:
        for v in conn.execute('SELECT * FROM card_custom_field_values WHERE card_id=?', (src_card_id,)):
            new_field_id = field_id_map.get(v['field_id']) if field_id_map is not None else v['field_id']
            if new_field_id:
                conn.execute(
                    'INSERT INTO card_custom_field_values (card_id, field_id, value) VALUES (?,?,?)',
                    (new_card_id, new_field_id, v['value'])
                )
    return new_card_id

def _duplicate_column(conn, src_col_id, target_board_id, position, name_suffix='', field_id_map=None):
    src = conn.execute('SELECT * FROM columns WHERE id=?', (src_col_id,)).fetchone()
    cur = conn.execute(
        'INSERT INTO columns (board_id, name, position, wip_limit) VALUES (?,?,?,?)',
        (target_board_id, src['name'] + name_suffix, position, src['wip_limit'] or 0)
    )
    new_col_id = cur.lastrowid
    cards = conn.execute(
        'SELECT id FROM cards WHERE column_id=? AND (archived=0 OR archived IS NULL) ORDER BY position',
        (src_col_id,)
    ).fetchall()
    for i, card in enumerate(cards):
        _duplicate_card(conn, card['id'], new_col_id, i, field_id_map=field_id_map)
    return new_col_id

def _duplicate_board(conn, src_board_id, name_suffix=' (копия)'):
    src = conn.execute('SELECT * FROM boards WHERE id=?', (src_board_id,)).fetchone()
    cur = conn.execute(
        'INSERT INTO boards (name, company, color, workspace_id, description) VALUES (?,?,?,?,?)',
        (src['name'] + name_suffix, src['company'], src['color'], src['workspace_id'], src['description'])
    )
    new_board_id = cur.lastrowid
    field_id_map = {}
    for f in conn.execute(
        'SELECT * FROM custom_fields WHERE board_id=? ORDER BY position, id', (src_board_id,)
    ):
        cur2 = conn.execute(
            'INSERT INTO custom_fields (board_id, name, type, options, show_on_card, position) VALUES (?,?,?,?,?,?)',
            (new_board_id, f['name'], f['type'], f['options'], f['show_on_card'], f['position'])
        )
        field_id_map[f['id']] = cur2.lastrowid
    cols = conn.execute(
        'SELECT id FROM columns WHERE board_id=? AND (archived=0 OR archived IS NULL) ORDER BY position',
        (src_board_id,)
    ).fetchall()
    for i, col in enumerate(cols):
        _duplicate_column(conn, col['id'], new_board_id, i, field_id_map=field_id_map)
    for row in conn.execute('SELECT user_id, expires_at FROM board_access WHERE board_id=?', (src_board_id,)):
        conn.execute(
            'INSERT OR IGNORE INTO board_access (user_id, board_id, expires_at) VALUES (?,?,?)',
            (row['user_id'], new_board_id, row['expires_at'])
        )
    return new_board_id


app = Flask(__name__)
app.secret_key = os.environ.get('SECRET_KEY') or 'dev-stub-key-change-in-prod'
app.config['SESSION_COOKIE_HTTPONLY'] = True
app.config['SESSION_COOKIE_SAMESITE'] = 'Lax'
app.config['MAX_CONTENT_LENGTH'] = 16 * 1024 * 1024  # 16 МБ
app.config['PERMANENT_SESSION_LIFETIME'] = timedelta(days=30)


@app.errorhandler(413)
def _too_large(e):
    return jsonify({'error': 'file_too_large', 'message': 'Файл слишком большой. Максимальный размер — 16 МБ.'}), 413


# Роль «наблюдатель» (viewer) — read-only доступ (Must №76). Блокируем централизованно
# любые изменяющие запросы, а не патчим каждый роут по отдельности — так гарантированно
# не остаётся забытых дыр. Чтение (GET) разрешено — доступ к конкретным доскам
# по-прежнему ограничивается через _get_board_ids() в каждом роуте, как и для role='user'.
_VIEWER_ALLOWED_MUTATION = re.compile(r'^/api/inbox/\d+/read$')

@app.before_request
def _enforce_viewer_readonly():
    if request.method in ('GET', 'HEAD', 'OPTIONS'):
        return
    user = session.get('user')
    if not user or user.get('role') != 'viewer':
        return
    if _VIEWER_ALLOWED_MUTATION.match(request.path):
        return
    return jsonify({'error': 'Роль «наблюдатель» — только просмотр, действие недоступно'}), 403


# ===== AUTH =====

@app.route('/')
def index():
    return redirect(url_for('login') if 'user' not in session else url_for('boards'))

@app.route('/login', methods=['GET', 'POST'])
def login():
    error = None
    if request.method == 'POST':
        email    = request.form.get('email', '').strip().lower()
        password = request.form.get('password', '')
        remember = bool(request.form.get('remember'))

        from sheets import is_configured, get_user, get_board_ids
        if is_configured():
            user_rec = get_user(email)
            if user_rec and str(user_rec.get('Пароль', '')) == password:
                role      = str(user_rec.get('Роль', 'user')).strip().lower()
                board_ids = get_board_ids(user_rec)
                sheets_name = str(user_rec.get('Имя', email))
                # Читаем локальный профиль — имя/аватар могут быть переопределены пользователем
                with get_db() as conn:
                    local = conn.execute(
                        'SELECT name, avatar_color, avatar_photo FROM users WHERE email=?', (email,)
                    ).fetchone()
                session['user'] = {
                    'name':         (local['name'] if local and local['name'] else sheets_name),
                    'email':        email,
                    'role':         role,
                    'board_ids':    board_ids,
                    'avatar_color': (local['avatar_color'] if local else None) or '#4361EE',
                    'avatar_photo': (local['avatar_photo'] if local else None),
                }
                session.permanent = remember
                return redirect(url_for('boards'))
        else:
            # Fallback: SQLite (если Google Sheets не настроен)
            with get_db() as conn:
                user = conn.execute('SELECT * FROM users WHERE email=?', (email,)).fetchone()
            if user and check_password_hash(user['password_hash'], password):
                if user['role'] == 'admin':
                    board_ids = None
                else:
                    with get_db() as conn:
                        board_ids = [r[0] for r in conn.execute('''
                            SELECT board_id FROM board_access
                            WHERE user_id=? AND (expires_at IS NULL OR expires_at='' OR expires_at >= date('now','localtime'))
                        ''', (user['id'],)).fetchall()]
                session['user'] = {
                    'id':           user['id'],
                    'name':         user['name'],
                    'email':        user['email'],
                    'role':         user['role'],
                    'board_ids':    board_ids,
                    'avatar_color': user['avatar_color'] or '#4361EE',
                    'avatar_photo': user['avatar_photo'],
                }
                session.permanent = remember
                return redirect(url_for('boards'))

        error = 'Неверный email или пароль'
    return render_template('login.html', error=error)

@app.route('/logout')
def logout():
    session.clear()
    return redirect(url_for('login'))


# ===== СТРАНИЦЫ =====

def _get_board_ids():
    """Возвращает список доступных board_id для текущего пользователя или None (все).

    Для SQLite-режима запрашивается свежий board_access при каждом вызове (а не
    кэш из сессии, выставленный при логине) — иначе отзыв доступа и истечение
    временного/гостевого приглашения (Must №78) не подействовали бы, пока
    пользователь не перелогинится."""
    from sheets import is_configured, get_user, get_board_ids
    if is_configured():
        user_rec = get_user(session['user']['email'])
        if not user_rec:
            return []
        return get_board_ids(user_rec)

    if session['user'].get('role') == 'admin':
        return None
    user_id = session['user'].get('id')
    if not user_id:
        return session['user'].get('board_ids')  # запасной вариант для старых сессий без id
    with get_db() as conn:
        rows = conn.execute('''
            SELECT board_id FROM board_access
            WHERE user_id=? AND (expires_at IS NULL OR expires_at='' OR expires_at >= date('now','localtime'))
        ''', (user_id,)).fetchall()
    return [r[0] for r in rows]


@app.route('/boards')
def boards():
    if 'user' not in session:
        return redirect(url_for('login'))
    board_ids = _get_board_ids()
    with get_db() as conn:
        q = '''
            SELECT b.*, w.name  AS workspace_name,
                         w.color AS workspace_color,
                         w.id    AS workspace_id
            FROM boards b
            LEFT JOIN workspaces w ON w.id = b.workspace_id
        '''
        if board_ids is None:
            rows = conn.execute(q + ' ORDER BY w.name, b.id').fetchall()
        elif len(board_ids) == 0:
            rows = []
        else:
            ph   = ','.join('?' * len(board_ids))
            rows = conn.execute(q + f' WHERE b.id IN ({ph}) ORDER BY w.name, b.id', board_ids).fetchall()

        all_workspaces = conn.execute('SELECT * FROM workspaces ORDER BY name').fetchall()

    boards_list = []
    for r in rows:
        b = dict(r)
        # Используем workspace_name как company для groupby в шаблоне
        b['company'] = b.get('workspace_name') or b.get('company') or 'Без проекта'
        boards_list.append(b)

    # Считаем количество доступных досок по workspace
    ws_counts = {}
    for b in boards_list:
        wid = b.get('workspace_id')
        if wid:
            ws_counts[wid] = ws_counts.get(wid, 0) + 1

    workspaces = []
    for w in all_workspaces:
        wd = dict(w)
        wd['board_count'] = ws_counts.get(wd['id'], 0)
        workspaces.append(wd)

    return render_template('boards.html',
                           boards=boards_list,
                           workspaces=workspaces,
                           user=session['user'])

@app.route('/board/<int:board_id>')
def board(board_id):
    if 'user' not in session:
        return redirect(url_for('login'))
    board_ids = _get_board_ids()
    if board_ids is not None and board_id not in board_ids:
        return redirect(url_for('boards'))
    with get_db() as conn:
        b = conn.execute('''
            SELECT b.*, w.name AS workspace_name, w.color AS workspace_color
            FROM boards b
            LEFT JOIN workspaces w ON w.id = b.workspace_id
            WHERE b.id=?
        ''', (board_id,)).fetchone()
        if not b:
            return redirect(url_for('boards'))
        board_data = dict(b)
        board_data['columns'] = []
        labels_by_card = {}
        for l in conn.execute('''
            SELECT cl.id, cl.card_id, cl.name, cl.color FROM card_labels cl
            JOIN cards ca ON ca.id = cl.card_id
            JOIN columns co ON co.id = ca.column_id
            WHERE co.board_id=? ORDER BY cl.position, cl.id
        ''', (board_id,)):
            labels_by_card.setdefault(l['card_id'], []).append(dict(l))

        members_by_card = {}
        for m in conn.execute('''
            SELECT cm.card_id, cm.user_email, cm.user_name FROM card_members cm
            JOIN cards ca ON ca.id = cm.card_id
            JOIN columns co ON co.id = ca.column_id
            WHERE co.board_id=? ORDER BY cm.id
        ''', (board_id,)):
            members_by_card.setdefault(m['card_id'], []).append(dict(m))

        custom_field_defs = [dict(f) for f in conn.execute(
            'SELECT * FROM custom_fields WHERE board_id=? ORDER BY position, id', (board_id,)
        )]
        board_data['custom_fields'] = custom_field_defs
        visible_fields = [f for f in custom_field_defs if f['show_on_card']]
        cf_values_by_card = {}
        if visible_fields:
            field_ids = [f['id'] for f in visible_fields]
            ph = ','.join('?' * len(field_ids))
            for v in conn.execute(f'''
                SELECT v.card_id, v.field_id, v.value FROM card_custom_field_values v
                JOIN cards ca ON ca.id = v.card_id
                JOIN columns co ON co.id = ca.column_id
                WHERE co.board_id=? AND v.field_id IN ({ph})
            ''', [board_id] + field_ids):
                cf_values_by_card.setdefault(v['card_id'], {})[v['field_id']] = v['value']

        mirror_rows = conn.execute('''
            SELECT cmi.id AS mirror_id, cmi.column_id AS mirror_column_id, cmi.position AS mirror_position,
                   c.id AS source_id, c.title, c.due_date, c.completed, c.importance,
                   src_col.name AS source_column_name, src_b.id AS source_board_id, src_b.name AS source_board_name
            FROM card_mirrors cmi
            JOIN cards c ON c.id = cmi.source_card_id
            JOIN columns src_col ON src_col.id = c.column_id
            JOIN boards src_b ON src_b.id = src_col.board_id
            JOIN columns target_col ON target_col.id = cmi.column_id
            WHERE target_col.board_id=? AND (c.archived=0 OR c.archived IS NULL)
            ORDER BY cmi.position
        ''', (board_id,)).fetchall()
        mirror_source_ids = [r['source_id'] for r in mirror_rows]
        mirror_labels_by_card = {}
        if mirror_source_ids:
            ph = ','.join('?' * len(mirror_source_ids))
            for l in conn.execute(
                f'SELECT * FROM card_labels WHERE card_id IN ({ph}) ORDER BY position, id', mirror_source_ids
            ):
                mirror_labels_by_card.setdefault(l['card_id'], []).append(dict(l))
        mirrors_by_column = {}
        for r in mirror_rows:
            m = dict(r)
            m['labels'] = mirror_labels_by_card.get(m['source_id'], [])
            m['importance_color'] = IMPORTANCE_COLORS.get(m.get('importance') or '', '')
            mirrors_by_column.setdefault(m['mirror_column_id'], []).append(m)

        for col in conn.execute(
            'SELECT * FROM columns WHERE board_id=? AND (archived=0 OR archived IS NULL) ORDER BY position',
            (board_id,)
        ):
            col_dict = dict(col)
            col_dict['cards'] = []
            for c in conn.execute(
                'SELECT * FROM cards WHERE column_id=? AND (archived=0 OR archived IS NULL) ORDER BY position', (col['id'],)
            ):
                card_dict = dict(c)
                card_dict['labels'] = labels_by_card.get(c['id'], [])
                card_dict['members'] = members_by_card.get(c['id'], [])
                card_dict['importance_color'] = IMPORTANCE_COLORS.get(card_dict.get('importance') or '', '')
                card_cf_values = cf_values_by_card.get(c['id'], {})
                card_dict['custom_fields'] = [
                    {'field_id': f['id'], 'name': f['name'], 'type': f['type'], 'value': card_cf_values[f['id']]}
                    for f in visible_fields if card_cf_values.get(f['id'])
                ]
                col_dict['cards'].append(card_dict)
            col_dict['mirrors'] = mirrors_by_column.get(col['id'], [])
            board_data['columns'].append(col_dict)
    return render_template('board.html', board=board_data, board_id=board_id, user=session['user'])


@app.route('/card/<int:card_id>')
def card_deep_link(card_id):
    if 'user' not in session:
        return redirect(url_for('login'))
    with get_db() as conn:
        row = conn.execute(
            'SELECT co.board_id FROM cards ca JOIN columns co ON co.id = ca.column_id WHERE ca.id=?',
            (card_id,)
        ).fetchone()
    if not row:
        return redirect(url_for('boards'))
    board_id  = row['board_id']
    board_ids = _get_board_ids()
    if board_ids is not None and board_id not in board_ids:
        return redirect(url_for('boards'))
    return redirect(url_for('board', board_id=board_id, card=card_id))


def _attach_card_extras(conn, rows):
    """Добавляет labels и importance_color к строкам карточек (общая часть для сводных лент задач)."""
    card_ids       = [r['id'] for r in rows]
    labels_by_card = {}
    if card_ids:
        ph = ','.join('?' * len(card_ids))
        for l in conn.execute(f'''
            SELECT * FROM card_labels WHERE card_id IN ({ph}) ORDER BY position, id
        ''', card_ids):
            labels_by_card.setdefault(l['card_id'], []).append(dict(l))

    cards = []
    for r in rows:
        c = dict(r)
        c['labels']           = labels_by_card.get(c['id'], [])
        c['importance_color'] = IMPORTANCE_COLORS.get(c.get('importance') or '', '')
        cards.append(c)
    return cards


@app.route('/workspace/<int:ws_id>/tasks')
def workspace_tasks(ws_id):
    """Сводный вид: карточки со всех доступных досок одного workspace одним списком (Must №41)."""
    if 'user' not in session:
        return redirect(url_for('login'))
    board_ids = _get_board_ids()

    with get_db() as conn:
        ws = conn.execute('SELECT * FROM workspaces WHERE id=?', (ws_id,)).fetchone()
        if not ws:
            return redirect(url_for('boards'))
        all_workspaces = [dict(w) for w in conn.execute('SELECT * FROM workspaces ORDER BY name')]

        bq     = 'SELECT id, name, color FROM boards WHERE workspace_id=?'
        params = [ws_id]
        if board_ids is not None:
            if len(board_ids) == 0:
                board_rows = []
            else:
                ph      = ','.join('?' * len(board_ids))
                bq     += f' AND id IN ({ph})'
                params += board_ids
                board_rows = conn.execute(bq, params).fetchall()
        else:
            board_rows = conn.execute(bq, params).fetchall()

        ws_boards    = [dict(b) for b in board_rows]
        ws_board_ids = [b['id'] for b in ws_boards]

        cards = []
        if ws_board_ids:
            ph   = ','.join('?' * len(ws_board_ids))
            rows = conn.execute(f'''
                SELECT ca.*, co.name AS column_name, b.name AS board_name, b.color AS board_color
                FROM cards ca
                JOIN columns co ON co.id = ca.column_id
                JOIN boards b ON b.id = co.board_id
                WHERE b.id IN ({ph}) AND (ca.archived=0 OR ca.archived IS NULL)
                ORDER BY (ca.due_date IS NULL OR ca.due_date=''), ca.completed,
                         substr(ca.due_date,7,4) || substr(ca.due_date,4,2) || substr(ca.due_date,1,2)
            ''', ws_board_ids).fetchall()
            cards = _attach_card_extras(conn, rows)

    return render_template('workspace_tasks.html',
                            workspace=dict(ws),
                            workspaces=all_workspaces,
                            boards=ws_boards,
                            cards=cards,
                            user=session['user'])


@app.route('/tasks/mine')
def my_tasks():
    """Личный вид «Мои задачи»: карточки, где я участник, через все доступные доски (Must №42)."""
    if 'user' not in session:
        return redirect(url_for('login'))
    board_ids  = _get_board_ids()
    user_email = session['user']['email']

    cards = []
    if board_ids is None or len(board_ids) > 0:
        with get_db() as conn:
            sql = '''
                SELECT ca.*, co.name AS column_name, b.name AS board_name, b.color AS board_color
                FROM cards ca
                JOIN columns co ON co.id = ca.column_id
                JOIN boards b ON b.id = co.board_id
                JOIN card_members cm ON cm.card_id = ca.id
                WHERE cm.user_email=? AND (ca.archived=0 OR ca.archived IS NULL)
            '''
            params = [user_email]
            if board_ids is not None:
                ph   = ','.join('?' * len(board_ids))
                sql += f' AND b.id IN ({ph})'
                params += board_ids
            sql += '''
                ORDER BY (ca.due_date IS NULL OR ca.due_date=''), ca.completed,
                         substr(ca.due_date,7,4) || substr(ca.due_date,4,2) || substr(ca.due_date,1,2)
            '''
            rows  = conn.execute(sql, params).fetchall()
            cards = _attach_card_extras(conn, rows)

    return render_template('my_tasks.html', cards=cards, user=session['user'])


# ===== API — BOARDS =====

@app.route('/api/boards', methods=['GET'])
def api_get_boards():
    if 'user' not in session: return jsonify({'error': 'unauthorized'}), 401
    board_ids = _get_board_ids()
    with get_db() as conn:
        q = '''
            SELECT b.id, b.name, b.color, b.bg_image, b.workspace_id,
                   w.name AS workspace_name, w.color AS workspace_color
            FROM boards b
            LEFT JOIN workspaces w ON w.id = b.workspace_id
        '''
        if board_ids is None:
            rows = conn.execute(q + ' ORDER BY w.name, b.name').fetchall()
        elif len(board_ids) == 0:
            return jsonify([])
        else:
            ph   = ','.join('?' * len(board_ids))
            rows = conn.execute(q + f' WHERE b.id IN ({ph}) ORDER BY w.name, b.name', board_ids).fetchall()
    return jsonify([dict(r) for r in rows])

@app.route('/api/boards', methods=['POST'])
def api_create_board():
    if 'user' not in session: return jsonify({'error': 'unauthorized'}), 401
    d = request.get_json()
    name = d.get('name', '').strip()
    if not name: return jsonify({'error': 'name required'}), 400
    workspace_id = d.get('workspace_id')
    color        = d.get('color', '#0052cc')
    description  = d.get('description', '')
    template_id  = d.get('template_id')
    with get_db() as conn:
        company = ''
        ws_color = color
        if workspace_id:
            ws = conn.execute('SELECT * FROM workspaces WHERE id=?', (workspace_id,)).fetchone()
            if ws:
                company  = ws['name']
                ws_color = ws['color']
        cur = conn.execute(
            'INSERT INTO boards (name,company,color,workspace_id,description) VALUES(?,?,?,?,?)',
            (name, company, color, workspace_id, description)
        )
        bid = cur.lastrowid

        # Из шаблона доски (Should №9) — переносим колонки и кастомные поля, без карточек
        if template_id:
            for col in conn.execute(
                'SELECT * FROM board_template_columns WHERE template_id=? ORDER BY position', (template_id,)
            ):
                conn.execute(
                    'INSERT INTO columns (board_id, name, position) VALUES (?,?,?)',
                    (bid, col['name'], col['position'])
                )
            for f in conn.execute(
                'SELECT * FROM board_template_custom_fields WHERE template_id=? ORDER BY position', (template_id,)
            ):
                conn.execute(
                    '''INSERT INTO custom_fields (board_id, name, type, options, show_on_card, position)
                       VALUES (?,?,?,?,?,?)''',
                    (bid, f['name'], f['type'], f['options'], f['show_on_card'], f['position'])
                )
    return jsonify({
        'id': bid, 'name': name, 'company': company,
        'color': color, 'workspace_id': workspace_id,
        'workspace_color': ws_color
    })


@app.route('/api/board-templates', methods=['GET'])
def api_get_board_templates():
    if 'user' not in session: return jsonify({'error': 'unauthorized'}), 401
    with get_db() as conn:
        rows = conn.execute('''
            SELECT bt.id, bt.name,
                   (SELECT COUNT(*) FROM board_template_columns WHERE template_id=bt.id) AS column_count
            FROM board_templates bt
            ORDER BY bt.name
        ''').fetchall()
    return jsonify([dict(r) for r in rows])


@app.route('/api/boards/<int:board_id>/save-as-template', methods=['POST'])
def api_save_board_as_template(board_id):
    """Сохраняет структуру доски (колонки + кастомные поля, без карточек) как шаблон
    для создания новых досок (Should №9)."""
    if 'user' not in session: return jsonify({'error': 'unauthorized'}), 401
    name = (request.get_json() or {}).get('name', '').strip()
    if not name:
        return jsonify({'error': 'name required'}), 400
    board_ids = _get_board_ids()
    if board_ids is not None and board_id not in board_ids:
        return jsonify({'error': 'forbidden'}), 403
    with get_db() as conn:
        cur = conn.execute('INSERT INTO board_templates (name) VALUES (?)', (name,))
        template_id = cur.lastrowid

        for col in conn.execute(
            'SELECT * FROM columns WHERE board_id=? AND (archived=0 OR archived IS NULL) ORDER BY position',
            (board_id,)
        ):
            conn.execute(
                'INSERT INTO board_template_columns (template_id, name, position) VALUES (?,?,?)',
                (template_id, col['name'], col['position'])
            )
        for f in conn.execute('SELECT * FROM custom_fields WHERE board_id=? ORDER BY position', (board_id,)):
            conn.execute(
                '''INSERT INTO board_template_custom_fields
                   (template_id, name, type, options, show_on_card, position) VALUES (?,?,?,?,?,?)''',
                (template_id, f['name'], f['type'], f['options'], f['show_on_card'], f['position'])
            )
    return jsonify({'id': template_id, 'name': name}), 201


@app.route('/api/board-templates/<int:template_id>', methods=['DELETE'])
def api_delete_board_template(template_id):
    if 'user' not in session: return jsonify({'error': 'unauthorized'}), 401
    with get_db() as conn:
        conn.execute('DELETE FROM board_templates WHERE id=?', (template_id,))
    return jsonify({'ok': True})

@app.route('/api/boards/<int:board_id>/duplicate', methods=['POST'])
def api_duplicate_board(board_id):
    if 'user' not in session: return jsonify({'error': 'unauthorized'}), 401
    board_ids = _get_board_ids()
    if board_ids is not None and board_id not in board_ids:
        return jsonify({'error': 'forbidden'}), 403
    with get_db() as conn:
        src = conn.execute('SELECT * FROM boards WHERE id=?', (board_id,)).fetchone()
        if not src: return jsonify({'error': 'not found'}), 404
        new_board_id = _duplicate_board(conn, board_id)
        b = conn.execute('''
            SELECT b.id, b.name, b.company, b.color, b.bg_image, b.workspace_id,
                   w.name AS workspace_name, w.color AS workspace_color
            FROM boards b LEFT JOIN workspaces w ON w.id = b.workspace_id
            WHERE b.id=?
        ''', (new_board_id,)).fetchone()
    return jsonify(dict(b))

@app.route('/api/boards/<int:board_id>', methods=['PUT'])
def api_update_board(board_id):
    if 'user' not in session: return jsonify({'error': 'unauthorized'}), 401
    board_ids = _get_board_ids()
    if board_ids is not None and board_id not in board_ids:
        return jsonify({'error': 'forbidden'}), 403
    d = request.get_json()
    name  = d.get('name', '').strip()
    color = d.get('color', '').strip()
    if not name and not color:
        return jsonify({'error': 'nothing to update'}), 400
    with get_db() as conn:
        b = conn.execute('SELECT * FROM boards WHERE id=?', (board_id,)).fetchone()
        if not b: return jsonify({'error': 'not found'}), 404
        new_name  = name  or b['name']
        new_color = color or b['color']
        conn.execute('UPDATE boards SET name=?, color=? WHERE id=?', (new_name, new_color, board_id))
    return jsonify({'ok': True, 'name': new_name, 'color': new_color})

@app.route('/api/boards/<int:board_id>/workspace', methods=['PUT'])
def api_move_board_workspace(board_id):
    if 'user' not in session or session['user'].get('role') != 'admin':
        return jsonify({'error': 'forbidden'}), 403
    d = request.get_json() or {}
    workspace_id = d.get('workspace_id') or None
    with get_db() as conn:
        board = conn.execute('SELECT * FROM boards WHERE id=?', (board_id,)).fetchone()
        if not board:
            return jsonify({'error': 'not found'}), 404
        company, ws_color = '', board['color']
        if workspace_id:
            ws = conn.execute('SELECT * FROM workspaces WHERE id=?', (workspace_id,)).fetchone()
            if not ws:
                return jsonify({'error': 'workspace not found'}), 404
            company, ws_color = ws['name'], ws['color']
        conn.execute('UPDATE boards SET workspace_id=?, company=? WHERE id=?', (workspace_id, company, board_id))
    return jsonify({
        'ok': True, 'workspace_id': workspace_id,
        'workspace_name': company, 'workspace_color': ws_color
    })

@app.route('/api/boards/<int:board_id>/background', methods=['POST'])
def api_board_background_upload(board_id):
    if 'user' not in session: return jsonify({'error': 'unauthorized'}), 401
    board_ids = _get_board_ids()
    if board_ids is not None and board_id not in board_ids:
        return jsonify({'error': 'forbidden'}), 403
    f = request.files.get('file')
    if not f or not f.filename: return jsonify({'error': 'no file'}), 400
    ext = f.filename.rsplit('.', 1)[-1].lower() if '.' in f.filename else ''
    if ext not in {'jpg', 'jpeg', 'png', 'gif', 'webp'}:
        return jsonify({'error': 'unsupported format'}), 400
    filename = f'{uuid.uuid4().hex}.{ext}'
    with get_db() as conn:
        b = conn.execute('SELECT bg_image FROM boards WHERE id=?', (board_id,)).fetchone()
        if not b: return jsonify({'error': 'not found'}), 404
        if b['bg_image']:
            old_path = os.path.join(BOARD_BG_FOLDER, b['bg_image'])
            if os.path.exists(old_path):
                os.remove(old_path)
        f.save(os.path.join(BOARD_BG_FOLDER, filename))
        conn.execute('UPDATE boards SET bg_image=? WHERE id=?', (filename, board_id))
    return jsonify({'ok': True, 'bg_url': f'/static/uploads/board-bg/{filename}'})

@app.route('/api/boards/<int:board_id>/background', methods=['DELETE'])
def api_board_background_delete(board_id):
    if 'user' not in session: return jsonify({'error': 'unauthorized'}), 401
    board_ids = _get_board_ids()
    if board_ids is not None and board_id not in board_ids:
        return jsonify({'error': 'forbidden'}), 403
    with get_db() as conn:
        b = conn.execute('SELECT bg_image FROM boards WHERE id=?', (board_id,)).fetchone()
        if not b: return jsonify({'error': 'not found'}), 404
        if b['bg_image']:
            old_path = os.path.join(BOARD_BG_FOLDER, b['bg_image'])
            if os.path.exists(old_path):
                os.remove(old_path)
            conn.execute('UPDATE boards SET bg_image=NULL WHERE id=?', (board_id,))
    return jsonify({'ok': True})


@app.route('/api/boards/<int:board_id>', methods=['DELETE'])
def api_delete_board(board_id):
    if 'user' not in session or session['user']['role'] != 'admin':
        return jsonify({'error': 'forbidden'}), 403
    with get_db() as conn:
        board = conn.execute('SELECT * FROM boards WHERE id=?', (board_id,)).fetchone()
        if not board:
            return jsonify({'error': 'not found'}), 404

        col_ids = [r[0] for r in conn.execute('SELECT id FROM columns WHERE board_id=?', (board_id,)).fetchall()]
        card_ids = []
        if col_ids:
            ph = ','.join('?' * len(col_ids))
            card_ids = [r[0] for r in conn.execute(f'SELECT id FROM cards WHERE column_id IN ({ph})', col_ids).fetchall()]
        if card_ids:
            ph = ','.join('?' * len(card_ids))
            conn.execute(f'DELETE FROM checklist_items WHERE card_id IN ({ph})', card_ids)
            conn.execute(f'DELETE FROM checklists WHERE card_id IN ({ph})', card_ids)
            conn.execute(f'DELETE FROM comments WHERE card_id IN ({ph})', card_ids)
            conn.execute(f'DELETE FROM attachments WHERE card_id IN ({ph})', card_ids)
            conn.execute(f'DELETE FROM card_members WHERE card_id IN ({ph})', card_ids)
            conn.execute(f'DELETE FROM cards WHERE id IN ({ph})', card_ids)
        conn.execute('DELETE FROM columns WHERE board_id=?', (board_id,))
        conn.execute('DELETE FROM board_access WHERE board_id=?', (board_id,))
        bg_image = board['bg_image']
        conn.execute('DELETE FROM boards WHERE id=?', (board_id,))

    if bg_image:
        bg_path = os.path.join(BOARD_BG_FOLDER, bg_image)
        if os.path.exists(bg_path):
            os.remove(bg_path)
    for card_id in card_ids:
        shutil.rmtree(os.path.join(UPLOAD_FOLDER, str(card_id)), ignore_errors=True)

    return jsonify({'ok': True})


# ===== API — WORKSPACES =====

@app.route('/api/workspaces', methods=['GET'])
def api_get_workspaces():
    if 'user' not in session: return jsonify({'error': 'unauthorized'}), 401
    with get_db() as conn:
        rows = conn.execute('SELECT * FROM workspaces ORDER BY name').fetchall()
    return jsonify([dict(r) for r in rows])

@app.route('/api/workspaces', methods=['POST'])
def api_create_workspace():
    if 'user' not in session or session['user']['role'] != 'admin':
        return jsonify({'error': 'forbidden'}), 403
    d    = request.get_json()
    name = d.get('name', '').strip()
    if not name: return jsonify({'error': 'name required'}), 400
    with get_db() as conn:
        try:
            cur = conn.execute(
                'INSERT INTO workspaces (name, color) VALUES(?,?)',
                (name, d.get('color', '#0052cc'))
            )
            wid = cur.lastrowid
            ws  = dict(conn.execute('SELECT * FROM workspaces WHERE id=?', (wid,)).fetchone())
        except sqlite3.IntegrityError:
            return jsonify({'error': 'already exists'}), 409
    return jsonify(ws), 201

@app.route('/api/workspaces/<int:ws_id>', methods=['PUT'])
def api_update_workspace(ws_id):
    if 'user' not in session or session['user']['role'] != 'admin':
        return jsonify({'error': 'forbidden'}), 403
    d = request.get_json()
    fields, values = [], []
    for f in ['name', 'color']:
        if f in d:
            fields.append(f'{f}=?')
            values.append(d[f])
    if fields:
        values.append(ws_id)
        with get_db() as conn:
            conn.execute(f'UPDATE workspaces SET {",".join(fields)} WHERE id=?', values)
    return jsonify({'ok': True})

@app.route('/api/workspaces/<int:ws_id>', methods=['DELETE'])
def api_delete_workspace(ws_id):
    if 'user' not in session or session['user']['role'] != 'admin':
        return jsonify({'error': 'forbidden'}), 403
    with get_db() as conn:
        # Отвязываем доски от workspace (не удаляем)
        conn.execute('UPDATE boards SET workspace_id=NULL WHERE workspace_id=?', (ws_id,))
        conn.execute('DELETE FROM workspaces WHERE id=?', (ws_id,))
    return jsonify({'ok': True})


# ===== API — USERS =====

@app.route('/api/users', methods=['GET'])
def api_get_users():
    if 'user' not in session: return jsonify({'error': 'unauthorized'}), 401
    if session['user'].get('role') != 'admin': return jsonify({'error': 'forbidden'}), 403
    from sheets import is_configured, get_all_users
    if not is_configured():
        with get_db() as conn:
            rows = conn.execute('SELECT id, email, name, role FROM users ORDER BY id').fetchall()
        return jsonify([dict(r) for r in rows])
    users = get_all_users()
    return jsonify([{
        'email':  u.get('Email', ''),
        'name':   u.get('Имя', ''),
        'role':   u.get('Роль', 'user'),
        'boards': u.get('Доски', ''),
    } for u in users])


_VALID_ROLES = ('admin', 'user', 'viewer')

@app.route('/api/users', methods=['POST'])
def api_create_user():
    if 'user' not in session: return jsonify({'error': 'unauthorized'}), 401
    if session['user'].get('role') != 'admin': return jsonify({'error': 'forbidden'}), 403
    d        = request.get_json()
    email    = d.get('email', '').strip().lower()
    name     = d.get('name', '').strip()
    password = d.get('password', '').strip()
    role     = d.get('role', 'user').strip().lower()
    boards   = d.get('boards', '').strip()
    if not email or not name or not password:
        return jsonify({'error': 'email, name и password обязательны'}), 400
    if role not in _VALID_ROLES:
        return jsonify({'error': 'недопустимая роль'}), 400

    from sheets import is_configured, create_user, get_user
    if is_configured():
        if get_user(email):
            return jsonify({'error': 'Пользователь с таким email уже существует'}), 409
        create_user(email, name, password, role, boards)
        return jsonify({'email': email, 'name': name, 'role': role, 'boards': boards}), 201

    with get_db() as conn:
        if conn.execute('SELECT 1 FROM users WHERE email=?', (email,)).fetchone():
            return jsonify({'error': 'Пользователь с таким email уже существует'}), 409
        cur = conn.execute(
            'INSERT INTO users (email, name, password_hash, role) VALUES (?,?,?,?)',
            (email, name, generate_password_hash(password), role)
        )
        user_id = cur.lastrowid
        if role != 'admin' and boards:
            for bid in (b.strip() for b in boards.split(',')):
                if bid.isdigit():
                    conn.execute('INSERT OR IGNORE INTO board_access (user_id, board_id) VALUES (?,?)', (user_id, int(bid)))
    return jsonify({'email': email, 'name': name, 'role': role, 'boards': boards}), 201


@app.route('/api/users/<path:email>', methods=['PUT'])
def api_update_user(email):
    if 'user' not in session: return jsonify({'error': 'unauthorized'}), 401
    if session['user'].get('role') != 'admin': return jsonify({'error': 'forbidden'}), 403
    d        = request.get_json()
    name     = d.get('name',     '').strip() or None
    password = d.get('password', '').strip() or None
    role     = d.get('role',     '').strip() or None
    boards   = d.get('boards')  # может быть пустой строкой — это валидно
    if isinstance(boards, str):
        boards = boards.strip()
    if role is not None and role not in _VALID_ROLES:
        return jsonify({'error': 'недопустимая роль'}), 400

    from sheets import is_configured, update_user
    if is_configured():
        ok = update_user(email, name=name, password=password, role=role, boards=boards)
        return jsonify({'ok': ok}) if ok else (jsonify({'error': 'не найден'}), 404)

    with get_db() as conn:
        user = conn.execute('SELECT id FROM users WHERE email=?', (email,)).fetchone()
        if not user:
            return jsonify({'error': 'не найден'}), 404
        if name is not None:
            conn.execute('UPDATE users SET name=? WHERE email=?', (name, email))
        if password is not None:
            conn.execute('UPDATE users SET password_hash=? WHERE email=?', (generate_password_hash(password), email))
        if role is not None:
            conn.execute('UPDATE users SET role=? WHERE email=?', (role, email))
        if boards is not None:
            conn.execute('DELETE FROM board_access WHERE user_id=?', (user['id'],))
            for bid in (b.strip() for b in boards.split(',')):
                if bid.isdigit():
                    conn.execute('INSERT OR IGNORE INTO board_access (user_id, board_id) VALUES (?,?)', (user['id'], int(bid)))
    return jsonify({'ok': True})


@app.route('/api/users/<path:email>', methods=['DELETE'])
def api_delete_user(email):
    if 'user' not in session: return jsonify({'error': 'unauthorized'}), 401
    if session['user'].get('role') != 'admin': return jsonify({'error': 'forbidden'}), 403
    from sheets import is_configured, delete_user
    if is_configured():
        ok = delete_user(email)
        if not ok:
            return jsonify({'error': 'не найден'}), 404
    with get_db() as conn:
        conn.execute('DELETE FROM users WHERE email=?', (email,))
    return jsonify({'ok': True})


# ===== API — COLUMNS =====

@app.route('/api/columns', methods=['POST'])
def api_create_column():
    if 'user' not in session: return jsonify({'error': 'unauthorized'}), 401
    d = request.get_json()
    board_id, name = d.get('board_id'), d.get('name', '').strip()
    if not board_id or not name: return jsonify({'error': 'missing fields'}), 400
    with get_db() as conn:
        pos = conn.execute('SELECT COALESCE(MAX(position),-1)+1 FROM columns WHERE board_id=?', (board_id,)).fetchone()[0]
        cur = conn.execute('INSERT INTO columns (board_id,name,position) VALUES(?,?,?)', (board_id, name, pos))
        cid = cur.lastrowid
    return jsonify({'id': cid, 'name': name})


@app.route('/api/boards/<int:board_id>/columns', methods=['GET'])
def api_get_board_columns(board_id):
    if 'user' not in session: return jsonify({'error': 'unauthorized'}), 401
    board_ids = _get_board_ids()
    if board_ids is not None and board_id not in board_ids:
        return jsonify({'error': 'forbidden'}), 403
    with get_db() as conn:
        rows = conn.execute(
            'SELECT id, name FROM columns WHERE board_id=? AND (archived=0 OR archived IS NULL) ORDER BY position',
            (board_id,)
        ).fetchall()
    return jsonify([dict(r) for r in rows])


@app.route('/api/boards/<int:board_id>/members', methods=['GET'])
def api_get_board_members(board_id):
    """Список людей с доступом к доске (для назначения исполнителя пункта чек-листа) — доступен любому пользователю с доступом к доске, не только admin."""
    if 'user' not in session: return jsonify({'error': 'unauthorized'}), 401
    board_ids = _get_board_ids()
    if board_ids is not None and board_id not in board_ids:
        return jsonify({'error': 'forbidden'}), 403

    # Обычный пользователь не должен видеть admin-ов как участников доски —
    # только тех, кому явно выдан доступ. Admin по-прежнему видит и себя, и всех остальных.
    viewer_is_admin = session['user'].get('role') == 'admin'

    from sheets import is_configured, get_all_users, get_board_ids as sheets_get_board_ids
    if is_configured():
        result = []
        for u in get_all_users():
            target_role = str(u.get('Роль', 'user')).strip().lower()
            if not viewer_is_admin and target_role == 'admin':
                continue
            ids = sheets_get_board_ids(u)
            if ids is None or board_id in ids:
                email = str(u.get('Email', '')).strip().lower()
                result.append({'email': email, 'name': str(u.get('Имя', email))})
        return jsonify(result)

    with get_db() as conn:
        if viewer_is_admin:
            rows = conn.execute('''
                SELECT DISTINCT u.email, u.name
                FROM users u
                LEFT JOIN board_access ba ON ba.user_id = u.id AND ba.board_id = ?
                    AND (ba.expires_at IS NULL OR ba.expires_at='' OR ba.expires_at >= date('now','localtime'))
                WHERE u.role = 'admin' OR ba.user_id IS NOT NULL
                ORDER BY u.name
            ''', (board_id,)).fetchall()
        else:
            rows = conn.execute('''
                SELECT DISTINCT u.email, u.name
                FROM users u
                JOIN board_access ba ON ba.user_id = u.id AND ba.board_id = ?
                    AND (ba.expires_at IS NULL OR ba.expires_at='' OR ba.expires_at >= date('now','localtime'))
                WHERE u.role != 'admin'
                ORDER BY u.name
            ''', (board_id,)).fetchall()
    return jsonify([dict(r) for r in rows])


@app.route('/api/columns/<int:col_id>/duplicate', methods=['POST'])
def api_duplicate_column(col_id):
    """Дублирует колонку в той же доске, либо (с `target_board_id`) копирует список
    со всеми карточками на другую доску (Ваша заявка). Кастомные поля карточек
    при копировании на другую доску не переносятся — они специфичны для схемы
    исходной доски и не обязаны существовать на целевой; всё остальное (метки,
    чек-листы, участники, ссылки) переносится как обычно."""
    if 'user' not in session: return jsonify({'error': 'unauthorized'}), 401
    d = request.get_json(silent=True) or {}
    target_board_id = d.get('target_board_id')
    with get_db() as conn:
        src = conn.execute('SELECT * FROM columns WHERE id=?', (col_id,)).fetchone()
        if not src: return jsonify({'error': 'not found'}), 404
        target_board_id = int(target_board_id) if target_board_id else src['board_id']
        cross_board = target_board_id != src['board_id']
        if cross_board:
            board_ids = _get_board_ids()
            if board_ids is not None and target_board_id not in board_ids:
                return jsonify({'error': 'forbidden'}), 403
            if not conn.execute('SELECT 1 FROM boards WHERE id=?', (target_board_id,)).fetchone():
                return jsonify({'error': 'target board not found'}), 404

        pos = conn.execute(
            'SELECT COALESCE(MAX(position),-1)+1 FROM columns WHERE board_id=?', (target_board_id,)
        ).fetchone()[0]
        name_suffix = '' if cross_board else ' (копия)'
        new_col_id = _duplicate_column(conn, col_id, target_board_id, pos, name_suffix=name_suffix)
        new_col = dict(conn.execute('SELECT * FROM columns WHERE id=?', (new_col_id,)).fetchone())
        new_col['cards'] = [dict(c) for c in conn.execute(
            'SELECT * FROM cards WHERE column_id=? ORDER BY position', (new_col_id,)
        )]
    return jsonify(new_col)


# ===== API — CARDS =====

@app.route('/api/cards', methods=['POST'])
def api_create_card():
    if 'user' not in session: return jsonify({'error': 'unauthorized'}), 401
    d = request.get_json()
    col_id, title = d.get('column_id'), d.get('title', '').strip()
    if not col_id or not title: return jsonify({'error': 'missing fields'}), 400
    with get_db() as conn:
        pos = conn.execute('SELECT COALESCE(MAX(position),-1)+1 FROM cards WHERE column_id=?', (col_id,)).fetchone()[0]
        cur = conn.execute(
            'INSERT INTO cards (column_id,title,label,label_color,due_date,start_date,position) VALUES(?,?,?,?,?,?,?)',
            (col_id, title, d.get('label',''), d.get('label_color',''), d.get('due_date',''), d.get('start_date',''), pos)
        )
        card_id = cur.lastrowid
        _log_activity(conn, card_id, 'created')
        card = dict(conn.execute('SELECT * FROM cards WHERE id=?', (card_id,)).fetchone())
    return jsonify(card)

@app.route('/api/cards/<int:card_id>', methods=['GET'])
def api_get_card(card_id):
    if 'user' not in session: return jsonify({'error': 'unauthorized'}), 401
    with get_db() as conn:
        card = conn.execute('SELECT * FROM cards WHERE id=?', (card_id,)).fetchone()
        if not card: return jsonify({'error': 'not found'}), 404
        card_dict = dict(card)
        comments = []
        for c in conn.execute('SELECT * FROM comments WHERE card_id=? ORDER BY created_at', (card_id,)):
            comment_dict = dict(c)
            mention_rows = conn.execute(
                'SELECT mentioned_email, mentioned_name FROM comment_mentions WHERE comment_id=? ORDER BY id',
                (c['id'],)
            ).fetchall()
            allowed_emails = {row['mentioned_email'] for row in mention_rows}
            resolved_mentions = []
            for user in _find_mentioned_users(conn, comment_dict['text']):
                if user['email'] in allowed_emails:
                    resolved_mentions.append(user)
            comment_dict['mentions'] = resolved_mentions
            comments.append(comment_dict)
        attachments = [dict(a) for a in conn.execute(
            'SELECT * FROM attachments WHERE card_id=? ORDER BY uploaded_at', (card_id,)
        )]
        checklist_rows = conn.execute(
            'SELECT * FROM checklists WHERE card_id=? ORDER BY position', (card_id,)
        ).fetchall()
        item_rows = conn.execute(
            'SELECT * FROM checklist_items WHERE card_id=? ORDER BY position', (card_id,)
        ).fetchall()
        items_by_checklist = {}
        for it in item_rows:
            items_by_checklist.setdefault(it['checklist_id'], []).append(dict(it))
        checklists = [{**dict(cl), 'items': items_by_checklist.get(cl['id'], [])} for cl in checklist_rows]
        members = [dict(m) for m in conn.execute(
            'SELECT * FROM card_members WHERE card_id=? ORDER BY id', (card_id,)
        )]
        labels = [dict(l) for l in conn.execute(
            'SELECT * FROM card_labels WHERE card_id=? ORDER BY position, id', (card_id,)
        )]
        links = [dict(l) for l in conn.execute(
            'SELECT * FROM card_links WHERE card_id=? ORDER BY position, id', (card_id,)
        )]
        relations = [dict(r) for r in conn.execute('''
            SELECT c.id, c.title, c.completed, col.name AS column_name,
                   b.id AS board_id, b.name AS board_name, b.color AS board_color
            FROM card_relations rel
            JOIN cards c ON c.id = (CASE WHEN rel.card_a_id=? THEN rel.card_b_id ELSE rel.card_a_id END)
            JOIN columns col ON col.id = c.column_id
            JOIN boards b ON b.id = col.board_id
            WHERE rel.card_a_id=? OR rel.card_b_id=?
            ORDER BY b.name, col.name, c.title
        ''', (card_id, card_id, card_id))]
        activity = [dict(a) for a in conn.execute(
            'SELECT * FROM card_activity WHERE card_id=? ORDER BY created_at DESC, id DESC', (card_id,)
        )]
        custom_fields = _card_custom_fields(conn, card_id)
        if card_dict.get('linked_board_id'):
            lb = conn.execute('SELECT id, name, color FROM boards WHERE id=?',
                              (card_dict['linked_board_id'],)).fetchone()
            if lb:
                card_dict['linked_board_name']  = lb['name']
                card_dict['linked_board_color'] = lb['color']
        card_dict['importance_color'] = IMPORTANCE_COLORS.get(card_dict.get('importance') or '', '')
    return jsonify({**card_dict, 'comments': comments, 'attachments': attachments,
                    'checklists': checklists, 'members': members, 'labels': labels, 'links': links,
                    'relations': relations, 'activity': activity, 'custom_fields': custom_fields})

@app.route('/api/cards/<int:card_id>', methods=['PUT'])
def api_update_card(card_id):
    if 'user' not in session: return jsonify({'error': 'unauthorized'}), 401
    d = request.get_json()
    allowed = ['title', 'description', 'label', 'label_color', 'due_date', 'start_date', 'column_id', 'position', 'completed', 'cover_color', 'linked_board_id']
    fields, values = [], []
    for f in allowed:
        if f in d:
            fields.append(f'{f}=?')
            values.append(d[f])
    if fields:
        with get_db() as conn:
            before = conn.execute('SELECT * FROM cards WHERE id=?', (card_id,)).fetchone()
            values.append(card_id)
            conn.execute(f'UPDATE cards SET {",".join(fields)} WHERE id=?', values)
            if before:
                _log_card_update_activity(conn, card_id, before, d)
    return jsonify({'ok': True})

@app.route('/api/cards/<int:card_id>', methods=['DELETE'])
def api_delete_card(card_id):
    if 'user' not in session: return jsonify({'error': 'unauthorized'}), 401
    with get_db() as conn:
        conn.execute(
            "UPDATE cards SET archived=1, archived_at=datetime('now','localtime') WHERE id=?",
            (card_id,)
        )
        _log_activity(conn, card_id, 'archived')

        card_row = conn.execute('''
            SELECT c.title AS card_title, col.board_id, b.name AS board_name
            FROM cards c JOIN columns col ON col.id=c.column_id JOIN boards b ON b.id=col.board_id
            WHERE c.id=?
        ''', (card_id,)).fetchone()
        if card_row:
            _notify_admins(conn, 'card_archived', card_row['board_id'], card_row['board_name'],
                            {'card_title': card_row['card_title']}, card_id=card_id)
    return jsonify({'ok': True})

@app.route('/api/cards/<int:card_id>/restore', methods=['POST'])
def api_restore_card(card_id):
    if 'user' not in session: return jsonify({'error': 'unauthorized'}), 401
    with get_db() as conn:
        conn.execute('UPDATE cards SET archived=0, archived_at=NULL WHERE id=?', (card_id,))
        _log_activity(conn, card_id, 'restored')
    return jsonify({'ok': True})

@app.route('/api/archive')
def api_archive():
    if 'user' not in session: return jsonify({'error': 'unauthorized'}), 401
    board_ids = _get_board_ids()
    if board_ids is not None and len(board_ids) == 0:
        return jsonify([])

    filter_board_id = request.args.get('board_id', type=int)
    if filter_board_id:
        if board_ids is not None and filter_board_id not in board_ids:
            return jsonify([])
        board_ids = [filter_board_id]

    with get_db() as conn:
        cards_sql = '''
            SELECT c.id, c.title, c.archived_at,
                   col.name AS column_name,
                   b.id AS board_id, b.name AS board_name, b.color AS board_color
            FROM cards c
            JOIN columns col ON col.id = c.column_id
            JOIN boards b ON b.id = col.board_id
            WHERE c.archived=1
        '''
        columns_sql = '''
            SELECT col.id, col.name AS title, col.archived_at,
                   NULL AS column_name,
                   b.id AS board_id, b.name AS board_name, b.color AS board_color
            FROM columns col
            JOIN boards b ON b.id = col.board_id
            WHERE col.archived=1
        '''
        params = []
        if board_ids is not None:
            ph = ','.join('?' * len(board_ids))
            cards_sql   += f' AND b.id IN ({ph})'
            columns_sql += f' AND b.id IN ({ph})'
            params = board_ids

        cards   = [{**dict(r), 'type': 'card'}   for r in conn.execute(cards_sql, params).fetchall()]
        columns = [{**dict(r), 'type': 'column'} for r in conn.execute(columns_sql, params).fetchall()]

    items = sorted(cards + columns, key=lambda r: r['archived_at'] or '', reverse=True)[:200]
    return jsonify(items)

@app.route('/api/cards/reorder', methods=['POST'])
def api_reorder_cards():
    if 'user' not in session: return jsonify({'error': 'unauthorized'}), 401
    with get_db() as conn:
        for item in request.get_json().get('cards', []):
            before = conn.execute('SELECT column_id FROM cards WHERE id=?', (item['id'],)).fetchone()
            conn.execute('UPDATE cards SET column_id=?,position=? WHERE id=?',
                         (item['column_id'], item['position'], item['id']))
            if before and before['column_id'] != item['column_id']:
                cols = conn.execute(
                    'SELECT id, name FROM columns WHERE id IN (?,?)', (before['column_id'], item['column_id'])
                ).fetchall()
                names = {c['id']: c['name'] for c in cols}
                _log_activity(conn, item['id'], 'moved_column',
                              f"{names.get(before['column_id'], '?')} → {names.get(item['column_id'], '?')}")
    return jsonify({'ok': True})


# ===== API — CHECKLISTS =====

@app.route('/api/cards/<int:card_id>/checklists', methods=['POST'])
def api_create_checklist(card_id):
    if 'user' not in session: return jsonify({'error': 'unauthorized'}), 401
    title = request.get_json().get('title', '').strip() or 'Чек-лист'
    with get_db() as conn:
        pos = conn.execute('SELECT COALESCE(MAX(position),-1)+1 FROM checklists WHERE card_id=?', (card_id,)).fetchone()[0]
        cur = conn.execute('INSERT INTO checklists (card_id, title, position) VALUES (?,?,?)', (card_id, title, pos))
        cl  = dict(conn.execute('SELECT * FROM checklists WHERE id=?', (cur.lastrowid,)).fetchone())
    cl['items'] = []
    return jsonify(cl), 201

@app.route('/api/boards/<int:board_id>/checklists')
def api_get_board_checklists(board_id):
    """Список всех чек-листов на доске (для попапа «Копировать чек-лист с другой карточки», Should №16)."""
    if 'user' not in session: return jsonify({'error': 'unauthorized'}), 401
    board_ids = _get_board_ids()
    if board_ids is not None and board_id not in board_ids:
        return jsonify({'error': 'forbidden'}), 403
    with get_db() as conn:
        rows = conn.execute('''
            SELECT cl.id, cl.title, cl.card_id, ca.title AS card_title,
                   (SELECT COUNT(*) FROM checklist_items WHERE checklist_id=cl.id) AS item_count
            FROM checklists cl
            JOIN cards ca ON ca.id = cl.card_id
            JOIN columns co ON co.id = ca.column_id
            WHERE co.board_id=? AND (ca.archived=0 OR ca.archived IS NULL)
            ORDER BY ca.title, cl.position
        ''', (board_id,)).fetchall()
    return jsonify([dict(r) for r in rows])

@app.route('/api/cards/<int:card_id>/checklists/copy', methods=['POST'])
def api_copy_checklist(card_id):
    """Копирует чек-лист (название + пункты) с другой карточки на текущую (Should №16).
    Отметки о выполнении, срок и исполнитель пунктов не переносятся — это шаблон, а не перемещение."""
    if 'user' not in session: return jsonify({'error': 'unauthorized'}), 401
    src_checklist_id = request.get_json().get('source_checklist_id')
    if not src_checklist_id:
        return jsonify({'error': 'source_checklist_id required'}), 400
    with get_db() as conn:
        src_cl = conn.execute('SELECT * FROM checklists WHERE id=?', (src_checklist_id,)).fetchone()
        if not src_cl:
            return jsonify({'error': 'not found'}), 404

        src_board = conn.execute('''
            SELECT co.board_id FROM cards ca JOIN columns co ON co.id=ca.column_id WHERE ca.id=?
        ''', (src_cl['card_id'],)).fetchone()
        board_ids = _get_board_ids()
        if src_board and board_ids is not None and src_board['board_id'] not in board_ids:
            return jsonify({'error': 'forbidden'}), 403

        pos = conn.execute(
            'SELECT COALESCE(MAX(position),-1)+1 FROM checklists WHERE card_id=?', (card_id,)
        ).fetchone()[0]
        cur = conn.execute(
            'INSERT INTO checklists (card_id, title, position) VALUES (?,?,?)',
            (card_id, src_cl['title'], pos)
        )
        new_cl_id = cur.lastrowid

        items = []
        for item in conn.execute(
            'SELECT * FROM checklist_items WHERE checklist_id=? ORDER BY position', (src_checklist_id,)
        ):
            item_cur = conn.execute(
                'INSERT INTO checklist_items (card_id, checklist_id, text, position) VALUES (?,?,?,?)',
                (card_id, new_cl_id, item['text'], item['position'])
            )
            items.append(dict(conn.execute(
                'SELECT * FROM checklist_items WHERE id=?', (item_cur.lastrowid,)
            ).fetchone()))

        _log_activity(conn, card_id, 'checklist_copied', src_cl['title'])
        new_cl = dict(conn.execute('SELECT * FROM checklists WHERE id=?', (new_cl_id,)).fetchone())
    new_cl['items'] = items
    return jsonify(new_cl), 201

@app.route('/api/checklists/<int:checklist_id>', methods=['PUT'])
def api_update_checklist(checklist_id):
    if 'user' not in session: return jsonify({'error': 'unauthorized'}), 401
    d = request.get_json()
    fields, values = [], []
    for f in ['title', 'position']:
        if f in d:
            fields.append(f'{f}=?')
            values.append(d[f])
    if fields:
        values.append(checklist_id)
        with get_db() as conn:
            conn.execute(f'UPDATE checklists SET {",".join(fields)} WHERE id=?', values)
    return jsonify({'ok': True})

@app.route('/api/checklists/<int:checklist_id>', methods=['DELETE'])
def api_delete_checklist(checklist_id):
    if 'user' not in session: return jsonify({'error': 'unauthorized'}), 401
    with get_db() as conn:
        conn.execute('DELETE FROM checklist_items WHERE checklist_id=?', (checklist_id,))
        conn.execute('DELETE FROM checklists WHERE id=?', (checklist_id,))
    return jsonify({'ok': True})

@app.route('/api/checklists/<int:checklist_id>/items', methods=['POST'])
def api_add_checklist_item(checklist_id):
    if 'user' not in session: return jsonify({'error': 'unauthorized'}), 401
    text = request.get_json().get('text', '').strip()
    if not text: return jsonify({'error': 'empty'}), 400
    with get_db() as conn:
        cl = conn.execute('SELECT card_id FROM checklists WHERE id=?', (checklist_id,)).fetchone()
        if not cl: return jsonify({'error': 'not found'}), 404
        pos = conn.execute(
            'SELECT COALESCE(MAX(position),-1)+1 FROM checklist_items WHERE checklist_id=?', (checklist_id,)
        ).fetchone()[0]
        cur = conn.execute(
            'INSERT INTO checklist_items (card_id, checklist_id, text, position) VALUES (?,?,?,?)',
            (cl['card_id'], checklist_id, text, pos)
        )
        row = dict(conn.execute('SELECT * FROM checklist_items WHERE id=?', (cur.lastrowid,)).fetchone())
    return jsonify(row), 201

@app.route('/api/checklist/<int:item_id>', methods=['PUT'])
def api_update_checklist_item(item_id):
    if 'user' not in session: return jsonify({'error': 'unauthorized'}), 401
    d = request.get_json()
    fields, values = [], []
    for f in ['text', 'checked', 'due_date', 'assignee_email', 'assignee_name', 'position', 'checklist_id']:
        if f in d:
            fields.append(f'{f}=?')
            values.append(d[f])
    if fields:
        with get_db() as conn:
            before = conn.execute('SELECT * FROM checklist_items WHERE id=?', (item_id,)).fetchone()
            values.append(item_id)
            conn.execute(f'UPDATE checklist_items SET {",".join(fields)} WHERE id=?', values)
            if before and 'checked' in d and bool(d['checked']) != bool(before['checked']):
                _log_activity(conn, before['card_id'],
                              'checklist_item_checked' if d['checked'] else 'checklist_item_unchecked',
                              before['text'])
    return jsonify({'ok': True})

@app.route('/api/checklist/<int:item_id>', methods=['DELETE'])
def api_delete_checklist_item(item_id):
    if 'user' not in session: return jsonify({'error': 'unauthorized'}), 401
    with get_db() as conn:
        conn.execute('DELETE FROM checklist_items WHERE id=?', (item_id,))
    return jsonify({'ok': True})


# ===== API — COMMENTS =====

@app.route('/api/cards/<int:card_id>/comments', methods=['POST'])
def api_add_comment(card_id):
    if 'user' not in session: return jsonify({'error': 'unauthorized'}), 401
    payload = request.get_json(silent=True) or {}
    text = (payload.get('text', '') or '').strip()
    if not text: return jsonify({'error': 'empty'}), 400
    with get_db() as conn:
        cur = conn.execute(
            'INSERT INTO comments (card_id,author,text) VALUES(?,?,?)',
            (card_id, session['user']['name'], text)
        )
        comment_id = cur.lastrowid
        row = dict(conn.execute('SELECT * FROM comments WHERE id=?', (comment_id,)).fetchone())
        mentions = _create_comment_mentions(
            conn,
            card_id,
            comment_id,
            text,
            session['user'].get('email', ''),
            session['user'].get('name', '')
        )
        row['mentions'] = mentions
    return jsonify(row)

@app.route('/api/comments/<int:comment_id>', methods=['DELETE'])
def api_delete_comment(comment_id):
    if 'user' not in session: return jsonify({'error': 'unauthorized'}), 401
    with get_db() as conn:
        conn.execute('DELETE FROM comments WHERE id=?', (comment_id,))
    return jsonify({'ok': True})


@app.route('/api/inbox')
def api_get_inbox():
    if 'user' not in session: return jsonify({'error': 'unauthorized'}), 401
    email = (session['user'].get('email') or '').strip().lower()
    if not email:
        return jsonify({'items': [], 'unread_count': 0})
    limit = request.args.get('limit', 20, type=int)
    unread_only = request.args.get('unread_only', '0') == '1'
    board_id = request.args.get('board_id', type=int)
    with get_db() as conn:
        _sync_due_date_notifications(conn, email)

        sql = 'SELECT * FROM inbox_entries WHERE recipient_email=?'
        params = [email]
        if unread_only:
            sql += ' AND is_read=0'
        if board_id:
            sql += " AND (board_id=? OR json_extract(payload,'$.board_id')=?)"
            params += [board_id, board_id]
        sql += ' ORDER BY created_at DESC, id DESC LIMIT ?'
        params.append(limit)
        rows = conn.execute(sql, params).fetchall()
        items = []
        for row in rows:
            item = dict(row)
            try:
                item['payload'] = json.loads(item['payload'] or '{}')
            except (TypeError, ValueError):
                item['payload'] = {}
            items.append(item)
        unread_count = conn.execute(
            'SELECT COUNT(*) FROM inbox_entries WHERE recipient_email=? AND is_read=0',
            (email,)
        ).fetchone()[0]
    return jsonify({'items': items, 'unread_count': unread_count})


@app.route('/api/inbox/<int:entry_id>/read', methods=['POST'])
def api_mark_inbox_entry_read(entry_id):
    if 'user' not in session: return jsonify({'error': 'unauthorized'}), 401
    email = (session['user'].get('email') or '').strip().lower()
    with get_db() as conn:
        conn.execute(
            'UPDATE inbox_entries SET is_read=1 WHERE id=? AND recipient_email=?',
            (entry_id, email)
        )
    return jsonify({'ok': True})


@app.route('/api/cards/<int:card_id>/duplicate', methods=['POST'])
def api_duplicate_card(card_id):
    if 'user' not in session: return jsonify({'error': 'unauthorized'}), 401
    with get_db() as conn:
        src = conn.execute('SELECT * FROM cards WHERE id=?', (card_id,)).fetchone()
        if not src: return jsonify({'error': 'not found'}), 404
        pos = conn.execute('SELECT COALESCE(MAX(position),-1)+1 FROM cards WHERE column_id=?', (src['column_id'],)).fetchone()[0]
        new_card_id = _duplicate_card(conn, card_id, src['column_id'], pos, title_suffix=' (копия)')
        new_card = dict(conn.execute('SELECT * FROM cards WHERE id=?', (new_card_id,)).fetchone())
        checklist_rows = conn.execute(
            'SELECT * FROM checklists WHERE card_id=? ORDER BY position', (new_card_id,)
        ).fetchall()
        item_rows = conn.execute(
            'SELECT * FROM checklist_items WHERE card_id=? ORDER BY position', (new_card_id,)
        ).fetchall()
        items_by_checklist = {}
        for it in item_rows:
            items_by_checklist.setdefault(it['checklist_id'], []).append(dict(it))
        new_card['checklists'] = [
            {**dict(cl), 'items': items_by_checklist.get(cl['id'], [])} for cl in checklist_rows
        ]
        new_card['labels'] = [dict(l) for l in conn.execute(
            'SELECT * FROM card_labels WHERE card_id=? ORDER BY position, id', (new_card_id,)
        )]
    return jsonify(new_card)


# ===== API — ATTACHMENTS =====

@app.route('/api/cards/<int:card_id>/attachments', methods=['POST'])
def api_upload_attachment(card_id):
    if 'user' not in session: return jsonify({'error': 'unauthorized'}), 401
    f = request.files.get('file')
    if not f or not f.filename: return jsonify({'error': 'no file'}), 400
    original = secure_filename(f.filename)
    ext = ('.' + original.rsplit('.', 1)[-1]) if '.' in original else ''
    stored = uuid.uuid4().hex + ext
    card_dir = os.path.join(UPLOAD_FOLDER, str(card_id))
    os.makedirs(card_dir, exist_ok=True)
    filepath = os.path.join(card_dir, stored)
    f.save(filepath)
    size_str = _fmt_size(os.path.getsize(filepath))
    ftype = _file_type(original)
    with get_db() as conn:
        cur = conn.execute(
            'INSERT INTO attachments (card_id,filename,filesize,filetype,filepath) VALUES(?,?,?,?,?)',
            (card_id, original, size_str, ftype, filepath)
        )
        _log_activity(conn, card_id, 'attachment_added', original)
        row = dict(conn.execute('SELECT * FROM attachments WHERE id=?', (cur.lastrowid,)).fetchone())
    return jsonify(row), 201

@app.route('/api/attachments/<int:att_id>', methods=['GET'])
def api_get_attachment(att_id):
    if 'user' not in session: return jsonify({'error': 'unauthorized'}), 401
    with get_db() as conn:
        att = conn.execute('SELECT * FROM attachments WHERE id=?', (att_id,)).fetchone()
    if not att or not os.path.exists(att['filepath']):
        return jsonify({'error': 'not found'}), 404
    inline = request.args.get('inline') == '1'
    return send_file(att['filepath'], download_name=att['filename'],
                     as_attachment=not inline)

@app.route('/api/attachments/<int:att_id>', methods=['DELETE'])
def api_delete_attachment(att_id):
    if 'user' not in session: return jsonify({'error': 'unauthorized'}), 401
    with get_db() as conn:
        att = conn.execute('SELECT * FROM attachments WHERE id=?', (att_id,)).fetchone()
        if not att: return jsonify({'error': 'not found'}), 404
        conn.execute('DELETE FROM attachments WHERE id=?', (att_id,))
        _log_activity(conn, att['card_id'], 'attachment_removed', att['filename'])
    try:
        os.remove(att['filepath'])
    except OSError:
        pass
    return jsonify({'ok': True})


# ===== API — CARD MEMBERS =====

@app.route('/api/cards/<int:card_id>/members', methods=['GET'])
def api_get_card_members(card_id):
    if 'user' not in session: return jsonify({'error': 'unauthorized'}), 401
    with get_db() as conn:
        rows = conn.execute(
            'SELECT * FROM card_members WHERE card_id=? ORDER BY id', (card_id,)
        ).fetchall()
    return jsonify([dict(r) for r in rows])

@app.route('/api/cards/<int:card_id>/members', methods=['POST'])
def api_assign_card_member(card_id):
    if 'user' not in session: return jsonify({'error': 'unauthorized'}), 401
    d     = request.get_json()
    email = d.get('email', '').strip()
    name  = d.get('name',  '').strip()
    if not email: return jsonify({'error': 'email required'}), 400
    with get_db() as conn:
        conn.execute(
            'INSERT OR IGNORE INTO card_members (card_id, user_email, user_name) VALUES (?,?,?)',
            (card_id, email, name)
        )
        _log_activity(conn, card_id, 'member_added', name or email)

        actor = session.get('user') or {}
        if email.strip().lower() != (actor.get('email') or '').strip().lower():
            card_row = conn.execute('''
                SELECT c.title AS card_title, col.board_id, b.name AS board_name
                FROM cards c JOIN columns col ON col.id=c.column_id JOIN boards b ON b.id=col.board_id
                WHERE c.id=?
            ''', (card_id,)).fetchone()
            if card_row:
                payload = json.dumps({
                    'type': 'member_added', 'card_id': card_id, 'card_title': card_row['card_title'],
                    'board_id': card_row['board_id'], 'board_name': card_row['board_name'],
                    'actor_email': actor.get('email'), 'actor_name': actor.get('name'),
                })
                conn.execute(
                    'INSERT INTO inbox_entries (recipient_email, type, card_id, payload, board_id) VALUES (?,?,?,?,?)',
                    (email.strip().lower(), 'member_added', card_id, payload, card_row['board_id'])
                )
    return jsonify({'ok': True})

@app.route('/api/cards/<int:card_id>/members/<path:email>', methods=['DELETE'])
def api_remove_card_member(card_id, email):
    if 'user' not in session: return jsonify({'error': 'unauthorized'}), 401
    with get_db() as conn:
        member = conn.execute(
            'SELECT user_name FROM card_members WHERE card_id=? AND user_email=?', (card_id, email)
        ).fetchone()
        conn.execute(
            'DELETE FROM card_members WHERE card_id=? AND user_email=?', (card_id, email)
        )
        _log_activity(conn, card_id, 'member_removed', (member['user_name'] if member else '') or email)
    return jsonify({'ok': True})


# ===== API — CARD LABELS =====

@app.route('/api/cards/<int:card_id>/labels', methods=['GET'])
def api_get_card_labels(card_id):
    if 'user' not in session: return jsonify({'error': 'unauthorized'}), 401
    with get_db() as conn:
        rows = conn.execute(
            'SELECT * FROM card_labels WHERE card_id=? ORDER BY position, id', (card_id,)
        ).fetchall()
    return jsonify([dict(r) for r in rows])

@app.route('/api/cards/<int:card_id>/labels', methods=['POST'])
def api_add_card_label(card_id):
    if 'user' not in session: return jsonify({'error': 'unauthorized'}), 401
    d     = request.get_json()
    name  = (d.get('name') or '').strip()
    color = (d.get('color') or '').strip()
    if not name: return jsonify({'error': 'name required'}), 400
    with get_db() as conn:
        pos = conn.execute(
            'SELECT COALESCE(MAX(position),-1)+1 FROM card_labels WHERE card_id=?', (card_id,)
        ).fetchone()[0]
        conn.execute(
            '''INSERT INTO card_labels (card_id, name, color, position) VALUES (?,?,?,?)
               ON CONFLICT(card_id, name) DO UPDATE SET color=excluded.color''',
            (card_id, name, color, pos)
        )
        row = dict(conn.execute(
            'SELECT * FROM card_labels WHERE card_id=? AND name=?', (card_id, name)
        ).fetchone())
        _log_activity(conn, card_id, 'label_added', name)
    return jsonify(row), 201

@app.route('/api/cards/<int:card_id>/labels/<int:label_id>', methods=['DELETE'])
def api_remove_card_label(card_id, label_id):
    if 'user' not in session: return jsonify({'error': 'unauthorized'}), 401
    with get_db() as conn:
        label = conn.execute('SELECT name FROM card_labels WHERE id=? AND card_id=?', (label_id, card_id)).fetchone()
        conn.execute('DELETE FROM card_labels WHERE id=? AND card_id=?', (label_id, card_id))
        if label:
            _log_activity(conn, card_id, 'label_removed', label['name'])
    return jsonify({'ok': True})


# ===== API — ВАЖНОСТЬ (одна на карточку, автоматически ставит обложку) =====

@app.route('/api/cards/<int:card_id>/importance', methods=['GET'])
def api_get_card_importance(card_id):
    if 'user' not in session: return jsonify({'error': 'unauthorized'}), 401
    with get_db() as conn:
        row = conn.execute('SELECT importance FROM cards WHERE id=?', (card_id,)).fetchone()
    name = row['importance'] if row else ''
    return jsonify({'name': name or '', 'color': IMPORTANCE_COLORS.get(name, '')})

@app.route('/api/cards/<int:card_id>/importance', methods=['PUT'])
def api_set_card_importance(card_id):
    if 'user' not in session: return jsonify({'error': 'unauthorized'}), 401
    d    = request.get_json()
    name = (d.get('name') or '').strip()
    if name and name not in IMPORTANCE_COLORS:
        return jsonify({'error': 'invalid importance'}), 400
    with get_db() as conn:
        current = conn.execute('SELECT importance FROM cards WHERE id=?', (card_id,)).fetchone()['importance']
        if name and name == current:
            name = ''  # повторный клик по активному уровню — снимаем важность
        color = IMPORTANCE_COLORS.get(name, '')
        conn.execute('UPDATE cards SET importance=?, cover_color=? WHERE id=?', (name, color, card_id))
        _log_activity(conn, card_id, 'importance_set' if name else 'importance_cleared', name or current)
    return jsonify({'name': name, 'color': color})


# ===== API — CUSTOM FIELDS =====

@app.route('/api/boards/<int:board_id>/custom-fields', methods=['GET'])
def api_get_custom_fields(board_id):
    if 'user' not in session: return jsonify({'error': 'unauthorized'}), 401
    with get_db() as conn:
        rows = conn.execute(
            'SELECT * FROM custom_fields WHERE board_id=? ORDER BY position, id', (board_id,)
        ).fetchall()
    return jsonify([dict(r) for r in rows])

@app.route('/api/boards/<int:board_id>/custom-fields', methods=['POST'])
def api_create_custom_field(board_id):
    if 'user' not in session: return jsonify({'error': 'unauthorized'}), 401
    d = request.get_json() or {}
    name  = (d.get('name') or '').strip()
    ftype = (d.get('type') or '').strip()
    if not name or ftype not in CUSTOM_FIELD_TYPES:
        return jsonify({'error': 'invalid'}), 400
    options = json.dumps(d.get('options') or []) if ftype == 'list' else ''
    show_on_card = 1 if d.get('show_on_card') else 0
    with get_db() as conn:
        pos = conn.execute(
            'SELECT COALESCE(MAX(position),-1)+1 FROM custom_fields WHERE board_id=?', (board_id,)
        ).fetchone()[0]
        cur = conn.execute(
            'INSERT INTO custom_fields (board_id, name, type, options, show_on_card, position) VALUES (?,?,?,?,?,?)',
            (board_id, name, ftype, options, show_on_card, pos)
        )
        row = dict(conn.execute('SELECT * FROM custom_fields WHERE id=?', (cur.lastrowid,)).fetchone())
    return jsonify(row), 201

@app.route('/api/custom-fields/<int:field_id>', methods=['PUT'])
def api_update_custom_field(field_id):
    if 'user' not in session: return jsonify({'error': 'unauthorized'}), 401
    d = request.get_json() or {}
    fields, values = [], []
    if 'name' in d:
        fields.append('name=?'); values.append((d['name'] or '').strip())
    if 'options' in d:
        fields.append('options=?'); values.append(json.dumps(d['options'] or []))
    if 'show_on_card' in d:
        fields.append('show_on_card=?'); values.append(1 if d['show_on_card'] else 0)
    if 'position' in d:
        fields.append('position=?'); values.append(d['position'])
    if fields:
        values.append(field_id)
        with get_db() as conn:
            conn.execute(f'UPDATE custom_fields SET {",".join(fields)} WHERE id=?', values)
    return jsonify({'ok': True})

@app.route('/api/custom-fields/<int:field_id>', methods=['DELETE'])
def api_delete_custom_field(field_id):
    if 'user' not in session: return jsonify({'error': 'unauthorized'}), 401
    with get_db() as conn:
        conn.execute('DELETE FROM custom_fields WHERE id=?', (field_id,))
    return jsonify({'ok': True})

@app.route('/api/cards/<int:card_id>/custom-fields/<int:field_id>', methods=['PUT'])
def api_set_custom_field_value(card_id, field_id):
    if 'user' not in session: return jsonify({'error': 'unauthorized'}), 401
    d = request.get_json() or {}
    value = d.get('value', '')
    if not isinstance(value, str):
        value = str(value)
    with get_db() as conn:
        field = conn.execute('SELECT name FROM custom_fields WHERE id=?', (field_id,)).fetchone()
        if not field: return jsonify({'error': 'not found'}), 404
        conn.execute(
            '''INSERT INTO card_custom_field_values (card_id, field_id, value) VALUES (?,?,?)
               ON CONFLICT(card_id, field_id) DO UPDATE SET value=excluded.value''',
            (card_id, field_id, value)
        )
        _log_activity(conn, card_id, 'custom_field_changed',
                      f"{field['name']}: {value}" if value else f"{field['name']}: —")
    return jsonify({'ok': True})


# ===== API — CARD TEMPLATES (Should №10) =====

@app.route('/api/boards/<int:board_id>/card-templates', methods=['GET'])
def api_get_card_templates(board_id):
    if 'user' not in session: return jsonify({'error': 'unauthorized'}), 401
    board_ids = _get_board_ids()
    if board_ids is not None and board_id not in board_ids:
        return jsonify({'error': 'forbidden'}), 403
    with get_db() as conn:
        rows = conn.execute(
            'SELECT id, name, title FROM card_templates WHERE board_id=? ORDER BY name', (board_id,)
        ).fetchall()
    return jsonify([dict(r) for r in rows])


@app.route('/api/cards/<int:card_id>/save-as-template', methods=['POST'])
def api_save_card_as_template(card_id):
    """Сохраняет текущую карточку (название, описание, важность, метки, чек-листы,
    значения кастомных полей) как переиспользуемый шаблон на доске этой карточки."""
    if 'user' not in session: return jsonify({'error': 'unauthorized'}), 401
    name = (request.get_json() or {}).get('name', '').strip()
    if not name:
        return jsonify({'error': 'name required'}), 400
    with get_db() as conn:
        card = conn.execute('SELECT * FROM cards WHERE id=?', (card_id,)).fetchone()
        if not card:
            return jsonify({'error': 'not found'}), 404
        board_id = conn.execute(
            'SELECT board_id FROM columns WHERE id=?', (card['column_id'],)
        ).fetchone()['board_id']
        board_ids = _get_board_ids()
        if board_ids is not None and board_id not in board_ids:
            return jsonify({'error': 'forbidden'}), 403

        cur = conn.execute(
            'INSERT INTO card_templates (board_id, name, title, description, importance) VALUES (?,?,?,?,?)',
            (board_id, name, card['title'], card['description'], card['importance'])
        )
        template_id = cur.lastrowid

        for lbl in conn.execute('SELECT * FROM card_labels WHERE card_id=? ORDER BY position', (card_id,)):
            conn.execute(
                'INSERT INTO card_template_labels (template_id, name, color) VALUES (?,?,?)',
                (template_id, lbl['name'], lbl['color'])
            )

        for cl in conn.execute('SELECT * FROM checklists WHERE card_id=? ORDER BY position', (card_id,)):
            cl_cur = conn.execute(
                'INSERT INTO card_template_checklists (template_id, title, position) VALUES (?,?,?)',
                (template_id, cl['title'], cl['position'])
            )
            new_tpl_cl_id = cl_cur.lastrowid
            for item in conn.execute(
                'SELECT * FROM checklist_items WHERE checklist_id=? ORDER BY position', (cl['id'],)
            ):
                conn.execute(
                    'INSERT INTO card_template_checklist_items (template_checklist_id, text, position) VALUES (?,?,?)',
                    (new_tpl_cl_id, item['text'], item['position'])
                )

        for v in conn.execute('SELECT * FROM card_custom_field_values WHERE card_id=?', (card_id,)):
            conn.execute(
                'INSERT INTO card_template_custom_fields (template_id, field_id, value) VALUES (?,?,?)',
                (template_id, v['field_id'], v['value'])
            )
    return jsonify({'id': template_id, 'name': name}), 201


@app.route('/api/card-templates/<int:template_id>/instantiate', methods=['POST'])
def api_instantiate_card_template(template_id):
    """Создаёт новую карточку в указанной колонке из шаблона — обратная операция к save-as-template."""
    if 'user' not in session: return jsonify({'error': 'unauthorized'}), 401
    column_id = (request.get_json() or {}).get('column_id')
    if not column_id:
        return jsonify({'error': 'column_id required'}), 400
    with get_db() as conn:
        tpl = conn.execute('SELECT * FROM card_templates WHERE id=?', (template_id,)).fetchone()
        if not tpl:
            return jsonify({'error': 'not found'}), 404
        col = conn.execute('SELECT board_id FROM columns WHERE id=?', (column_id,)).fetchone()
        if not col:
            return jsonify({'error': 'column not found'}), 404
        board_ids = _get_board_ids()
        if board_ids is not None and col['board_id'] not in board_ids:
            return jsonify({'error': 'forbidden'}), 403

        pos = conn.execute(
            'SELECT COALESCE(MAX(position),-1)+1 FROM cards WHERE column_id=?', (column_id,)
        ).fetchone()[0]
        cur = conn.execute(
            'INSERT INTO cards (column_id, title, description, importance, position) VALUES (?,?,?,?,?)',
            (column_id, tpl['title'] or tpl['name'], tpl['description'], tpl['importance'], pos)
        )
        new_card_id = cur.lastrowid
        _log_activity(conn, new_card_id, 'created')

        for lbl in conn.execute('SELECT * FROM card_template_labels WHERE template_id=?', (template_id,)):
            conn.execute(
                'INSERT OR IGNORE INTO card_labels (card_id, name, color) VALUES (?,?,?)',
                (new_card_id, lbl['name'], lbl['color'])
            )

        checklist_id_map = {}
        for cl in conn.execute(
            'SELECT * FROM card_template_checklists WHERE template_id=? ORDER BY position', (template_id,)
        ):
            new_cl = conn.execute(
                'INSERT INTO checklists (card_id, title, position) VALUES (?,?,?)',
                (new_card_id, cl['title'], cl['position'])
            )
            checklist_id_map[cl['id']] = new_cl.lastrowid
        for item in conn.execute('''
            SELECT ti.* FROM card_template_checklist_items ti
            JOIN card_template_checklists tc ON tc.id = ti.template_checklist_id
            WHERE tc.template_id=? ORDER BY ti.position
        ''', (template_id,)):
            new_cl_id = checklist_id_map.get(item['template_checklist_id'])
            if new_cl_id:
                conn.execute(
                    'INSERT INTO checklist_items (card_id, checklist_id, text, position) VALUES (?,?,?,?)',
                    (new_card_id, new_cl_id, item['text'], item['position'])
                )

        for v in conn.execute('SELECT * FROM card_template_custom_fields WHERE template_id=?', (template_id,)):
            # переносим значение, только если кастомное поле всё ещё существует на доске
            if conn.execute('SELECT 1 FROM custom_fields WHERE id=?', (v['field_id'],)).fetchone():
                conn.execute(
                    'INSERT INTO card_custom_field_values (card_id, field_id, value) VALUES (?,?,?)',
                    (new_card_id, v['field_id'], v['value'])
                )

        card_dict = dict(conn.execute('SELECT * FROM cards WHERE id=?', (new_card_id,)).fetchone())
        card_dict['labels'] = [dict(l) for l in conn.execute(
            'SELECT * FROM card_labels WHERE card_id=? ORDER BY position, id', (new_card_id,)
        )]
        card_dict['importance_color'] = IMPORTANCE_COLORS.get(card_dict.get('importance') or '', '')
    return jsonify(card_dict), 201


@app.route('/api/card-templates/<int:template_id>', methods=['DELETE'])
def api_delete_card_template(template_id):
    if 'user' not in session: return jsonify({'error': 'unauthorized'}), 401
    with get_db() as conn:
        conn.execute('DELETE FROM card_templates WHERE id=?', (template_id,))
    return jsonify({'ok': True})


# ===== API — CARD LINKS =====

@app.route('/api/cards/<int:card_id>/links', methods=['GET'])
def api_get_card_links(card_id):
    if 'user' not in session: return jsonify({'error': 'unauthorized'}), 401
    with get_db() as conn:
        rows = conn.execute(
            'SELECT * FROM card_links WHERE card_id=? ORDER BY position, id', (card_id,)
        ).fetchall()
    return jsonify([dict(r) for r in rows])

@app.route('/api/cards/<int:card_id>/links', methods=['POST'])
def api_add_card_link(card_id):
    if 'user' not in session: return jsonify({'error': 'unauthorized'}), 401
    d     = request.get_json()
    url   = d.get('url', '').strip()
    title = d.get('title', '').strip()
    if not url: return jsonify({'error': 'url required'}), 400
    if not re.match(r'^https?://', url, re.IGNORECASE):
        url = 'https://' + url
    with get_db() as conn:
        pos = conn.execute(
            'SELECT COALESCE(MAX(position),-1)+1 FROM card_links WHERE card_id=?', (card_id,)
        ).fetchone()[0]
        cur = conn.execute(
            'INSERT INTO card_links (card_id, url, title, position) VALUES (?,?,?,?)',
            (card_id, url, title, pos)
        )
        row = dict(conn.execute('SELECT * FROM card_links WHERE id=?', (cur.lastrowid,)).fetchone())
        _log_activity(conn, card_id, 'link_added', title or url)
    return jsonify(row), 201

@app.route('/api/cards/<int:card_id>/links/<int:link_id>', methods=['DELETE'])
def api_remove_card_link(card_id, link_id):
    if 'user' not in session: return jsonify({'error': 'unauthorized'}), 401
    with get_db() as conn:
        link = conn.execute('SELECT url, title FROM card_links WHERE id=? AND card_id=?', (link_id, card_id)).fetchone()
        conn.execute('DELETE FROM card_links WHERE id=? AND card_id=?', (link_id, card_id))
        if link:
            _log_activity(conn, card_id, 'link_removed', link['title'] or link['url'])
    return jsonify({'ok': True})


# ===== API — ЗЕРКАЛЬНЫЕ КАРТОЧКИ (Should №30) =====

@app.route('/api/cards/<int:card_id>/mirror', methods=['POST'])
def api_create_card_mirror(card_id):
    """Размещает «зеркало» карточки в другой колонке (той же или другой доски).
    Это не копия — данные всегда читаются из исходной карточки при рендере доски."""
    if 'user' not in session: return jsonify({'error': 'unauthorized'}), 401
    column_id = (request.get_json() or {}).get('column_id')
    if not column_id: return jsonify({'error': 'column_id required'}), 400
    with get_db() as conn:
        src = conn.execute('SELECT * FROM cards WHERE id=?', (card_id,)).fetchone()
        if not src: return jsonify({'error': 'not found'}), 404
        col = conn.execute('SELECT board_id FROM columns WHERE id=?', (column_id,)).fetchone()
        if not col: return jsonify({'error': 'column not found'}), 404
        board_ids = _get_board_ids()
        if board_ids is not None and col['board_id'] not in board_ids:
            return jsonify({'error': 'forbidden'}), 403

        pos = conn.execute(
            'SELECT COALESCE(MAX(position),-1)+1 FROM card_mirrors WHERE column_id=?', (column_id,)
        ).fetchone()[0]
        cur = conn.execute(
            'INSERT INTO card_mirrors (source_card_id, column_id, position) VALUES (?,?,?)',
            (card_id, column_id, pos)
        )
        mirror_id = cur.lastrowid
        _log_activity(conn, card_id, 'mirror_added', '')
    return jsonify({'mirror_id': mirror_id}), 201

@app.route('/api/card-mirrors/<int:mirror_id>', methods=['DELETE'])
def api_delete_card_mirror(mirror_id):
    """Убирает зеркало из колонки — исходная карточка не затрагивается."""
    if 'user' not in session: return jsonify({'error': 'unauthorized'}), 401
    with get_db() as conn:
        conn.execute('DELETE FROM card_mirrors WHERE id=?', (mirror_id,))
    return jsonify({'ok': True})


# ===== API — CARD RELATIONS (двусторонняя связь карточка↔карточка, Should №31) =====

@app.route('/api/cards/<int:card_id>/relations', methods=['GET'])
def api_get_card_relations(card_id):
    if 'user' not in session: return jsonify({'error': 'unauthorized'}), 401
    with get_db() as conn:
        rows = conn.execute('''
            SELECT c.id, c.title, c.completed, col.name AS column_name,
                   b.id AS board_id, b.name AS board_name, b.color AS board_color
            FROM card_relations r
            JOIN cards c ON c.id = (CASE WHEN r.card_a_id=? THEN r.card_b_id ELSE r.card_a_id END)
            JOIN columns col ON col.id = c.column_id
            JOIN boards b ON b.id = col.board_id
            WHERE r.card_a_id=? OR r.card_b_id=?
            ORDER BY b.name, col.name, c.title
        ''', (card_id, card_id, card_id)).fetchall()
    return jsonify([dict(r) for r in rows])

@app.route('/api/cards/<int:card_id>/relations', methods=['POST'])
def api_add_card_relation(card_id):
    """Двусторонняя связь: хранится одной строкой в каноническом порядке (a<b),
    видна и находится с обеих сторон одинаково."""
    if 'user' not in session: return jsonify({'error': 'unauthorized'}), 401
    other_id = (request.get_json() or {}).get('other_card_id')
    if not other_id: return jsonify({'error': 'other_card_id required'}), 400
    other_id = int(other_id)
    if other_id == card_id: return jsonify({'error': 'cannot relate a card to itself'}), 400
    a, b = min(card_id, other_id), max(card_id, other_id)
    with get_db() as conn:
        other = conn.execute('SELECT title FROM cards WHERE id=?', (other_id,)).fetchone()
        if not other: return jsonify({'error': 'not found'}), 404
        conn.execute('INSERT OR IGNORE INTO card_relations (card_a_id, card_b_id) VALUES (?,?)', (a, b))
        _log_activity(conn, card_id, 'relation_added', other['title'])
    return jsonify({'ok': True}), 201

@app.route('/api/cards/<int:card_id>/relations/<int:other_id>', methods=['DELETE'])
def api_remove_card_relation(card_id, other_id):
    if 'user' not in session: return jsonify({'error': 'unauthorized'}), 401
    a, b = min(card_id, other_id), max(card_id, other_id)
    with get_db() as conn:
        other = conn.execute('SELECT title FROM cards WHERE id=?', (other_id,)).fetchone()
        conn.execute('DELETE FROM card_relations WHERE card_a_id=? AND card_b_id=?', (a, b))
        if other:
            _log_activity(conn, card_id, 'relation_removed', other['title'])
    return jsonify({'ok': True})


# ===== API — ACCESS MANAGEMENT =====

@app.route('/api/boards/<int:board_id>/access', methods=['GET'])
def api_get_board_access(board_id):
    if 'user' not in session or session['user']['role'] != 'admin':
        return jsonify({'error': 'forbidden'}), 403
    with get_db() as conn:
        rows = conn.execute('''
            SELECT u.id, u.name, u.email,
                   CASE WHEN ba.user_id IS NOT NULL THEN 1 ELSE 0 END AS has_access,
                   ba.expires_at AS expires_at,
                   CASE WHEN ba.expires_at IS NOT NULL AND ba.expires_at != '' AND ba.expires_at < date('now','localtime')
                        THEN 1 ELSE 0 END AS is_expired
            FROM users u
            LEFT JOIN board_access ba ON ba.user_id = u.id AND ba.board_id = ?
            WHERE u.role != 'admin'
            ORDER BY u.name
        ''', (board_id,)).fetchall()
    return jsonify([dict(r) for r in rows])

@app.route('/api/boards/<int:board_id>/access', methods=['POST'])
def api_grant_access(board_id):
    if 'user' not in session or session['user']['role'] != 'admin':
        return jsonify({'error': 'forbidden'}), 403
    d = request.get_json()
    user_id    = d.get('user_id')
    expires_at = (d.get('expires_at') or '').strip() or None
    if not user_id:
        return jsonify({'error': 'user_id required'}), 400
    with get_db() as conn:
        conn.execute('''
            INSERT INTO board_access (user_id, board_id, expires_at) VALUES (?,?,?)
            ON CONFLICT(user_id, board_id) DO UPDATE SET expires_at=excluded.expires_at
        ''', (user_id, board_id, expires_at))
    return jsonify({'ok': True})

@app.route('/api/boards/<int:board_id>/access/<int:user_id>', methods=['DELETE'])
def api_revoke_access(board_id, user_id):
    if 'user' not in session or session['user']['role'] != 'admin':
        return jsonify({'error': 'forbidden'}), 403
    with get_db() as conn:
        conn.execute('DELETE FROM board_access WHERE user_id=? AND board_id=?', (user_id, board_id))
    return jsonify({'ok': True})




@app.route('/api/columns/reorder', methods=['POST'])
def api_reorder_columns():
    if 'user' not in session: return jsonify({'error': 'unauthorized'}), 401
    with get_db() as conn:
        for item in request.get_json().get('columns', []):
            conn.execute('UPDATE columns SET position=? WHERE id=?',
                         (item['position'], item['id']))
    return jsonify({'ok': True})


@app.route('/api/columns/<int:col_id>', methods=['PUT'])
def api_update_column(col_id):
    """Переименование и/или WIP-лимит колонки (Should №36) — оба поля необязательны и независимы."""
    if 'user' not in session: return jsonify({'error': 'unauthorized'}), 401
    d = request.get_json() or {}
    fields, values = [], []
    if 'name' in d:
        name = (d.get('name') or '').strip()
        if not name: return jsonify({'error': 'name required'}), 400
        fields.append('name=?'); values.append(name)
    if 'wip_limit' in d:
        wip_limit = d.get('wip_limit')
        try:
            wip_limit = max(0, int(wip_limit)) if wip_limit not in (None, '') else 0
        except (TypeError, ValueError):
            return jsonify({'error': 'invalid wip_limit'}), 400
        fields.append('wip_limit=?'); values.append(wip_limit)
    if not fields:
        return jsonify({'error': 'nothing to update'}), 400
    values.append(col_id)
    with get_db() as conn:
        conn.execute(f'UPDATE columns SET {",".join(fields)} WHERE id=?', values)
    return jsonify({'ok': True})


@app.route('/api/columns/<int:col_id>', methods=['DELETE'])
def api_delete_column(col_id):
    if 'user' not in session: return jsonify({'error': 'unauthorized'}), 401
    with get_db() as conn:
        col = conn.execute('SELECT name, board_id FROM columns WHERE id=?', (col_id,)).fetchone()
        conn.execute(
            "UPDATE columns SET archived=1, archived_at=datetime('now','localtime') WHERE id=?",
            (col_id,)
        )
        if col:
            board = conn.execute('SELECT name FROM boards WHERE id=?', (col['board_id'],)).fetchone()
            _notify_admins(conn, 'column_archived', col['board_id'], board['name'] if board else '',
                            {'column_name': col['name']})
    return jsonify({'ok': True})

@app.route('/api/columns/<int:col_id>/restore', methods=['POST'])
def api_restore_column(col_id):
    if 'user' not in session: return jsonify({'error': 'unauthorized'}), 401
    with get_db() as conn:
        conn.execute('UPDATE columns SET archived=0, archived_at=NULL WHERE id=?', (col_id,))
    return jsonify({'ok': True})


# ===== ПРОФИЛЬ =====

@app.route('/api/profile', methods=['PUT'])
def api_profile_update():
    if 'user' not in session:
        return jsonify({'error': 'Unauthorized'}), 401
    data  = request.get_json() or {}
    email = session['user']['email']

    with get_db() as conn:
        user = conn.execute('SELECT * FROM users WHERE email=?', (email,)).fetchone()
        if not user:
            # Google Sheets пользователь — создаём SQLite-запись для хранения настроек профиля
            conn.execute(
                "INSERT OR IGNORE INTO users (email, name, password_hash, role) VALUES (?, ?, ?, ?)",
                (email, session['user'].get('name', email), 'sheets-auth', session['user'].get('role', 'user'))
            )
            user = conn.execute('SELECT * FROM users WHERE email=?', (email,)).fetchone()

        name = (data.get('name') or '').strip()
        if name:
            conn.execute('UPDATE users SET name=? WHERE email=?', (name, email))

        color = (data.get('avatar_color') or '').strip()
        if color:
            conn.execute('UPDATE users SET avatar_color=? WHERE email=?', (color, email))

        if data.get('remove_photo'):
            old_photo = user['avatar_photo']
            if old_photo:
                old_path = os.path.join(AVATARS_FOLDER, old_photo)
                if os.path.exists(old_path):
                    os.remove(old_path)
            conn.execute('UPDATE users SET avatar_photo=NULL WHERE email=?', (email,))
            session['user']['avatar_photo'] = None
            session.modified = True
            return jsonify({'ok': True})

        if data.get('new_password'):
            if not check_password_hash(user['password_hash'], data.get('current_password', '')):
                return jsonify({'error': 'Неверный текущий пароль'}), 400
            from werkzeug.security import generate_password_hash
            conn.execute('UPDATE users SET password_hash=? WHERE email=?',
                         (generate_password_hash(data['new_password']), email))

        updated = conn.execute('SELECT * FROM users WHERE email=?', (email,)).fetchone()
        session['user']['name']         = updated['name']
        session['user']['avatar_color'] = updated['avatar_color'] or '#4361EE'
        session.modified = True

    return jsonify({'ok': True, 'name': session['user']['name'],
                    'avatar_color': session['user']['avatar_color']})


@app.route('/api/profile/photo', methods=['POST'])
def api_profile_photo():
    if 'user' not in session:
        return jsonify({'error': 'Unauthorized'}), 401
    if 'photo' not in request.files:
        return jsonify({'error': 'Файл не передан'}), 400

    file = request.files['photo']
    if not file.filename:
        return jsonify({'error': 'Пустое имя файла'}), 400

    ext = file.filename.rsplit('.', 1)[-1].lower() if '.' in file.filename else 'jpg'
    if ext not in {'jpg', 'jpeg', 'png', 'gif', 'webp'}:
        return jsonify({'error': 'Недопустимый формат файла'}), 400

    email    = session['user']['email']
    filename = f"{uuid.uuid4().hex}.{ext}"
    filepath = os.path.join(AVATARS_FOLDER, filename)
    file.save(filepath)

    with get_db() as conn:
        # Создаём запись если пользователь только через Google Sheets
        conn.execute(
            "INSERT OR IGNORE INTO users (email, name, password_hash, role) VALUES (?, ?, ?, ?)",
            (email, session['user'].get('name', email), 'sheets-auth', session['user'].get('role', 'user'))
        )
        old = conn.execute('SELECT avatar_photo FROM users WHERE email=?', (email,)).fetchone()
        if old and old['avatar_photo']:
            old_path = os.path.join(AVATARS_FOLDER, old['avatar_photo'])
            if os.path.exists(old_path):
                os.remove(old_path)
        conn.execute('UPDATE users SET avatar_photo=? WHERE email=?', (filename, email))

    session['user']['avatar_photo'] = filename
    session.modified = True
    return jsonify({'ok': True, 'photo_url': f'/uploads/avatars/{filename}'})


@app.route('/uploads/avatars/<path:filename>')
def serve_avatar(filename):
    return send_file(os.path.join(AVATARS_FOLDER, secure_filename(filename)))


# ===== ЭКСПОРТ =====

@app.route('/api/boards/<int:board_id>/export')
def export_board(board_id):
    if 'user' not in session:
        return redirect(url_for('login'))
    if session['user'].get('role') != 'admin':
        return jsonify({'error': 'forbidden'}), 403
    board_ids = _get_board_ids()
    if board_ids is not None and board_id not in board_ids:
        return jsonify({'error': 'forbidden'}), 403
    with get_db() as conn:
        board = conn.execute('SELECT * FROM boards WHERE id=?', (board_id,)).fetchone()
        if not board:
            return jsonify({'error': 'Not found'}), 404
        rows = conn.execute('''
            SELECT ca.id, co.name AS col_name, ca.title, ca.description,
                   ca.due_date,
                   CASE WHEN ca.completed=1 THEN 'Выполнена' ELSE 'Активна' END AS status
            FROM cards ca
            JOIN columns co ON co.id = ca.column_id
            WHERE co.board_id = ?
            ORDER BY co.position, ca.position
        ''', (board_id,)).fetchall()
        members_rows = conn.execute('''
            SELECT cm.card_id, COALESCE(NULLIF(cm.user_name,''), cm.user_email) AS member
            FROM card_members cm
            JOIN cards ca ON ca.id = cm.card_id
            JOIN columns co ON co.id = ca.column_id
            WHERE co.board_id = ?
        ''', (board_id,)).fetchall()
        labels_rows = conn.execute('''
            SELECT cl.card_id, cl.name
            FROM card_labels cl
            JOIN cards ca ON ca.id = cl.card_id
            JOIN columns co ON co.id = ca.column_id
            WHERE co.board_id = ?
            ORDER BY cl.position, cl.id
        ''', (board_id,)).fetchall()

    cm_map = {}
    for m in members_rows:
        cm_map.setdefault(m['card_id'], []).append(m['member'])
    lbl_map = {}
    for l in labels_rows:
        lbl_map.setdefault(l['card_id'], []).append(l['name'])

    output = io.StringIO()
    w = csv.writer(output)
    w.writerow(['Колонка', 'Карточка', 'Описание', 'Метки', 'Срок', 'Статус', 'Участники'])
    for r in rows:
        w.writerow([r['col_name'], r['title'], r['description'],
                    ', '.join(lbl_map.get(r['id'], [])), r['due_date'], r['status'],
                    ', '.join(cm_map.get(r['id'], []))])

    content = '﻿' + output.getvalue()
    encoded = url_quote(board['name'] + '.csv')
    return app.response_class(
        content.encode('utf-8'),
        mimetype='text/csv; charset=utf-8',
        headers={'Content-Disposition': f"attachment; filename=\"export.csv\"; filename*=UTF-8''{encoded}"}
    )


@app.route('/api/workspaces/<int:ws_id>/export')
def export_workspace(ws_id):
    if 'user' not in session:
        return redirect(url_for('login'))
    if session['user'].get('role') != 'admin':
        return jsonify({'error': 'forbidden'}), 403
    with get_db() as conn:
        ws = conn.execute('SELECT * FROM workspaces WHERE id=?', (ws_id,)).fetchone()
        if not ws:
            return jsonify({'error': 'Not found'}), 404
        rows = conn.execute('''
            SELECT ca.id, b.name AS board_name, co.name AS col_name,
                   ca.title, ca.description, ca.due_date,
                   CASE WHEN ca.completed=1 THEN 'Выполнена' ELSE 'Активна' END AS status
            FROM cards ca
            JOIN columns co ON co.id = ca.column_id
            JOIN boards b ON b.id = co.board_id
            WHERE b.workspace_id = ?
            ORDER BY b.name, co.position, ca.position
        ''', (ws_id,)).fetchall()
        members_rows = conn.execute('''
            SELECT cm.card_id, COALESCE(NULLIF(cm.user_name,''), cm.user_email) AS member
            FROM card_members cm
            JOIN cards ca ON ca.id = cm.card_id
            JOIN columns co ON co.id = ca.column_id
            JOIN boards b ON b.id = co.board_id
            WHERE b.workspace_id = ?
        ''', (ws_id,)).fetchall()
        labels_rows = conn.execute('''
            SELECT cl.card_id, cl.name
            FROM card_labels cl
            JOIN cards ca ON ca.id = cl.card_id
            JOIN columns co ON co.id = ca.column_id
            JOIN boards b ON b.id = co.board_id
            WHERE b.workspace_id = ?
            ORDER BY cl.position, cl.id
        ''', (ws_id,)).fetchall()

    cm_map = {}
    for m in members_rows:
        cm_map.setdefault(m['card_id'], []).append(m['member'])
    lbl_map = {}
    for l in labels_rows:
        lbl_map.setdefault(l['card_id'], []).append(l['name'])

    output = io.StringIO()
    w = csv.writer(output)
    w.writerow(['Доска', 'Колонка', 'Карточка', 'Описание', 'Метки', 'Срок', 'Статус', 'Участники'])
    for r in rows:
        w.writerow([r['board_name'], r['col_name'], r['title'],
                    r['description'], ', '.join(lbl_map.get(r['id'], [])), r['due_date'],
                    r['status'], ', '.join(cm_map.get(r['id'], []))])

    content = '﻿' + output.getvalue()
    encoded = url_quote(ws['name'] + '.csv')
    return app.response_class(
        content.encode('utf-8'),
        mimetype='text/csv; charset=utf-8',
        headers={'Content-Disposition': f"attachment; filename=\"export.csv\"; filename*=UTF-8''{encoded}"}
    )


def migrate_db():
    with get_db() as conn:
        # ── Старые миграции ──
        for stmt in [
            "ALTER TABLE users ADD COLUMN avatar_color  TEXT DEFAULT '#4361EE'",
            'ALTER TABLE users ADD COLUMN avatar_photo  TEXT',
            'ALTER TABLE cards ADD COLUMN completed        INTEGER DEFAULT 0',
            'ALTER TABLE cards ADD COLUMN cover_color      TEXT    DEFAULT ""',
            'ALTER TABLE cards ADD COLUMN linked_board_id  INTEGER REFERENCES boards(id) ON DELETE SET NULL',
            'ALTER TABLE cards ADD COLUMN archived         INTEGER DEFAULT 0',
            'ALTER TABLE cards ADD COLUMN archived_at      TEXT',
            'ALTER TABLE cards ADD COLUMN start_date       TEXT    DEFAULT ""',
            'ALTER TABLE cards ADD COLUMN importance       TEXT    DEFAULT ""',
            'ALTER TABLE columns ADD COLUMN archived       INTEGER DEFAULT 0',
            'ALTER TABLE columns ADD COLUMN archived_at    TEXT',
            'ALTER TABLE columns ADD COLUMN wip_limit      INTEGER DEFAULT 0',
            '''CREATE TABLE IF NOT EXISTS card_members (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                card_id    INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
                user_email TEXT    NOT NULL,
                user_name  TEXT    NOT NULL DEFAULT \'\',
                UNIQUE(card_id, user_email)
            )''',
            '''CREATE TABLE IF NOT EXISTS checklist_items (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                card_id    INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
                text       TEXT    NOT NULL,
                checked    INTEGER DEFAULT 0,
                position   INTEGER DEFAULT 0,
                created_at TEXT    DEFAULT (datetime('now','localtime'))
            )''',
        ]:
            try:
                conn.execute(stmt)
            except sqlite3.OperationalError:
                pass

        # ── Workspaces (шаг 1) ──
        conn.execute('''
            CREATE TABLE IF NOT EXISTS workspaces (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                name       TEXT NOT NULL UNIQUE,
                color      TEXT DEFAULT '#0052cc',
                created_at TEXT DEFAULT (datetime('now','localtime'))
            )
        ''')
        for col_stmt in [
            "ALTER TABLE boards ADD COLUMN workspace_id INTEGER REFERENCES workspaces(id) ON DELETE SET NULL",
            "ALTER TABLE boards ADD COLUMN description  TEXT DEFAULT ''",
            "ALTER TABLE boards ADD COLUMN bg_image     TEXT",
        ]:
            try:
                conn.execute(col_stmt)
            except sqlite3.OperationalError:
                pass

        # Создаём workspaces из существующих company-значений (одноразово)
        companies = conn.execute(
            "SELECT company, MIN(color) as color FROM boards "
            "WHERE company != '' AND company IS NOT NULL "
            "GROUP BY company ORDER BY MIN(id)"
        ).fetchall()
        for row in companies:
            conn.execute(
                'INSERT OR IGNORE INTO workspaces (name, color) VALUES (?, ?)',
                (row['company'], row['color'])
            )

        # Проставляем workspace_id доскам, у которых его нет
        conn.execute('''
            UPDATE boards
            SET workspace_id = (
                SELECT id FROM workspaces WHERE workspaces.name = boards.company
            )
            WHERE workspace_id IS NULL AND company != '' AND company IS NOT NULL
        ''')

        # ── Множественные именованные чек-листы + срок/исполнитель на пункт ──
        conn.execute('''
            CREATE TABLE IF NOT EXISTS checklists (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                card_id    INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
                title      TEXT NOT NULL DEFAULT 'Чек-лист',
                position   INTEGER DEFAULT 0,
                created_at TEXT DEFAULT (datetime('now','localtime'))
            )
        ''')
        for col_stmt in [
            "ALTER TABLE checklist_items ADD COLUMN checklist_id   INTEGER REFERENCES checklists(id) ON DELETE CASCADE",
            "ALTER TABLE checklist_items ADD COLUMN due_date       TEXT DEFAULT ''",
            "ALTER TABLE checklist_items ADD COLUMN assignee_email TEXT DEFAULT ''",
            "ALTER TABLE checklist_items ADD COLUMN assignee_name  TEXT DEFAULT ''",
        ]:
            try:
                conn.execute(col_stmt)
            except sqlite3.OperationalError:
                pass

        # Пункты, добавленные до появления группировки, разбираем по одному
        # дефолтному чек-листу на карточку (данные не теряются)
        orphan_cards = conn.execute(
            'SELECT DISTINCT card_id FROM checklist_items WHERE checklist_id IS NULL'
        ).fetchall()
        for row in orphan_cards:
            cid = row['card_id']
            cur = conn.execute(
                "INSERT INTO checklists (card_id, title, position) VALUES (?,?,0)",
                (cid, 'Чек-лист')
            )
            conn.execute(
                'UPDATE checklist_items SET checklist_id=? WHERE card_id=? AND checklist_id IS NULL',
                (cur.lastrowid, cid)
            )

        # ── Множественные метки на карточке ──
        conn.execute('''
            CREATE TABLE IF NOT EXISTS card_labels (
                id       INTEGER PRIMARY KEY AUTOINCREMENT,
                card_id  INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
                name     TEXT NOT NULL DEFAULT '',
                color    TEXT NOT NULL DEFAULT '',
                position INTEGER DEFAULT 0,
                UNIQUE(card_id, name)
            )
        ''')
        # Разовый перенос старой одиночной метки (cards.label/label_color) в card_labels.
        # Колонки cards.label/label_color оставлены как есть — ими больше никто не пишет,
        # но существующие значения не теряем.
        conn.execute('''
            INSERT OR IGNORE INTO card_labels (card_id, name, color, position)
            SELECT id, label, label_color, 0 FROM cards
            WHERE TRIM(COALESCE(label, '')) != ''
        ''')

        # ── Несколько ссылок на карточке (Google Drive и т.п.) ──
        conn.execute('''
            CREATE TABLE IF NOT EXISTS card_links (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                card_id    INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
                url        TEXT    NOT NULL,
                title      TEXT    NOT NULL DEFAULT '',
                position   INTEGER DEFAULT 0,
                created_at TEXT    DEFAULT (datetime('now','localtime'))
            )
        ''')
        conn.execute('''
            CREATE TABLE IF NOT EXISTS comment_mentions (
                id                INTEGER PRIMARY KEY AUTOINCREMENT,
                comment_id        INTEGER NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
                mentioned_email  TEXT    NOT NULL,
                mentioned_name   TEXT    NOT NULL DEFAULT '',
                created_at       TEXT    DEFAULT (datetime('now','localtime')),
                UNIQUE(comment_id, mentioned_email)
            )
        ''')
        conn.execute('''
            CREATE TABLE IF NOT EXISTS inbox_entries (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                recipient_email TEXT    NOT NULL,
                type           TEXT    NOT NULL DEFAULT 'comment_mention',
                card_id        INTEGER NOT NULL,
                comment_id     INTEGER,
                payload        TEXT,
                is_read        INTEGER DEFAULT 0,
                created_at     TEXT    DEFAULT (datetime('now','localtime'))
            )
        ''')
        try:
            conn.execute('ALTER TABLE inbox_entries ADD COLUMN board_id INTEGER')
        except sqlite3.OperationalError:
            pass

        # Временный/гостевой доступ к доске — дата истечения (Must №78)
        try:
            conn.execute('ALTER TABLE board_access ADD COLUMN expires_at TEXT')
        except sqlite3.OperationalError:
            pass

        # ── История активности карточки (audit) ──
        conn.execute('''
            CREATE TABLE IF NOT EXISTS card_activity (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                card_id    INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
                event_type TEXT    NOT NULL,
                actor_name TEXT    NOT NULL DEFAULT '',
                detail     TEXT    NOT NULL DEFAULT '',
                created_at TEXT    DEFAULT (datetime('now','localtime'))
            )
        ''')

        # ── Кастомные поля ──
        conn.execute('''
            CREATE TABLE IF NOT EXISTS custom_fields (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
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
                id       INTEGER PRIMARY KEY AUTOINCREMENT,
                card_id  INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
                field_id INTEGER NOT NULL REFERENCES custom_fields(id) ON DELETE CASCADE,
                value    TEXT    NOT NULL DEFAULT '',
                UNIQUE(card_id, field_id)
            )
        ''')

        # ── Зеркальные карточки (Should №30) — не копия, а «окно» в исходную карточку:
        # ссылка на column_id/position, где показывается; данные всегда читаются из
        # исходной карточки, поэтому изменения видны сразу везде при следующей загрузке доски ──
        conn.execute('''
            CREATE TABLE IF NOT EXISTS card_mirrors (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                source_card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
                column_id      INTEGER NOT NULL REFERENCES columns(id) ON DELETE CASCADE,
                position       INTEGER DEFAULT 0,
                created_at     TEXT    DEFAULT (datetime('now','localtime'))
            )
        ''')

        # ── Двусторонняя связь карточка↔карточка (Should №31) ──
        conn.execute('''
            CREATE TABLE IF NOT EXISTS card_relations (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                card_a_id  INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
                card_b_id  INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
                created_at TEXT    DEFAULT (datetime('now','localtime')),
                UNIQUE(card_a_id, card_b_id)
            )
        ''')

        # ── Шаблоны досок (Should №9) — глобальные, не привязаны к workspace ──
        conn.execute('''
            CREATE TABLE IF NOT EXISTS board_templates (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                name       TEXT    NOT NULL,
                created_at TEXT    DEFAULT (datetime('now','localtime'))
            )
        ''')
        conn.execute('''
            CREATE TABLE IF NOT EXISTS board_template_columns (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                template_id INTEGER NOT NULL REFERENCES board_templates(id) ON DELETE CASCADE,
                name        TEXT    NOT NULL,
                position    INTEGER DEFAULT 0
            )
        ''')
        conn.execute('''
            CREATE TABLE IF NOT EXISTS board_template_custom_fields (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
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
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                board_id    INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
                name        TEXT    NOT NULL,
                title       TEXT    NOT NULL DEFAULT '',
                description TEXT    DEFAULT '',
                importance  TEXT    DEFAULT '',
                created_at  TEXT    DEFAULT (datetime('now','localtime'))
            )
        ''')
        conn.execute('''
            CREATE TABLE IF NOT EXISTS card_template_labels (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                template_id INTEGER NOT NULL REFERENCES card_templates(id) ON DELETE CASCADE,
                name        TEXT    NOT NULL DEFAULT '',
                color       TEXT    NOT NULL DEFAULT ''
            )
        ''')
        conn.execute('''
            CREATE TABLE IF NOT EXISTS card_template_checklists (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                template_id INTEGER NOT NULL REFERENCES card_templates(id) ON DELETE CASCADE,
                title       TEXT    NOT NULL DEFAULT 'Чек-лист',
                position    INTEGER DEFAULT 0
            )
        ''')
        conn.execute('''
            CREATE TABLE IF NOT EXISTS card_template_checklist_items (
                id                     INTEGER PRIMARY KEY AUTOINCREMENT,
                template_checklist_id  INTEGER NOT NULL REFERENCES card_template_checklists(id) ON DELETE CASCADE,
                text                   TEXT    NOT NULL,
                position               INTEGER DEFAULT 0
            )
        ''')
        conn.execute('''
            CREATE TABLE IF NOT EXISTS card_template_custom_fields (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                template_id INTEGER NOT NULL REFERENCES card_templates(id) ON DELETE CASCADE,
                field_id    INTEGER NOT NULL REFERENCES custom_fields(id) ON DELETE CASCADE,
                value       TEXT    DEFAULT ''
            )
        ''')

        # ── Разовый перенос меток-приоритетов (введённых временно 27.07) в cards.importance ──
        # Метки-приоритеты когда-то хранились в card_labels наравне с обычными метками;
        # теперь важность — отдельное поле карточки, а card_labels снова свободен для
        # произвольных пользовательских меток.
        placeholders = ','.join('?' * len(IMPORTANCE_LEVELS))
        importance_rows = conn.execute(
            f'SELECT card_id, name FROM card_labels WHERE name IN ({placeholders}) ORDER BY id DESC',
            [l['name'] for l in IMPORTANCE_LEVELS]
        ).fetchall()
        seen_cards = set()
        for row in importance_rows:
            if row['card_id'] in seen_cards:
                continue  # на карточке уже была только одна метка-приоритет, но на всякий случай
            seen_cards.add(row['card_id'])
            conn.execute('UPDATE cards SET importance=? WHERE id=?', (row['name'], row['card_id']))
        conn.execute(
            f'DELETE FROM card_labels WHERE name IN ({placeholders})',
            [l['name'] for l in IMPORTANCE_LEVELS]
        )


def _search_text_variants(q):
    """Для одиночного слова ≥5 букв добавляет 1-2 варианта с обрезанным концом —
    грубое (без словаря) приближение к морфологии: запрос «договора» находит
    карточки с «договор» и наоборот (Should №51). Многословные фразы не трогаем —
    там точное совпадение уже достаточно специфично."""
    q = q.strip()
    variants = [q]
    if q and ' ' not in q and len(q) >= 5:
        variants.append(q[:-1])
        if len(q) >= 6:
            variants.append(q[:-2])
    return variants


@app.route('/api/search')
def api_search():
    """Поддерживает операторы board:/member:/due:/is: вперемешку со свободным
    текстом (Should №49), например: `board:Маркетинг is:open due:overdue отчёт`."""
    if 'user' not in session: return jsonify({'error': 'unauthorized'}), 401
    raw_q = request.args.get('q', '').strip()
    if len(raw_q) < 2: return jsonify([])
    board_ids = _get_board_ids()
    if board_ids is not None and len(board_ids) == 0:
        return jsonify([])

    op_board = op_member = op_due = op_is = None
    free_words = []
    for token in raw_q.split():
        if ':' in token:
            key, _, val = token.partition(':')
            key = key.lower().strip()
            val = val.strip()
            if key == 'board' and val:
                op_board = val
            elif key == 'member' and val:
                op_member = val
            elif key == 'due' and val:
                op_due = val.lower()
            elif key == 'is' and val:
                op_is = val.lower()
            elif val:
                free_words.append(token)
        else:
            free_words.append(token)
    free_text = ' '.join(free_words).strip()

    with get_db() as conn:
        sql = '''
            SELECT DISTINCT c.id, c.title, col.name AS column_name,
                   b.id AS board_id, b.name AS board_name, b.color AS board_color
            FROM cards c
            JOIN columns col ON col.id = c.column_id
            JOIN boards b ON b.id = col.board_id
        '''
        wheres = ['(c.archived=0 OR c.archived IS NULL)']
        params = []

        if op_member:
            sql += ' JOIN card_members cm ON cm.card_id = c.id'
            wheres.append('(LOWER(cm.user_email) LIKE ? OR LOWER(cm.user_name) LIKE ?)')
            like_m = f'%{op_member.lower()}%'
            params += [like_m, like_m]

        if free_text:
            variants = _search_text_variants(free_text)
            ors = ' OR '.join(['c.title LIKE ? OR c.description LIKE ?'] * len(variants))
            wheres.append(f'({ors})')
            for v in variants:
                params += [f'%{v}%', f'%{v}%']

        if op_board:
            wheres.append('LOWER(b.name) LIKE ?')
            params.append(f'%{op_board.lower()}%')

        if op_due == 'overdue':
            wheres.append("TRIM(COALESCE(c.due_date,'')) != '' AND (substr(c.due_date,7,4)||substr(c.due_date,4,2)||substr(c.due_date,1,2)) < ?")
            params.append(datetime.now().strftime('%Y%m%d'))
        elif op_due in ('today', 'soon'):
            today_key = datetime.now().strftime('%Y%m%d')
            tomorrow_key = (datetime.now() + timedelta(days=1)).strftime('%Y%m%d')
            wheres.append("TRIM(COALESCE(c.due_date,'')) != '' AND (substr(c.due_date,7,4)||substr(c.due_date,4,2)||substr(c.due_date,1,2)) IN (?,?)")
            params += [today_key, tomorrow_key]

        if op_is in ('done', 'complete', 'completed'):
            wheres.append('c.completed=1')
        elif op_is in ('open', 'active'):
            wheres.append('(c.completed=0 OR c.completed IS NULL)')

        if board_ids is not None:
            ph = ','.join('?' * len(board_ids))
            wheres.append(f'b.id IN ({ph})')
            params += board_ids

        sql += ' WHERE ' + ' AND '.join(wheres)
        sql += ' ORDER BY b.name, col.name LIMIT 20'
        rows = conn.execute(sql, params).fetchall()
    return jsonify([dict(r) for r in rows])


@app.route('/health')
def health():
    return jsonify({'status': 'ok'})


with app.app_context():
    init_db()
    migrate_db()

if __name__ == '__main__':
    app.run(debug=False, port=5001)
