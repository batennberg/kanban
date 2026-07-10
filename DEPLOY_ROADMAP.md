# Роудмап: Kanban App → Production

## Фаза 0: Выбор целевой среды

| Вариант | Когда подходит |
|---------|----------------|
| **Локальная сеть (Windows)** | Есть Windows-машина/сервер в сети офиса |
| **Локальная сеть (Linux VM)** | Есть Linux-сервер / виртуалка |
| **VPS-хостинг** | Нужен доступ извне офиса |

Фазы 1–3 одинаковы для всех вариантов.

---

## Фаза 1: Security Hardening (~2 часа)

- [ ] **SECRET_KEY из переменной окружения**
  ```python
  # app.py
  app.secret_key = os.environ.get('SECRET_KEY') or 'dev-only-key'
  ```
  Создать `.env` файл с реальным ключом (32+ случайных символа).

- [ ] **Убрать `debug=True`**
  ```python
  app.run(debug=False, port=5001)
  # или вовсе убрать — gunicorn/waitress сам управляет запуском
  ```

- [ ] **Безопасные настройки сессии**
  ```python
  app.config['SESSION_COOKIE_HTTPONLY'] = True
  app.config['SESSION_COOKIE_SAMESITE'] = 'Lax'
  # SESSION_COOKIE_SECURE = True — добавить только если HTTPS
  ```

- [ ] **Лимит размера загружаемых файлов**
  ```python
  app.config['MAX_CONTENT_LENGTH'] = 16 * 1024 * 1024  # 16 МБ
  ```

- [ ] **Пароли в Google Sheets — plaintext.** Для внутреннего корпоративного инструмента допустимо, если Sheets доступна только администратору. Задокументировать как known risk.

---

## Фаза 2: Production Config (~1 час)

- [ ] **Установить python-dotenv**
  ```
  pip install python-dotenv
  ```
  ```python
  # app.py, в самом начале
  from dotenv import load_dotenv
  load_dotenv()
  ```

- [ ] **Перенести `init_db()` и `migrate_db()` из `if __name__ == '__main__'`**

  Сейчас они запускаются только при `python app.py`. При запуске через gunicorn/waitress — не запускаются.
  ```python
  # app.py — вне if __name__, в конце файла
  with app.app_context():
      init_db()
      migrate_db()
  ```

- [ ] **Путь к Google credentials через env-переменную**
  ```
  # .env
  GOOGLE_CREDENTIALS_PATH=/secure/path/google_credentials.json
  ```
  ```python
  # sheets.py
  CREDS_PATH = os.environ.get('GOOGLE_CREDENTIALS_PATH', 'google_credentials.json')
  ```

- [ ] **Добавить `/health` endpoint для мониторинга**
  ```python
  @app.route('/health')
  def health():
      return jsonify({'status': 'ok'})
  ```

- [ ] **Создать `.env.example`** — шаблон без секретов, для документации
  ```
  SECRET_KEY=your-random-secret-key-here
  GOOGLE_CREDENTIALS_PATH=google_credentials.json
  ```

- [ ] **Добавить `.env` в `.gitignore`** (если проект когда-либо попадёт в git)

---

## Фаза 3: WSGI-сервер (~30 мин)

Заменить Flask dev server на production-ready WSGI.

### Windows → waitress

```
pip install waitress
```

Создать `serve.py` рядом с `app.py`:
```python
from waitress import serve
from app import app

if __name__ == '__main__':
    serve(app, host='0.0.0.0', port=5001, threads=4)
```

Запуск: `python serve.py`

### Linux → gunicorn

```
pip install gunicorn
gunicorn -w 4 -b 0.0.0.0:5001 app:app
```

---

## Фаза 4: Деплой

### Вариант A — Windows (NSSM + waitress)

NSSM превращает Python-процесс в Windows Service с автозапуском.

```
# Скачать NSSM: https://nssm.cc/download
nssm install KanbanApp "C:\Python311\python.exe" "C:\kanban-app\serve.py"
nssm set KanbanApp AppDirectory "C:\kanban-app"
nssm set KanbanApp AppEnvironmentExtra SECRET_KEY=... GOOGLE_CREDENTIALS_PATH=...
nssm set KanbanApp AppStdout "C:\kanban-app\logs\app.log"
nssm set KanbanApp AppStderr "C:\kanban-app\logs\error.log"
nssm start KanbanApp
```

Доступ пользователей: `http://192.168.x.x:5001`

Опционально — добавить DNS-запись во внутреннем DNS:
`kanban.almaly.local → 192.168.x.x`
→ тогда доступ по `http://kanban.almaly.local:5001`

---

### Вариант B — Linux (systemd + NGINX)

