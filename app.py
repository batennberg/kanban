from dotenv import load_dotenv
load_dotenv()

from flask import Flask, render_template, redirect, url_for, session, request, jsonify, send_file
from models import get_db, init_db
from werkzeug.utils import secure_filename
from werkzeug.security import check_password_hash
import sqlite3, os, uuid, csv, io, shutil
from datetime import timedelta
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


# ===== DUPLICATE HELPERS (карточка → список → доска) =====
# Комментарии и вложения сознательно не копируются (как в Trello) — это история
# оригинала, а не шаблон для копии.

def _duplicate_card(conn, src_card_id, target_column_id, position, title_suffix=''):
    src = conn.execute('SELECT * FROM cards WHERE id=?', (src_card_id,)).fetchone()
    cur = conn.execute(
        '''INSERT INTO cards
           (column_id, title, description, label, label_color, due_date, position, cover_color)
           VALUES (?,?,?,?,?,?,?,?)''',
        (target_column_id, src['title'] + title_suffix, src['description'],
         src['label'], src['label_color'], src['due_date'], position, src['cover_color'])
    )
    new_card_id = cur.lastrowid
    for item in conn.execute(
        'SELECT * FROM checklist_items WHERE card_id=? ORDER BY position', (src_card_id,)
    ):
        conn.execute(
            'INSERT INTO checklist_items (card_id, text, checked, position) VALUES (?,?,?,?)',
            (new_card_id, item['text'], item['checked'], item['position'])
        )
    for m in conn.execute('SELECT * FROM card_members WHERE card_id=?', (src_card_id,)):
        conn.execute(
            'INSERT OR IGNORE INTO card_members (card_id, user_email, user_name) VALUES (?,?,?)',
            (new_card_id, m['user_email'], m['user_name'])
        )
    return new_card_id

def _duplicate_column(conn, src_col_id, target_board_id, position, name_suffix=''):
    src = conn.execute('SELECT * FROM columns WHERE id=?', (src_col_id,)).fetchone()
    cur = conn.execute(
        'INSERT INTO columns (board_id, name, position) VALUES (?,?,?)',
        (target_board_id, src['name'] + name_suffix, position)
    )
    new_col_id = cur.lastrowid
    cards = conn.execute(
        'SELECT id FROM cards WHERE column_id=? AND (archived=0 OR archived IS NULL) ORDER BY position',
        (src_col_id,)
    ).fetchall()
    for i, card in enumerate(cards):
        _duplicate_card(conn, card['id'], new_col_id, i)
    return new_col_id

def _duplicate_board(conn, src_board_id, name_suffix=' (копия)'):
    src = conn.execute('SELECT * FROM boards WHERE id=?', (src_board_id,)).fetchone()
    cur = conn.execute(
        'INSERT INTO boards (name, company, color, workspace_id, description) VALUES (?,?,?,?,?)',
        (src['name'] + name_suffix, src['company'], src['color'], src['workspace_id'], src['description'])
    )
    new_board_id = cur.lastrowid
    cols = conn.execute(
        'SELECT id FROM columns WHERE board_id=? AND (archived=0 OR archived IS NULL) ORDER BY position',
        (src_board_id,)
    ).fetchall()
    for i, col in enumerate(cols):
        _duplicate_column(conn, col['id'], new_board_id, i)
    for row in conn.execute('SELECT user_id FROM board_access WHERE board_id=?', (src_board_id,)):
        conn.execute(
            'INSERT OR IGNORE INTO board_access (user_id, board_id) VALUES (?,?)',
            (row['user_id'], new_board_id)
        )
    return new_board_id


