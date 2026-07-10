import os
import time
import gspread
from google.oauth2.service_account import Credentials

CREDS_FILE = os.environ.get(
    'GOOGLE_CREDENTIALS_PATH',
    os.path.join(os.path.dirname(__file__), 'google_credentials.json')
)

# ID Google-таблицы с пользователями.
# Получить: открыть таблицу → скопировать из URL часть между /d/ и /edit
# Пример URL: https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms/edit
# Можно задать через переменную окружения USERS_SHEET_ID
USERS_SHEET_ID = os.environ.get('USERS_SHEET_ID', '')

# Структура листа (первая строка — заголовки):
# Email | Имя | Пароль | Роль | Доски
#
# Роль:   admin — доступ ко всем доскам
#         user  — только доски из столбца "Доски"
# Доски:  ID через запятую: 1,3,5   (для admin можно оставить пустым)

SCOPES = ['https://www.googleapis.com/auth/spreadsheets']

_cache = {'data': None, 'ts': 0}
CACHE_TTL = 300  # секунд (5 минут)


def is_configured():
    return bool(USERS_SHEET_ID and os.path.exists(CREDS_FILE))


def _client():
    creds = Credentials.from_service_account_file(CREDS_FILE, scopes=SCOPES)
    return gspread.authorize(creds)


def _load_users():
    global _cache
    now = time.time()
    if _cache['data'] is not None and now - _cache['ts'] < CACHE_TTL:
        return _cache['data']
    gc = _client()
    sh = gc.open_by_key(USERS_SHEET_ID)
    ws = sh.get_worksheet(0)
    # get_all_values возвращает всё как строки — gspread не конвертирует числа
    all_values = ws.get_all_values()
    if not all_values:
        return []
    headers = [h.strip() for h in all_values[0]]
    records = [
        dict(zip(headers, row))
        for row in all_values[1:]
        if any(cell.strip() for cell in row)
    ]
    _cache = {'data': records, 'ts': now}
    return records


def get_user(email):
    """Найти пользователя по email. Возвращает dict из листа или None."""
    users = _load_users()
    target = email.strip().lower()
    for u in users:
        if str(u.get('Email', '')).strip().lower() == target:
            return u
    return None


def get_board_ids(user_record):
    """
    Возвращает список ID досок, доступных пользователю, или None (= все доски).
    admin → None (все доски)
    user  → список ID из столбца 'Доски'; '*' = все доски
    """
    role = str(user_record.get('Роль', 'user')).strip().lower()
    if role == 'admin':
        return None
    boards_raw = user_record.get('Доски', '')
    # gspread может вернуть int если ячейка не отформатирована как текст
    if isinstance(boards_raw, int):
        return [boards_raw] if boards_raw > 0 else []
    boards_str = str(boards_raw).strip()
    if not boards_str or boards_str == '*':
        return None if boards_str == '*' else []
    ids = []
    for p in boards_str.split(','):
        p = p.strip()
        if p.isdigit():
            ids.append(int(p))
    return ids


def invalidate_cache():
    global _cache
    _cache = {'data': None, 'ts': 0}


def get_all_users():
    """Все пользователи из листа (для admin UI)."""
    return _load_users()


def create_user(email, name, password, role, boards=''):
    """Добавляет новую строку в Google Sheet и сбрасывает кэш."""
    gc = _client()
    sh = gc.open_by_key(USERS_SHEET_ID)
    ws = sh.get_worksheet(0)
    ws.append_row([email, name, password, role, boards], value_input_option='RAW')
    invalidate_cache()


def update_user(email, name=None, password=None, role=None, boards=None):
    """Обновляет поля пользователя в Google Sheet."""
    gc = _client()
    sh = gc.open_by_key(USERS_SHEET_ID)
    ws = sh.get_worksheet(0)
    all_values = ws.get_all_values()
    if not all_values:
        return False
    headers = [h.strip() for h in all_values[0]]
    col = {h: i for i, h in enumerate(headers)}
    target = email.strip().lower()
    for i, row in enumerate(all_values[1:], start=2):
        if row[col.get('Email', 0)].strip().lower() == target:
            updates = []
            if name     is not None: updates.append((i, col['Имя'] + 1,    name))
            if password is not None: updates.append((i, col['Пароль'] + 1, password))
            if role     is not None: updates.append((i, col['Роль'] + 1,   role))
            if boards   is not None: updates.append((i, col['Доски'] + 1,  boards))
            for row_i, col_i, val in updates:
                ws.update_cell(row_i, col_i, val)
            invalidate_cache()
            return True
    return False


def delete_user(email):
    """Удаляет строку с пользователем по email."""
    gc = _client()
    sh = gc.open_by_key(USERS_SHEET_ID)
    ws = sh.get_worksheet(0)
    all_values = ws.get_all_values()
    if not all_values:
        return False
    headers = [h.strip() for h in all_values[0]]
    email_col = headers.index('Email') + 1 if 'Email' in headers else 1
    target = email.strip().lower()
    for i, row in enumerate(all_values[1:], start=2):
        if row[email_col - 1].strip().lower() == target:
            ws.delete_rows(i)
            invalidate_cache()
            return True
    return False