**systemd-юнит** (`/etc/systemd/system/kanban.service`):
```ini
[Unit]
Description=Kanban App
After=network.target

[Service]
User=kanban
WorkingDirectory=/opt/kanban-app
EnvironmentFile=/opt/kanban-app/.env
ExecStart=/opt/kanban-app/venv/bin/gunicorn -w 4 -b 127.0.0.1:5001 app:app
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```
systemctl daemon-reload
systemctl enable kanban
systemctl start kanban
```

**NGINX** как reverse proxy (`/etc/nginx/sites-available/kanban`):
```nginx
server {
    listen 80;
    server_name kanban.almaly.local;

    client_max_body_size 16M;

    location /static/ {
        alias /opt/kanban-app/static/;
        expires 7d;
    }
    location /uploads/ {
        alias /opt/kanban-app/uploads/;
    }
    location / {
        proxy_pass http://127.0.0.1:5001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

```
ln -s /etc/nginx/sites-available/kanban /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
```

---

### Вариант C — VPS-хостинг (внешний доступ)

То же самое, что Вариант B, плюс:

- [ ] Зарегистрировать домен (например, `kanban.almaly.kz`)
- [ ] Прописать A-запись DNS: домен → IP сервера
- [ ] Получить бесплатный SSL-сертификат:
  ```
  apt install certbot python3-certbot-nginx
  certbot --nginx -d kanban.almaly.kz
  ```
- [ ] Добавить `SESSION_COOKIE_SECURE = True` в app.py (обязательно при HTTPS)
- [ ] Файрвол: открыть только порты 22, 80, 443

---

## Фаза 5: Резервное копирование (~30 мин)

### Windows (bat-файл + Task Scheduler)

Создать `backup.bat`:
```bat
@echo off
set BACKUP_DIR=\\server\backups\kanban
set DATE=%date:~6,4%%date:~3,2%%date:~0,2%
xcopy /Y "C:\kanban-app\kanban.db" "%BACKUP_DIR%\kanban_%DATE%.db*"
xcopy /E /Y "C:\kanban-app\uploads\" "%BACKUP_DIR%\uploads_%DATE%\"
```

Task Scheduler: ежедневно в 02:00.

### Linux (cron)

```cron
0 2 * * * cp /opt/kanban-app/kanban.db /backups/kanban/kanban_$(date +\%Y\%m\%d).db
0 2 * * * rsync -a /opt/kanban-app/uploads/ /backups/kanban/uploads/
```

Хранить 30 последних бэкапов:
```cron
0 3 * * * find /backups/kanban -name "kanban_*.db" -mtime +30 -delete
```

---

## Фаза 6: Мониторинг (опционально)

- [ ] Добавить `/health` endpoint (см. Фаза 2)
- [ ] Проверка доступности через Task Scheduler / cron каждые 5 минут:
  ```bat
  :: Windows
  curl -f http://localhost:5001/health || net start KanbanApp
  ```
  ```bash
  # Linux
  curl -sf http://localhost:5001/health || systemctl restart kanban
  ```
- [ ] Ротация логов (logrotate на Linux, или ограничение размера в NSSM)

---

## Итоговый чеклист

| #   | Задача                               | Приоритет        | Статус |
| --- | ------------------------------------ | ---------------- | ------ |
| 1   | SECRET_KEY из env                    | 🔴 Обязательно   | [ ]    |
| 2   | debug=False                          | 🔴 Обязательно   | [ ]    |
| 3   | migrate_db() вне `__main__`          | 🔴 Обязательно   | [ ]    |
| 4   | SESSION_COOKIE_HTTPONLY              | 🟠 Важно         | [ ]    |
| 5   | MAX_CONTENT_LENGTH 16MB              | 🟠 Важно         | [ ]    |
| 6   | python-dotenv + .env                 | 🟠 Важно         | [ ]    |
| 7   | GOOGLE_CREDENTIALS_PATH через env    | 🟠 Важно         | [ ]    |
| 8   | waitress или gunicorn                | 🔴 Обязательно   | [ ]    |
| 9   | Windows Service (NSSM) / systemd     | 🟠 Важно         | [ ]    |
| 10  | Бэкап kanban.db + uploads            | 🟠 Важно         | [ ]    |
| 11  | /health endpoint                     | 🟡 Рекомендуется | [ ]    |
| 12  | NGINX reverse proxy (Linux/VPS)      | 🟡 Рекомендуется | [ ]    |
| 13  | HTTPS / Let's Encrypt (VPS)          | 🟡 Рекомендуется | [ ]    |
| 14  | Внутренний DNS (kanban.almaly.local) | 🟡 Рекомендуется | [ ]    |

**Минимальный путь (только 🔴 + 🟠):** ~4–5 часов.