app = Flask(__name__)
app.secret_key = os.environ.get('SECRET_KEY') or 'dev-stub-key-change-in-prod'
app.config['SESSION_COOKIE_HTTPONLY'] = True
app.config['SESSION_COOKIE_SAMESITE'] = 'Lax'
app.config['MAX_CONTENT_LENGTH'] = 16 * 1024 * 1024  # 16 МБ
app.config['PERMANENT_SESSION_LIFETIME'] = timedelta(days=30)


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
                        board_ids = [r[0] for r in conn.execute(
                            'SELECT board_id FROM board_access WHERE user_id=?', (user['id'],)
                        ).fetchall()]
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
    """Возвращает список доступных board_id для текущего пользователя или None (все)."""
    from sheets import is_configured, get_user, get_board_ids
    if is_configured():
        user_rec = get_user(session['user']['email'])
        if not user_rec:
            return []
        return get_board_ids(user_rec)
    return session['user'].get('board_ids')  # fallback: SQLite-сессия


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
        for col in conn.execute(
            'SELECT * FROM columns WHERE board_id=? AND (archived=0 OR archived IS NULL) ORDER BY position',
            (board_id,)
        ):
            col_dict = dict(col)
            col_dict['cards'] = [
                dict(c) for c in conn.execute(
                    'SELECT * FROM cards WHERE column_id=? AND (archived=0 OR archived IS NULL) ORDER BY position', (col['id'],)
                )
            ]
            board_data['columns'].append(col_dict)
    return render_template('board.html', board=board_data, board_id=board_id, user=session['user'])


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
    return jsonify({
        'id': bid, 'name': name, 'company': company,
        'color': color, 'workspace_id': workspace_id,
        'workspace_color': ws_color
    })

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
    from sheets import is_configured, create_user, get_user
    if not is_configured():
        return jsonify({'error': 'Google Sheets не настроен'}), 503
    if get_user(email):
        return jsonify({'error': 'Пользователь с таким email уже существует'}), 409
    create_user(email, name, password, role, boards)
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
    from sheets import is_configured, update_user
    if not is_configured():
        return jsonify({'error': 'Google Sheets не настроен'}), 503
    ok = update_user(email, name=name, password=password, role=role, boards=boards)
    return jsonify({'ok': ok}) if ok else (jsonify({'error': 'не найден'}), 404)


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


@app.route('/api/columns/<int:col_id>/duplicate', methods=['POST'])
def api_duplicate_column(col_id):
    if 'user' not in session: return jsonify({'error': 'unauthorized'}), 401
    with get_db() as conn:
        src = conn.execute('SELECT * FROM columns WHERE id=?', (col_id,)).fetchone()
        if not src: return jsonify({'error': 'not found'}), 404
        pos = conn.execute(
            'SELECT COALESCE(MAX(position),-1)+1 FROM columns WHERE board_id=?', (src['board_id'],)
        ).fetchone()[0]
        new_col_id = _duplicate_column(conn, col_id, src['board_id'], pos, name_suffix=' (копия)')
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
            'INSERT INTO cards (column_id,title,label,label_color,due_date,position) VALUES(?,?,?,?,?,?)',
            (col_id, title, d.get('label',''), d.get('label_color',''), d.get('due_date',''), pos)
        )
        card_id = cur.lastrowid
        card = dict(conn.execute('SELECT * FROM cards WHERE id=?', (card_id,)).fetchone())
    return jsonify(card)

@app.route('/api/cards/<int:card_id>', methods=['GET'])
def api_get_card(card_id):
    if 'user' not in session: return jsonify({'error': 'unauthorized'}), 401
    with get_db() as conn:
        card = conn.execute('SELECT * FROM cards WHERE id=?', (card_id,)).fetchone()
        if not card: return jsonify({'error': 'not found'}), 404
        card_dict = dict(card)
        comments = [dict(c) for c in conn.execute(
            'SELECT * FROM comments WHERE card_id=? ORDER BY created_at', (card_id,)
        )]
        attachments = [dict(a) for a in conn.execute(
            'SELECT * FROM attachments WHERE card_id=? ORDER BY uploaded_at', (card_id,)
        )]
        checklist = [dict(c) for c in conn.execute(
            'SELECT * FROM checklist_items WHERE card_id=? ORDER BY position', (card_id,)
        )]
        members = [dict(m) for m in conn.execute(
            'SELECT * FROM card_members WHERE card_id=? ORDER BY id', (card_id,)
        )]
        if card_dict.get('linked_board_id'):
            lb = conn.execute('SELECT id, name, color FROM boards WHERE id=?',
                              (card_dict['linked_board_id'],)).fetchone()
            if lb:
                card_dict['linked_board_name']  = lb['name']
                card_dict['linked_board_color'] = lb['color']
    return jsonify({**card_dict, 'comments': comments, 'attachments': attachments,
                    'checklist': checklist, 'members': members})

@app.route('/api/cards/<int:card_id>', methods=['PUT'])
def api_update_card(card_id):
    if 'user' not in session: return jsonify({'error': 'unauthorized'}), 401
    d = request.get_json()
    allowed = ['title', 'description', 'label', 'label_color', 'due_date', 'column_id', 'position', 'completed', 'cover_color', 'linked_board_id']
    fields, values = [], []
    for f in allowed:
        if f in d:
            fields.append(f'{f}=?')
            values.append(d[f])
    if fields:
        values.append(card_id)
        with get_db() as conn:
            conn.execute(f'UPDATE cards SET {",".join(fields)} WHERE id=?', values)
    return jsonify({'ok': True})

@app.route('/api/cards/<int:card_id>', methods=['DELETE'])
def api_delete_card(card_id):
    if 'user' not in session: return jsonify({'error': 'unauthorized'}), 401
    with get_db() as conn:
        conn.execute(
            "UPDATE cards SET archived=1, archived_at=datetime('now','localtime') WHERE id=?",
            (card_id,)
        )
    return jsonify({'ok': True})

@app.route('/api/cards/<int:card_id>/restore', methods=['POST'])
def api_restore_card(card_id):
    if 'user' not in session: return jsonify({'error': 'unauthorized'}), 401
    with get_db() as conn:
        conn.execute('UPDATE cards SET archived=0, archived_at=NULL WHERE id=?', (card_id,))
    return jsonify({'ok': True})

@app.route('/api/archive')
def api_archive():
    if 'user' not in session: return jsonify({'error': 'unauthorized'}), 401
    board_ids = _get_board_ids()
    if board_ids is not None and len(board_ids) == 0:
        return jsonify([])
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
            conn.execute('UPDATE cards SET column_id=?,position=? WHERE id=?',
                         (item['column_id'], item['position'], item['id']))
    return jsonify({'ok': True})


# ===== API — CHECKLIST =====

@app.route('/api/cards/<int:card_id>/checklist', methods=['POST'])
def api_add_checklist_item(card_id):
    if 'user' not in session: return jsonify({'error': 'unauthorized'}), 401
    text = request.get_json().get('text', '').strip()
    if not text: return jsonify({'error': 'empty'}), 400
    with get_db() as conn:
        pos = conn.execute('SELECT COALESCE(MAX(position),-1)+1 FROM checklist_items WHERE card_id=?', (card_id,)).fetchone()[0]
        cur = conn.execute('INSERT INTO checklist_items (card_id,text,position) VALUES(?,?,?)', (card_id, text, pos))
        row = dict(conn.execute('SELECT * FROM checklist_items WHERE id=?', (cur.lastrowid,)).fetchone())
    return jsonify(row), 201

@app.route('/api/checklist/<int:item_id>', methods=['PUT'])
def api_update_checklist_item(item_id):
    if 'user' not in session: return jsonify({'error': 'unauthorized'}), 401
    d = request.get_json()
    fields, values = [], []
    for f in ['text', 'checked']:
        if f in d:
            fields.append(f'{f}=?')
            values.append(d[f])
    if fields:
        values.append(item_id)
        with get_db() as conn:
            conn.execute(f'UPDATE checklist_items SET {",".join(fields)} WHERE id=?', values)
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
    text = request.get_json().get('text', '').strip()
    if not text: return jsonify({'error': 'empty'}), 400
    with get_db() as conn:
        cur = conn.execute('INSERT INTO comments (card_id,author,text) VALUES(?,?,?)',
                           (card_id, session['user']['name'], text))
        row = dict(conn.execute('SELECT * FROM comments WHERE id=?', (cur.lastrowid,)).fetchone())
    return jsonify(row)

@app.route('/api/comments/<int:comment_id>', methods=['DELETE'])
def api_delete_comment(comment_id):
    if 'user' not in session: return jsonify({'error': 'unauthorized'}), 401
    with get_db() as conn:
        conn.execute('DELETE FROM comments WHERE id=?', (comment_id,))
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
        new_card['checklist'] = [dict(c) for c in conn.execute(
            'SELECT * FROM checklist_items WHERE card_id=? ORDER BY position', (new_card_id,)
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
    return jsonify({'ok': True})

@app.route('/api/cards/<int:card_id>/members/<path:email>', methods=['DELETE'])
def api_remove_card_member(card_id, email):
    if 'user' not in session: return jsonify({'error': 'unauthorized'}), 401
    with get_db() as conn:
        conn.execute(
            'DELETE FROM card_members WHERE card_id=? AND user_email=?', (card_id, email)
        )
    return jsonify({'ok': True})


# ===== API — ACCESS MANAGEMENT =====

@app.route('/api/boards/<int:board_id>/access', methods=['GET'])
def api_get_board_access(board_id):
    if 'user' not in session or session['user']['role'] != 'admin':
        return jsonify({'error': 'forbidden'}), 403
    with get_db() as conn:
        rows = conn.execute('''
            SELECT u.id, u.name, u.email,
                   CASE WHEN ba.user_id IS NOT NULL THEN 1 ELSE 0 END AS has_access
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
    user_id = request.get_json().get('user_id')
    if not user_id:
        return jsonify({'error': 'user_id required'}), 400
    with get_db() as conn:
        conn.execute('INSERT OR IGNORE INTO board_access (user_id, board_id) VALUES (?,?)', (user_id, board_id))
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
    if 'user' not in session: return jsonify({'error': 'unauthorized'}), 401
    name = request.get_json().get('name', '').strip()
    if not name: return jsonify({'error': 'name required'}), 400
    with get_db() as conn:
        conn.execute('UPDATE columns SET name=? WHERE id=?', (name, col_id))
    return jsonify({'ok': True})


@app.route('/api/columns/<int:col_id>', methods=['DELETE'])
def api_delete_column(col_id):
    if 'user' not in session: return jsonify({'error': 'unauthorized'}), 401
    with get_db() as conn:
        conn.execute(
            "UPDATE columns SET archived=1, archived_at=datetime('now','localtime') WHERE id=?",
            (col_id,)
        )
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
    with get_db() as conn:
        board = conn.execute('SELECT * FROM boards WHERE id=?', (board_id,)).fetchone()
        if not board:
            return jsonify({'error': 'Not found'}), 404
        rows = conn.execute('''
            SELECT ca.id, co.name AS col_name, ca.title, ca.description,
                   ca.label, ca.due_date,
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

    cm_map = {}
    for m in members_rows:
        cm_map.setdefault(m['card_id'], []).append(m['member'])

    output = io.StringIO()
    w = csv.writer(output)
    w.writerow(['Колонка', 'Карточка', 'Описание', 'Метка', 'Срок', 'Статус', 'Участники'])
    for r in rows:
        w.writerow([r['col_name'], r['title'], r['description'],
                    r['label'], r['due_date'], r['status'],
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
    with get_db() as conn:
        ws = conn.execute('SELECT * FROM workspaces WHERE id=?', (ws_id,)).fetchone()
        if not ws:
            return jsonify({'error': 'Not found'}), 404
        rows = conn.execute('''
            SELECT ca.id, b.name AS board_name, co.name AS col_name,
                   ca.title, ca.description, ca.label, ca.due_date,
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

    cm_map = {}
    for m in members_rows:
        cm_map.setdefault(m['card_id'], []).append(m['member'])

    output = io.StringIO()
    w = csv.writer(output)
    w.writerow(['Доска', 'Колонка', 'Карточка', 'Описание', 'Метка', 'Срок', 'Статус', 'Участники'])
    for r in rows:
        w.writerow([r['board_name'], r['col_name'], r['title'],
                    r['description'], r['label'], r['due_date'],
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
            'ALTER TABLE columns ADD COLUMN archived       INTEGER DEFAULT 0',
            'ALTER TABLE columns ADD COLUMN archived_at    TEXT',
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


@app.route('/api/search')
def api_search():
    if 'user' not in session: return jsonify({'error': 'unauthorized'}), 401
    q = request.args.get('q', '').strip()
    if len(q) < 2: return jsonify([])
    board_ids = _get_board_ids()
    like = f'%{q}%'
    with get_db() as conn:
        sql = '''
            SELECT c.id, c.title, col.name AS column_name,
                   b.id AS board_id, b.name AS board_name, b.color AS board_color
            FROM cards c
            JOIN columns col ON col.id = c.column_id
            JOIN boards b ON b.id = col.board_id
            WHERE (c.title LIKE ? OR c.description LIKE ?)
        '''
        params = [like, like]
        if board_ids is not None:
            if len(board_ids) == 0: return jsonify([])
            ph = ','.join('?' * len(board_ids))
            sql += f' AND b.id IN ({ph})'
            params += board_ids
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
