// ===== РОЛЬ «НАБЛЮДАТЕЛЬ» (read-only, Must №76) =====

const _boardIsReadonly = document.getElementById('boardColumns')?.dataset.userRole === 'viewer';
if (_boardIsReadonly) {
    document.body.classList.add('is-readonly-viewer');
    document.querySelectorAll('.card').forEach(el => { el.draggable = false; });
}


// ===== DRAG-AND-DROP (карточки) =====

if (!_boardIsReadonly) {
    document.querySelectorAll('.cards-list').forEach(list => {
        new Sortable(list, {
            group: 'cards',
            animation: 150,
            ghostClass: 'sortable-ghost',
            dragClass: 'sortable-drag',
            delay: 300,
            delayOnTouchOnly: true,
            touchStartThreshold: 8,
            onEnd: () => { updateColumnCounts(); persistOrder(); }
        });
    });
}


// ===== DRAG-AND-DROP (колонки) =====

if (!_boardIsReadonly) {
    new Sortable(document.getElementById('boardColumns'), {
        animation: 200,
        handle: '.column-header',
        draggable: '.column:not(.column--add)',
        ghostClass: 'column-ghost',
        dragClass: 'column-dragging',
        onEnd: persistColumnOrder,
    });
}

function persistColumnOrder() {
    const columns = [];
    document.querySelectorAll('#boardColumns .column:not(.column--add)').forEach((col, pos) => {
        const id = parseInt(col.dataset.colId);
        if (id) columns.push({ id, position: pos });
    });
    if (columns.length) {
        fetch('/api/columns/reorder', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ columns })
        });
    }
}

function updateColumnCounts() {
    document.querySelectorAll('.column').forEach(col => {
        const counter = col.querySelector('.column-count');
        const list    = col.querySelector('.cards-list');
        if (counter && list) _setColumnCountDisplay(col, counter, list.querySelectorAll('.card').length);
    });
}

// WIP-лимит (Should №36) — общий рендер счётчика «N» / «N/лимит» с классом переполнения
function _setColumnCountDisplay(col, counter, count) {
    const limit = parseInt(col.dataset.wipLimit || '0');
    counter.textContent = limit ? `${count}/${limit}` : String(count);
    counter.classList.toggle('column-count--over', !!limit && count > limit);
    col.classList.toggle('column--wip-over', !!limit && count > limit);
}


// ===== ТАБЛИЧНЫЙ ВИД (Should №37) =====
// Строится из уже отрендеренного DOM канбан-доски — без отдельного запроса к серверу;
// поэтому автоматически учитывает уже применённые фильтры доски (скрытые фильтром
// карточки в таблицу не попадают).

let _tvSortKey  = null;
let _tvSortDir  = 1;
let _tvSelected = new Set();
let _tvRows     = [];

function _ruPlural(n, one, few, many) {
    const mod10 = Math.abs(n) % 10;
    const mod100 = Math.abs(n) % 100;
    if (mod100 > 10 && mod100 < 20) return many;
    if (mod10 === 1) return one;
    if (mod10 >= 2 && mod10 <= 4) return few;
    return many;
}

function _rgbToHex(rgb) {
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(rgb || '');
    if (!m) return rgb || '#6b778c';
    return '#' + [1, 2, 3].map(i => parseInt(m[i]).toString(16).padStart(2, '0')).join('');
}

// Единый переключатель альтернативных видов доски (Should №37/№38/...) — скрывает
// канбан-колонки и показывает ровно один из зарегистрированных видов за раз.
const _BOARD_VIEWS = {
    table:     { elId: 'tableView',     btnId: 'btnTableView',     txtId: 'btnTableViewText',     label: 'Таблица',   onShow: () => tvBuildRows() },
    calendar:  { elId: 'calendarView',  btnId: 'btnCalendarView',  txtId: 'btnCalendarViewText',  label: 'Календарь', onShow: () => calRender() },
    gantt:     { elId: 'ganttView',     btnId: 'btnGanttView',     txtId: 'btnGanttViewText',     label: 'Таймлайн',  onShow: () => ganttRender() },
    dashboard: { elId: 'dashboardView', btnId: 'btnDashboardView', txtId: 'btnDashboardViewText', label: 'Дашборд',   onShow: () => dashRender() },
};

function _switchBoardView(name) {
    const wrap = document.querySelector('.board-columns-wrap');
    if (!wrap) return;

    Object.values(_BOARD_VIEWS).forEach(v => {
        const el  = document.getElementById(v.elId);
        const btn = document.getElementById(v.btnId);
        const txt = document.getElementById(v.txtId);
        if (el)  el.style.display = 'none';
        if (btn) btn.classList.remove('btn-board-action--active');
        if (txt) txt.textContent = v.label;
    });

    if (name === 'kanban') {
        wrap.style.display = '';
        _syncBoardStateToURL();
        return;
    }

    const v = _BOARD_VIEWS[name];
    if (!v) return;
    wrap.style.display = 'none';
    const el  = document.getElementById(v.elId);
    const btn = document.getElementById(v.btnId);
    const txt = document.getElementById(v.txtId);
    if (el)  el.style.display = '';
    if (btn) btn.classList.add('btn-board-action--active');
    if (txt) txt.textContent = 'Доска';
    if (v.onShow) v.onShow();
    _syncBoardStateToURL();
}

window.toggleTableView = function() {
    const tv = document.getElementById('tableView');
    _switchBoardView(tv && tv.style.display !== 'none' ? 'kanban' : 'table');
};

window.toggleCalendarView = function() {
    const cal = document.getElementById('calendarView');
    _switchBoardView(cal && cal.style.display !== 'none' ? 'kanban' : 'calendar');
};

window.toggleGanttView = function() {
    const g = document.getElementById('ganttView');
    _switchBoardView(g && g.style.display !== 'none' ? 'kanban' : 'gantt');
};

window.toggleDashboardView = function() {
    const d = document.getElementById('dashboardView');
    _switchBoardView(d && d.style.display !== 'none' ? 'kanban' : 'dashboard');
};


// ===== СОХРАНЕНИЕ ФИЛЬТРА+ВИДА В ССЫЛКЕ (Should №45) =====
// Текущий вид и активные фильтры кодируются в query-параметрах через
// history.replaceState — обычная ссылка на доску воспроизводит и то, и другое
// у коллеги, без отдельного механизма «сохранённых представлений».

function _activeViewName() {
    return Object.keys(_BOARD_VIEWS).find(k => {
        const el = document.getElementById(_BOARD_VIEWS[k].elId);
        return el && el.style.display !== 'none';
    }) || null;
}

function _syncBoardStateToURL() {
    const boardId = _getBoardId();
    if (!boardId) return;

    const params = new URLSearchParams();
    const view = _activeViewName();
    if (view) params.set('view', view);

    if (activeFilters.labels.size)       params.set('labels', [...activeFilters.labels].join(','));
    if (activeFilters.importance.size)   params.set('importance', [...activeFilters.importance].join(','));
    if (activeFilters.due)               params.set('due', activeFilters.due);
    if (activeFilters.done)              params.set('done', activeFilters.done);
    if (activeFilters.members.size)      params.set('members', [...activeFilters.members].join(','));
    if (activeFilters.customFields.size) params.set('cf', [...activeFilters.customFields].join('|'));

    const cardParam = new URLSearchParams(location.search).get('card');
    if (cardParam) params.set('card', cardParam);

    const qs = params.toString();
    history.replaceState(null, '', `/board/${boardId}` + (qs ? `?${qs}` : ''));
}

function _restoreBoardStateFromURL() {
    const params = new URLSearchParams(location.search);
    const view       = params.get('view');
    const labels     = params.get('labels');
    const importance = params.get('importance');
    const due        = params.get('due');
    const done       = params.get('done');
    const members    = params.get('members');
    const cf         = params.get('cf');

    let hasAny = false;
    if (labels)     { activeFilters.labels       = new Set(labels.split(',').filter(Boolean));     hasAny = true; }
    if (importance) { activeFilters.importance   = new Set(importance.split(',').filter(Boolean)); hasAny = true; }
    if (due)        { activeFilters.due          = due;  hasAny = true; }
    if (done)       { activeFilters.done         = done; hasAny = true; }
    if (members)    { activeFilters.members      = new Set(members.split(',').filter(Boolean));    hasAny = true; }
    if (cf)         { activeFilters.customFields = new Set(cf.split('|').filter(Boolean));          hasAny = true; }

    if (hasAny) {
        const bar = document.getElementById('filterBar');
        if (bar) {
            buildLabelChips();
            buildImportanceChips();
            buildCustomFieldChips();
            buildMemberChips();
            bar.style.display = '';
            document.getElementById('btnFilters')?.classList.add('btn-board-action--active');
            if (due)  document.querySelector(`[data-filter-due="${due}"]`)?.classList.add('fb-chip--active');
            if (done) document.querySelector(`[data-filter-done="${done}"]`)?.classList.add('fb-chip--active');
        }
        applyFilters();
    }

    if (view && _BOARD_VIEWS[view]) _switchBoardView(view);
}

document.addEventListener('DOMContentLoaded', _restoreBoardStateFromURL);

async function _copyToClipboard(text, successMsg) {
    try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text);
        } else {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.opacity  = '0';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
        }
        showToast(successMsg);
    } catch (err) {
        console.error('_copyToClipboard error:', err);
        showToast('Не удалось скопировать ссылку', 'error');
    }
}

window.copyBoardViewLink = function() {
    _copyToClipboard(location.href, 'Ссылка на этот вид и фильтры скопирована');
};

function tvCollectCards() {
    const rows = [];
    document.querySelectorAll('.column:not(.column--add)').forEach(col => {
        const colName = col.querySelector('.column-title')?.textContent.trim() || '';
        col.querySelectorAll(':scope > .cards-list > .card').forEach(card => {
            if (card.style.display === 'none') return; // уважаем активные фильтры доски
            const labels = [...card.querySelectorAll('.card-label')].map(el => ({
                text: el.textContent.trim(), color: _rgbToHex(el.style.color)
            }));
            const importanceEl = card.querySelector('.card-importance');
            const dueEl        = card.querySelector('.card-due');
            const members = (card.dataset.members || '').split('|').filter(Boolean)
                .map(p => p.split('::')[1] || p.split('::')[0]);
            rows.push({
                cardId: card.dataset.cardId,
                title: card.querySelector('.card-title')?.textContent.trim() || '',
                column: colName,
                labels,
                importance: importanceEl ? importanceEl.textContent.trim() : '',
                importanceColor: importanceEl ? _rgbToHex(importanceEl.style.color) : '',
                due: dueEl ? dueEl.textContent.trim() : '',
                start: card.dataset.startDate || '',
                members,
                done: card.classList.contains('card--done'),
            });
        });
    });
    return rows;
}

window.tvBuildRows = function() {
    _tvRows = tvCollectCards();
    tvRender();
};

function _tvDueKey(due) {
    const parts = (due || '').split('.');
    if (parts.length !== 3) return '';
    return parts[2] + parts[1] + parts[0]; // ГГГГММДД — для сортировки по возрастанию даты
}

function tvCompare(a, b, key) {
    let av, bv;
    switch (key) {
        case 'title':      av = a.title; bv = b.title; break;
        case 'column':     av = a.column; bv = b.column; break;
        case 'labels':     av = a.labels.map(l => l.text).join(','); bv = b.labels.map(l => l.text).join(','); break;
        case 'importance': av = a.importance; bv = b.importance; break;
        case 'due':        av = _tvDueKey(a.due); bv = _tvDueKey(b.due); break;
        case 'members':    av = a.members.join(','); bv = b.members.join(','); break;
        case 'status':     av = a.done ? 1 : 0; bv = b.done ? 1 : 0; break;
        default: return 0;
    }
    if (av < bv) return -1;
    if (av > bv) return 1;
    return 0;
}

window.tvSort = function(key) {
    if (_tvSortKey === key) { _tvSortDir *= -1; } else { _tvSortKey = key; _tvSortDir = 1; }
    document.querySelectorAll('.tv-sort-arrow').forEach(el => el.textContent = '');
    const arrowEl = document.querySelector(`.tv-sort-arrow[data-sort-key="${key}"]`);
    if (arrowEl) arrowEl.textContent = _tvSortDir === 1 ? '▲' : '▼';
    tvRender();
};

function tvRender() {
    let rows = [..._tvRows];
    if (_tvSortKey) rows.sort((a, b) => _tvSortDir * tvCompare(a, b, _tvSortKey));

    const countEl = document.getElementById('tvCount');
    if (countEl) countEl.textContent = `${rows.length} ${_ruPlural(rows.length, 'карточка', 'карточки', 'карточек')}`;

    const tbody = document.getElementById('tvBody');
    if (!tbody) return;
    if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="8" class="tv-empty">Нет карточек</td></tr>';
        tvUpdateBulkBar();
        return;
    }
    tbody.innerHTML = rows.map(r => `
        <tr class="${r.done ? 'tv-row--done' : ''}">
            <td><input type="checkbox" class="tv-row-check" data-tv-card-id="${r.cardId}" onchange="tvToggleRow('${r.cardId}', this.checked)" ${_tvSelected.has(String(r.cardId)) ? 'checked' : ''}></td>
            <td><span class="tv-title" onclick="tvOpenCard('${r.cardId}')">${escHtml(r.title)}</span></td>
            <td>${escHtml(r.column)}</td>
            <td><div class="tv-labels">${r.labels.map(l => `<span class="card-label" style="background:${l.color}20;color:${l.color};border:1px solid ${l.color}40">${escHtml(l.text)}</span>`).join('')}</div></td>
            <td>${r.importance ? `<span class="card-importance" style="background:${r.importanceColor}20;color:${r.importanceColor};border:1px solid ${r.importanceColor}40">${escHtml(r.importance)}</span>` : ''}</td>
            <td>${escHtml(r.due)}</td>
            <td>${escHtml(r.members.join(', '))}</td>
            <td><span class="tv-status-badge tv-status-badge--${r.done ? 'done' : 'active'}">${r.done ? 'Выполнена' : 'Активна'}</span></td>
        </tr>
    `).join('');
    tvUpdateBulkBar();
}

window.tvOpenCard = function(cardId) {
    const cardEl = document.querySelector(`.cards-list .card[data-card-id="${cardId}"]`);
    if (cardEl) openCardModal(null, cardEl);
};

window.tvToggleRow = function(cardId, checked) {
    if (checked) _tvSelected.add(String(cardId)); else _tvSelected.delete(String(cardId));
    tvUpdateBulkBar();
};

window.tvToggleSelectAll = function(checked) {
    document.querySelectorAll('.tv-row-check').forEach(cb => {
        cb.checked = checked;
        if (checked) _tvSelected.add(cb.dataset.tvCardId); else _tvSelected.delete(cb.dataset.tvCardId);
    });
    tvUpdateBulkBar();
};

function tvUpdateBulkBar() {
    const bar = document.getElementById('tvBulkActions');
    const cnt = document.getElementById('tvSelectedCount');
    const all = document.getElementById('tvSelectAll');
    if (!bar || !cnt) return;
    bar.style.display = _tvSelected.size ? 'flex' : 'none';
    cnt.textContent = `${_tvSelected.size} выбрано`;
    if (all) all.checked = _tvRows.length > 0 && _tvSelected.size === _tvRows.length;
}

window.tvBulkMove = async function(colId) {
    if (!colId || !_tvSelected.size) return;
    for (const cardId of [..._tvSelected]) {
        await fetch(`/api/cards/${cardId}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ column_id: parseInt(colId), position: 9999 })
        });
        const cardEl     = document.querySelector(`.cards-list .card[data-card-id="${cardId}"]`);
        const targetList = document.getElementById('cards-' + colId);
        if (cardEl && targetList) targetList.appendChild(cardEl);
    }
    updateColumnCounts();
    _tvSelected.clear();
    document.getElementById('tvBulkMoveSelect').value = '';
    tvBuildRows();
    showToast('Карточки перемещены');
};

window.tvBulkComplete = async function() {
    if (!_tvSelected.size) return;
    for (const cardId of [..._tvSelected]) {
        await fetch(`/api/cards/${cardId}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ completed: 1 })
        });
        document.querySelector(`.cards-list .card[data-card-id="${cardId}"]`)?.classList.add('card--done');
    }
    _tvSelected.clear();
    tvBuildRows();
    showToast('Отмечены как выполненные');
};

window.tvBulkArchive = async function() {
    if (!_tvSelected.size) return;
    if (!confirm(`Отправить ${_tvSelected.size} ${_ruPlural(_tvSelected.size, 'карточку', 'карточки', 'карточек')} в архив?`)) return;
    for (const cardId of [..._tvSelected]) {
        await fetch(`/api/cards/${cardId}`, { method: 'DELETE' });
        document.querySelector(`.cards-list .card[data-card-id="${cardId}"]`)?.remove();
    }
    updateColumnCounts();
    _tvSelected.clear();
    tvBuildRows();
    showToast('Отправлены в архив');
};


// ===== КАЛЕНДАРЬ (Should №38) =====
// Как и табличный вид — строится из уже отрендеренного DOM доски (переиспользует
// tvCollectCards), группируя карточки по due_date. Карточки без срока в сетку
// не попадают — просто считаются в сноске.

const _CAL_WEEKDAYS = ['Пн','Вт','Ср','Чт','Пт','Сб','Вс'];
const _CAL_MONTHS = ['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
let _calYear  = null;
let _calMonth = null; // 0-11

window.calNavigate = function(delta) {
    _calMonth += delta;
    if (_calMonth < 0)  { _calMonth = 11; _calYear--; }
    if (_calMonth > 11) { _calMonth = 0;  _calYear++; }
    calRender();
};

window.calGoToday = function() {
    const today = new Date();
    _calYear  = today.getFullYear();
    _calMonth = today.getMonth();
    calRender();
};

function calRender() {
    if (_calYear === null) {
        const today = new Date();
        _calYear  = today.getFullYear();
        _calMonth = today.getMonth();
    }

    const label = document.getElementById('calMonthLabel');
    if (label) label.textContent = `${_CAL_MONTHS[_calMonth]} ${_calYear}`;

    const rows = tvCollectCards();
    const cardsByDate = {};
    let noDateCount = 0;
    rows.forEach(r => {
        const parts = (r.due || '').split('.');
        if (parts.length !== 3) { noDateCount++; return; }
        const key = `${parts[2]}-${parts[1].padStart(2,'0')}-${parts[0].padStart(2,'0')}`;
        (cardsByDate[key] = cardsByDate[key] || []).push(r);
    });

    const noDateEl = document.getElementById('calNoDateCount');
    if (noDateEl) noDateEl.textContent = noDateCount
        ? `${noDateCount} ${_ruPlural(noDateCount, 'карточка', 'карточки', 'карточек')} без срока`
        : '';

    const grid = document.getElementById('calGrid');
    if (!grid) return;

    const firstOfMonth = new Date(_calYear, _calMonth, 1);
    const daysInMonth  = new Date(_calYear, _calMonth + 1, 0).getDate();
    const startOffset  = (firstOfMonth.getDay() + 6) % 7; // JS: вс=0 -> делаем пн=0

    const t = new Date();
    const todayKey = `${t.getFullYear()}-${String(t.getMonth()+1).padStart(2,'0')}-${String(t.getDate()).padStart(2,'0')}`;

    let html = _CAL_WEEKDAYS.map(w => `<div class="cal-weekday">${w}</div>`).join('');
    for (let i = 0; i < startOffset; i++) html += '<div class="cal-cell cal-cell--empty"></div>';

    for (let day = 1; day <= daysInMonth; day++) {
        const key = `${_calYear}-${String(_calMonth+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
        const dayCards = cardsByDate[key] || [];
        html += `
            <div class="cal-cell${key === todayKey ? ' cal-cell--today' : ''}">
                <div class="cal-cell-date">${day}</div>
                <div class="cal-cell-cards">
                    ${dayCards.map(r => `
                        <div class="cal-chip${r.done ? ' cal-chip--done' : ''}" onclick="tvOpenCard('${r.cardId}')" title="${escHtml(r.column)}">
                            ${r.labels[0] ? `<span class="cal-chip-dot" style="background:${r.labels[0].color}"></span>` : ''}${escHtml(r.title)}
                        </div>
                    `).join('')}
                </div>
            </div>`;
    }

    grid.innerHTML = html;
}


// ===== ТАЙМЛАЙН / ГАНТ (Should №39) =====
// Тоже строится из tvCollectCards(). Показываются только карточки со сроком
// (due_date обязателен, start_date — если есть, иначе полоса рисуется в 1 день на срок).

function _dateFromRu(str) {
    const p = (str || '').split('.');
    if (p.length !== 3) return null;
    const d = new Date(parseInt(p[2], 10), parseInt(p[1], 10) - 1, parseInt(p[0], 10));
    return isNaN(d.getTime()) ? null : d;
}

function _daysBetween(a, b) {
    return Math.round((b - a) / 86400000);
}

function _isSameDay(a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function ganttRender() {
    const grid = document.getElementById('ganttGrid');
    if (!grid) return;

    const rows = tvCollectCards()
        .map(r => ({ ...r, dueDate: _dateFromRu(r.due) }))
        .filter(r => r.dueDate)
        .map(r => ({ ...r, startDate: _dateFromRu(r.start) || r.dueDate }))
        .sort((a, b) => a.startDate - b.startDate);

    if (!rows.length) {
        grid.style.gridTemplateColumns = '';
        grid.innerHTML = '<div class="gantt-empty">Нет карточек со сроком — таймлайн строится по датам начала/срока</div>';
        return;
    }

    let minDate = rows[0].startDate, maxDate = rows[0].dueDate;
    rows.forEach(r => {
        if (r.startDate < minDate) minDate = r.startDate;
        if (r.dueDate   > maxDate) maxDate = r.dueDate;
    });
    minDate = new Date(minDate); minDate.setDate(minDate.getDate() - 1);
    maxDate = new Date(maxDate); maxDate.setDate(maxDate.getDate() + 1);
    const totalDays = _daysBetween(minDate, maxDate) + 1;
    const today = new Date();
    const todayOffset = _daysBetween(minDate, today);

    grid.style.gridTemplateColumns = `160px repeat(${totalDays}, 32px)`;

    let html = `<div class="gantt-corner" style="grid-column:1; grid-row:1;"></div>`;
    for (let i = 0; i < totalDays; i++) {
        const d = new Date(minDate); d.setDate(d.getDate() + i);
        html += `<div class="gantt-day-cell${_isSameDay(d, today) ? ' gantt-day-cell--today' : ''}" style="grid-column:${i + 2}; grid-row:1;">${d.getDate()}.${String(d.getMonth() + 1).padStart(2, '0')}</div>`;
    }
    if (todayOffset >= 0 && todayOffset < totalDays) {
        html += `<div class="gantt-today-line" style="grid-column:${todayOffset + 2}; grid-row:1 / span ${rows.length + 1};"></div>`;
    }

    rows.forEach((r, idx) => {
        const rowNum      = idx + 2;
        const startOffset = _daysBetween(minDate, r.startDate);
        const span        = Math.max(1, _daysBetween(r.startDate, r.dueDate) + 1);
        const barColor    = r.labels[0] ? r.labels[0].color : (r.importanceColor || '#4361EE');
        html += `<div class="gantt-row-bg${idx % 2 ? ' gantt-row-bg--alt' : ''}" style="grid-column:1 / span ${totalDays + 1}; grid-row:${rowNum};"></div>`;
        html += `<div class="gantt-row-label" style="grid-column:1; grid-row:${rowNum};" title="${escHtml(r.column)}">${escHtml(r.title)}</div>`;
        html += `<div class="gantt-bar${r.done ? ' gantt-bar--done' : ''}" style="grid-column:${startOffset + 2} / span ${span}; grid-row:${rowNum}; background:${barColor}" onclick="tvOpenCard('${r.cardId}')" title="${escHtml(r.title)} — ${escHtml(r.column)}"></div>`;
    });

    grid.innerHTML = html;
}


// ===== ДАШБОРД (Should №40) =====
// Снова строится из tvCollectCards() — без отдельного запроса к серверу.

const _DASH_STATUS_META = [
    { key: 'overdue', label: 'Просрочено', color: '#de350b' },
    { key: 'soon',    label: 'Скоро',      color: '#ff8b00' },
    { key: 'ontrack', label: 'В работе',   color: '#4361EE' },
    { key: 'done',    label: 'Выполнено',  color: '#00875a' },
    { key: 'nodate',  label: 'Без срока',  color: '#97a0af' },
];

function _dashDueStatus(r) {
    if (r.done) return 'done';
    const d = _dateFromRu(r.due);
    if (!d) return 'nodate';
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const diff = _daysBetween(today, d);
    if (diff < 0) return 'overdue';
    if (diff <= 1) return 'soon';
    return 'ontrack';
}

function dashRenderBars(containerId, entries, colorFn, emptyText) {
    const container = document.getElementById(containerId);
    if (!container) return;
    if (!entries.length) {
        container.innerHTML = `<div class="dash-empty">${escHtml(emptyText)}</div>`;
        return;
    }
    const maxVal = entries[0][1] || 1;
    const shown  = entries.slice(0, 8);
    let html = shown.map(([label, count]) => {
        const pct = Math.round((count / maxVal) * 100);
        return `
            <div class="dash-bar-row">
                <span class="dash-bar-label" title="${escHtml(label)}">${escHtml(label)}</span>
                <div class="dash-bar-track"><div class="dash-bar-fill" style="width:${pct}%;background:${colorFn(label)}"></div></div>
                <span class="dash-bar-value">${count}</span>
            </div>`;
    }).join('');
    if (entries.length > shown.length) {
        html += `<div class="dash-more-note">ещё ${entries.length - shown.length}</div>`;
    }
    container.innerHTML = html;
}

function dashRenderStatus(statuses) {
    const container = document.getElementById('dashByStatus');
    if (!container) return;
    const counts = {};
    _DASH_STATUS_META.forEach(s => { counts[s.key] = 0; });
    statuses.forEach(s => { counts[s] = (counts[s] || 0) + 1; });
    const maxVal = Math.max(1, ..._DASH_STATUS_META.map(s => counts[s.key]));
    container.innerHTML = _DASH_STATUS_META.map(s => {
        const count = counts[s.key];
        const pct = Math.round((count / maxVal) * 100);
        return `
            <div class="dash-bar-row">
                <span class="dash-bar-label">${s.label}</span>
                <div class="dash-bar-track"><div class="dash-bar-fill" style="width:${pct}%;background:${s.color}"></div></div>
                <span class="dash-bar-value">${count}</span>
            </div>`;
    }).join('');
}

function dashRender() {
    const rows  = tvCollectCards();
    const total = rows.length;
    const statuses    = rows.map(_dashDueStatus);
    const doneCount    = statuses.filter(s => s === 'done').length;
    const overdueCount = statuses.filter(s => s === 'overdue').length;
    const rate = total ? Math.round((doneCount / total) * 100) : 0;

    const setText = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    setText('dashKpiTotal',   total);
    setText('dashKpiOverdue', overdueCount);
    setText('dashKpiDone',    doneCount);
    setText('dashKpiRate',    `${rate}%`);

    const byMember = new Map();
    rows.forEach(r => r.members.forEach(name => byMember.set(name, (byMember.get(name) || 0) + 1)));
    dashRenderBars('dashByMember',
        [...byMember.entries()].sort((a, b) => b[1] - a[1]),
        () => '#4361EE',
        'Нет назначенных участников');

    const byLabel = new Map(); // text -> { count, color }
    rows.forEach(r => r.labels.forEach(l => {
        const cur = byLabel.get(l.text) || { count: 0, color: l.color };
        cur.count++;
        byLabel.set(l.text, cur);
    }));
    dashRenderBars('dashByLabel',
        [...byLabel.entries()].map(([text, v]) => [text, v.count]).sort((a, b) => b[1] - a[1]),
        (label) => byLabel.get(label)?.color || '#4361EE',
        'На доске нет меток');

    dashRenderStatus(statuses);
}


// ===== СВОРАЧИВАНИЕ КОЛОНОК =====

function collapsedColsStorageKey() {
    const boardId = document.getElementById('boardColumns')?.dataset.boardId;
    return `kanban_collapsed_cols_${boardId}`;
}

function saveColumnCollapseState(colId, collapsed) {
    const key = collapsedColsStorageKey();
    const ids = new Set(JSON.parse(localStorage.getItem(key) || '[]'));
    if (collapsed) ids.add(String(colId)); else ids.delete(String(colId));
    localStorage.setItem(key, JSON.stringify([...ids]));
}

window.toggleColumnCollapse = function(e, btn) {
    e.stopPropagation();
    const col = btn.closest('.column');
    if (!col) return;
    const collapsed = col.classList.toggle('column--collapsed');
    btn.textContent = collapsed ? '›' : '‹';
    btn.title = collapsed ? 'Развернуть список' : 'Свернуть список';
    saveColumnCollapseState(col.dataset.colId, collapsed);
};

document.addEventListener('DOMContentLoaded', function() {
    const key = collapsedColsStorageKey();
    const ids = new Set(JSON.parse(localStorage.getItem(key) || '[]'));
    ids.forEach(function(colId) {
        const col = document.querySelector(`.column[data-col-id="${colId}"]`);
        if (!col) return;
        col.classList.add('column--collapsed');
        const btn = col.querySelector('.column-collapse-btn');
        if (btn) { btn.textContent = '›'; btn.title = 'Развернуть список'; }
    });
});

function persistOrder() {
    const cards = [];
    document.querySelectorAll('.cards-list').forEach(list => {
        const colId = parseInt(list.dataset.colId);
        list.querySelectorAll('.card').forEach((card, pos) => {
            const id = parseInt(card.dataset.cardId);
            if (id) cards.push({ id, column_id: colId, position: pos });
        });
    });
    if (cards.length) {
        fetch('/api/cards/reorder', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cards })
        });
    }
}


// ===== INLINE ADD CARD =====

window.addCard = function(colId) {
    // Скрываем другие открытые формы
    document.querySelectorAll('.inline-add-card').forEach(f => {
        if (f.id !== 'inline-add-' + colId) inlineCardCancel(f.id.replace('inline-add-', ''));
    });

    const form = document.getElementById('inline-add-' + colId);
    const btn  = document.getElementById('btn-add-' + colId);
    if (!form) return;
    form.style.display = '';
    btn.style.display  = 'none';
    const input = document.getElementById('inline-input-' + colId);
    input.value = '';
    setTimeout(() => input.focus(), 30);
};

window.inlineCardCancel = function(colId) {
    const form = document.getElementById('inline-add-' + colId);
    const btn  = document.getElementById('btn-add-' + colId);
    if (form) form.style.display = 'none';
    if (btn)  btn.style.display  = '';
};

window.inlineCardKey = function(e, colId) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); inlineCardSave(colId); }
    if (e.key === 'Escape') inlineCardCancel(colId);
};

window.inlineCardSave = async function(colId) {
    const input = document.getElementById('inline-input-' + colId);
    const title = input?.value.trim();
    if (!title) return;

    const boardId = parseInt(document.getElementById('boardColumns').dataset.boardId);
    const res  = await fetch('/api/cards', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ column_id: parseInt(colId), title })
    });
    const card = await res.json();
    appendCardToDOM(card, colId);
    showToast('Карточка добавлена');

    // Оставляем форму открытой для быстрого добавления следующей карточки
    input.value = '';
    input.focus();
};

function appendCardToDOM(card, colId) {
    const el = document.createElement('div');
    el.className    = 'card';
    el.id           = 'card-' + card.id;
    el.draggable    = true;
    el.dataset.cardId = card.id;
    el.dataset.members = (card.members || []).map(m => `${m.user_email}::${m.user_name}`).join('|');
    el.onclick      = (e) => openCardModal(e, el);

    let html = `<button class="card-check-btn" onclick="toggleComplete(event, this)" title="Отметить выполненной">✓</button>`;
    html += `<button class="card-edit-btn" onclick="openQuickEdit(event, this)" title="Быстрое редактирование">✎</button>`;
    if (card.labels && card.labels.length) {
        html += '<div class="card-labels">' + card.labels.map(l =>
            `<span class="card-label" style="background:${l.color}20;color:${l.color};border:1px solid ${l.color}40">${escHtml(l.name)}</span>`
        ).join('') + '</div>';
    }
    html += `<p class="card-title">${escHtml(card.title)}</p>`;
    if (card.due_date) {
        html += `<div class="card-due"><span class="due-icon">${_CAL_SVG}</span> ${escHtml(card.due_date)}</div>`;
    }
    el.innerHTML = html;

    document.getElementById('cards-' + colId).appendChild(el);
    updateColumnCounts();
}



// ===== INLINE ADD COLUMN =====

window.addColumn = function() {
    document.getElementById('btnAddColumn').style.display = 'none';
    const form  = document.getElementById('inlineAddCol');
    const input = document.getElementById('inlineColInput');
    form.style.display = '';
    input.value = '';
    setTimeout(() => input.focus(), 30);
};

window.inlineColCancel = function() {
    document.getElementById('inlineAddCol').style.display  = 'none';
    document.getElementById('btnAddColumn').style.display  = '';
};

window.inlineColKey = function(e) {
    if (e.key === 'Enter') { e.preventDefault(); inlineColSave(); }
    if (e.key === 'Escape') inlineColCancel();
};

window.inlineColSave = async function() {
    const input = document.getElementById('inlineColInput');
    const name  = input?.value.trim();
    if (!name) return;

    const boardId = parseInt(document.getElementById('boardColumns').dataset.boardId);
    const res  = await fetch('/api/columns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ board_id: boardId, name })
    });
    const data = await res.json();
    const colId = data.id;

    const col = document.createElement('div');
    col.className        = 'column';
    col.id                = 'column-' + colId;
    col.dataset.colId     = colId;
    col.dataset.wipLimit  = 0;
    col.innerHTML = `
        <div class="column-header">
            <button class="column-collapse-btn" onclick="toggleColumnCollapse(event, this)" title="Свернуть список">‹</button>
            <h3 class="column-title" onclick="startRenameColumn(this)"
                title="Нажмите для переименования">${escHtml(name)}</h3>
            <span class="column-count">0</span>
            <button class="column-menu-btn" onclick="openColumnMenu(event, this)" title="Меню">⋯</button>
        </div>
        <div class="cards-list" id="cards-${colId}" data-col-id="${colId}"></div>
        <div class="inline-add-card" id="inline-add-${colId}" style="display:none">
            <textarea class="inline-card-input" id="inline-input-${colId}"
                      placeholder="Название карточки..."
                      onkeydown="inlineCardKey(event, ${colId})"></textarea>
            <div class="inline-add-actions">
                <button class="btn-primary btn-sm" onclick="inlineCardSave(${colId})">Добавить карточку</button>
                <button class="inline-cancel-btn" onclick="inlineCardCancel(${colId})">✕</button>
            </div>
        </div>
        <button class="btn-add-card" id="btn-add-${colId}" onclick="addCard(${colId})">
            <span>+</span> Добавить карточку
        </button>
    `;

    document.querySelector('.column--add').before(col);

    new Sortable(col.querySelector('.cards-list'), {
        group: 'cards',
        animation: 150,
        ghostClass: 'sortable-ghost',
        dragClass: 'sortable-drag',
        delay: 300,
        delayOnTouchOnly: true,
        touchStartThreshold: 8,
        onEnd: () => { updateColumnCounts(); persistOrder(); }
    });

    inlineColCancel();
    showToast('Список создан');
};


// ===== CARD DETAIL MODAL =====

let currentCardId   = null;  // "card-5" — DOM id
let currentCardDbId = null;  // 5 — DB id
let isDragging      = false;

document.addEventListener('dragstart', () => { isDragging = true; });
document.addEventListener('dragend',   () => { setTimeout(() => { isDragging = false; }, 100); });

// ── Touch scroll guard ──
let _touchStartY = 0;
let _touchMoved  = false;
document.addEventListener('touchstart', function(e) {
    _touchStartY = e.touches[0].clientY;
    _touchMoved  = false;
}, { passive: true });
document.addEventListener('touchmove', function(e) {
    if (Math.abs(e.touches[0].clientY - _touchStartY) > 8) _touchMoved = true;
}, { passive: true });

window.openCardModal = function(e, cardEl) {
    if (isDragging) return;
    if (_touchMoved) { _touchMoved = false; return; }

    const dbId = parseInt(cardEl.dataset.cardId);
    if (!dbId) return;

    currentCardId   = cardEl.id;
    currentCardDbId = dbId;

    const boardId = document.getElementById('boardColumns')?.dataset.boardId;
    if (boardId) history.replaceState(null, '', `/board/${boardId}?card=${dbId}`);

    // Populate from DOM (instant — без задержки)
    const titleEl      = cardEl.querySelector('.card-title');
    const labelEls     = cardEl.querySelectorAll('.card-label');
    const importanceEl = cardEl.querySelector('.card-importance');
    const dueEl        = cardEl.querySelector('.card-due');

    document.getElementById('cmTitle').textContent = titleEl ? titleEl.textContent : '';

    const col      = cardEl.closest('.column');
    document.getElementById('cmColName').textContent = col ? col.querySelector('.column-title').textContent : '';

    const meta = document.getElementById('cmMeta');
    meta.innerHTML = '';
    labelEls.forEach(labelEl => {
        const b = document.createElement('span');
        b.className = 'card-label';
        b.style.cssText = labelEl.style.cssText;
        b.textContent   = labelEl.textContent.trim();
        meta.appendChild(b);
    });
    if (importanceEl) {
        const b = document.createElement('span');
        b.className = 'card-importance';
        b.style.cssText = importanceEl.style.cssText;
        b.textContent   = importanceEl.textContent.trim();
        meta.appendChild(b);
    }
    if (dueEl) {
        const d = document.createElement('span');
        d.className   = 'cm-due-badge';
        d.textContent = dueEl.textContent;
        meta.appendChild(d);
    }

    // Reset
    document.getElementById('cmDescription').value          = '';
    document.getElementById('cmDescription').style.display  = 'none';
    document.getElementById('cmDescriptionView').style.display = 'block';
    renderDescriptionView('');
    document.getElementById('cmCommentInput').value         = '';
    document.getElementById('cmCommentActions').style.display = 'none';
    document.getElementById('cmUserAvatar').textContent     = document.querySelector('.user-avatar')?.textContent || 'R';

    renderAttachments([]);
    renderLinks([]);
    renderComments([]);
    renderActivity([]);
    renderChecklists([]);
    renderCustomFields([]);
    updateCardMembersMeta([]);
    document.getElementById('cmCommentsEmpty').style.display = 'block';

    closePopover();
    currentBoardId = document.getElementById('boardColumns')?.dataset.boardId || null;
    hideMentionSuggestions();
    document.getElementById('cardDetailModal').style.display = 'flex';
    document.body.style.overflow = 'hidden';

    // Загружаем описание + комментарии из API
    loadCardData(dbId);
};

async function loadCardData(dbId) {
    try {
        const res  = await fetch(`/api/cards/${dbId}`);
        const data = await res.json();
        if (currentCardDbId !== dbId) return;

        document.getElementById('cmDescription').value = data.description || '';
        renderDescriptionView(data.description || '');
        renderComments(data.comments || []);
        renderActivity(data.activity || []);
        renderAttachments(data.attachments || []);
        renderLinks(data.links || []);
        renderCardRelations(data.relations || []);
        renderChecklists(data.checklists || []);
        renderCustomFields(data.custom_fields || []);
        // Показываем cover в modal-header если есть
        const coverColor = data.cover_color || '';
        const modalEl    = document.querySelector('.card-modal');
        if (modalEl) modalEl.style.setProperty('--card-cover', coverColor ? coverColor : 'transparent');

        // Участники карточки
        updateCardMembersMeta(data.members || []);

        // Метки
        updateModalLabels(data.labels || []);

        // Важность
        updateModalImportance({ name: data.importance || '', color: data.importance_color || '' });

        // Дата начала
        updateModalStart(data.start_date || '');

        // Связанная доска
        updateBoardLinkMeta(
            data.linked_board_id   || null,
            data.linked_board_name  || null,
            data.linked_board_color || null
        );
        if (data.linked_board_id) {
            const cardEl = document.getElementById(currentCardId);
            if (cardEl) cardEl.dataset.linkedBoardId = data.linked_board_id;
        }
    } catch (err) {
        console.error('Ошибка загрузки карточки', err);
    }
}

// --- Кастомные поля ---
function renderCustomFields(list) {
    const section   = document.getElementById('cmCustomFieldsSection');
    const container = document.getElementById('cmCustomFields');
    if (!section || !container) return;
    container.innerHTML = '';
    if (!list || !list.length) { section.style.display = 'none'; return; }
    section.style.display = '';

    list.forEach(f => {
        const row = document.createElement('div');
        row.className = 'cm-cf-row';

        const label = document.createElement('label');
        label.className   = 'cm-cf-label';
        label.textContent = f.name;
        row.appendChild(label);

        let input;
        if (f.type === 'checkbox') {
            input = document.createElement('input');
            input.type = 'checkbox';
            input.className = 'cm-cf-checkbox';
            input.checked = f.value === '1';
            input.onchange = () => saveCustomFieldValue(f, input.checked ? '1' : '');
        } else if (f.type === 'list') {
            input = document.createElement('select');
            input.className = 'cm-cf-select';
            const empty = document.createElement('option');
            empty.value = ''; empty.textContent = '—';
            input.appendChild(empty);
            let options = [];
            try { options = JSON.parse(f.options || '[]'); } catch (e) { options = []; }
            options.forEach(opt => {
                const o = document.createElement('option');
                o.value = opt; o.textContent = opt;
                if (f.value === opt) o.selected = true;
                input.appendChild(o);
            });
            input.onchange = () => saveCustomFieldValue(f, input.value);
        } else {
            input = document.createElement('input');
            input.type = f.type === 'number' ? 'number' : (f.type === 'date' ? 'date' : 'text');
            input.className = 'cm-cf-input';
            input.value = f.value || '';
            input.onblur = () => saveCustomFieldValue(f, input.value);
            input.onkeydown = (e) => { if (e.key === 'Enter') input.blur(); };
        }
        row.appendChild(input);
        container.appendChild(row);
    });
}

async function saveCustomFieldValue(field, value) {
    if (!currentCardDbId) return;
    await fetch(`/api/cards/${currentCardDbId}/custom-fields/${field.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value })
    });
    if (currentCardId) updateCardCfChip(currentCardId, field, value);
}

function updateCardCfChip(cardDomId, field, value) {
    const cardEl = document.getElementById(cardDomId);
    if (!cardEl || !field.show_on_card) return;
    let wrap = cardEl.querySelector('.card-cf-chips');
    let chip = wrap ? wrap.querySelector(`[data-cf-field-id="${field.id}"]`) : null;
    if (!value) {
        chip?.remove();
        if (wrap && !wrap.children.length) wrap.remove();
        return;
    }
    if (!wrap) {
        wrap = document.createElement('div');
        wrap.className = 'card-cf-chips';
        cardEl.insertBefore(wrap, cardEl.querySelector('.card-title'));
    }
    if (!chip) {
        chip = document.createElement('span');
        chip.className = 'card-cf-chip';
        chip.dataset.cfFieldId = field.id;
        wrap.appendChild(chip);
    }
    chip.dataset.cfName  = field.name;
    chip.dataset.cfValue = value;
    chip.textContent = field.type === 'checkbox' ? `✓ ${field.name}` : `${field.name}: ${value}`;
}

// --- Описание (Markdown) ---
function renderDescriptionView(text) {
    const view = document.getElementById('cmDescriptionView');
    if (!text || !text.trim()) {
        view.innerHTML = '<span class="cm-description-empty">Добавьте подробное описание задачи...</span>';
        return;
    }
    view.innerHTML = DOMPurify.sanitize(marked.parse(text, { breaks: true }));
}

window.editDescription = function() {
    document.getElementById('cmDescriptionView').style.display = 'none';
    document.getElementById('cmDescToolbar').style.display = 'flex';
    const ta = document.getElementById('cmDescription');
    ta.style.display = 'block';
    ta.focus();
};

window.finishDescriptionEdit = function() {
    const ta = document.getElementById('cmDescription');
    renderDescriptionView(ta.value);
    ta.style.display = 'none';
    document.getElementById('cmDescToolbar').style.display = 'none';
    document.getElementById('cmDescriptionView').style.display = 'block';
};


// --- Панель форматирования Markdown (кнопки, как в Trello) ---

function _mdTextareaSelection(textarea) {
    return { start: textarea.selectionStart ?? 0, end: textarea.selectionEnd ?? 0 };
}

function _mdWrapSelection(textarea, before, after, placeholder) {
    const { start, end } = _mdTextareaSelection(textarea);
    const value = textarea.value;
    const selected = value.slice(start, end) || placeholder || '';
    textarea.value = value.slice(0, start) + before + selected + after + value.slice(end);
    const selStart = start + before.length;
    textarea.focus();
    textarea.setSelectionRange(selStart, selStart + selected.length);
}

function _mdLineBlockRange(textarea) {
    const { start, end } = _mdTextareaSelection(textarea);
    const value = textarea.value;
    const lineStart = value.lastIndexOf('\n', start - 1) + 1;
    let lineEnd = value.indexOf('\n', end);
    if (lineEnd === -1) lineEnd = value.length;
    return { lineStart, lineEnd, value };
}

function _mdPrefixLines(textarea, prefixFn) {
    const { lineStart, lineEnd, value } = _mdLineBlockRange(textarea);
    const block = value.slice(lineStart, lineEnd);
    const lines = block.split('\n').map((line, i) => prefixFn(line, i)).join('\n');
    textarea.value = value.slice(0, lineStart) + lines + value.slice(lineEnd);
    textarea.focus();
    textarea.setSelectionRange(lineStart, lineStart + lines.length);
}

window.formatText = function(btn, action) {
    const toolbar = btn.closest('.md-toolbar');
    const targetId = toolbar?.dataset.target;
    const textarea = targetId && document.getElementById(targetId);
    if (!textarea) return;

    switch (action) {
        case 'bold':   _mdWrapSelection(textarea, '**', '**', 'текст'); break;
        case 'italic': _mdWrapSelection(textarea, '*', '*', 'текст'); break;
        case 'strike': _mdWrapSelection(textarea, '~~', '~~', 'текст'); break;
        case 'code':   _mdWrapSelection(textarea, '`', '`', 'код'); break;
        case 'link': {
            const url = prompt('Ссылка (URL):', 'https://');
            if (!url) return;
            _mdWrapSelection(textarea, '[', `](${url})`, 'текст ссылки');
            break;
        }
        case 'heading': _mdPrefixLines(textarea, line => line.startsWith('### ') ? line : `### ${line}`); break;
        case 'quote':   _mdPrefixLines(textarea, line => line.startsWith('> ')   ? line : `> ${line}`);   break;
        case 'ul':      _mdPrefixLines(textarea, line => line.startsWith('- ')   ? line : `- ${line}`);   break;
        case 'ol':      _mdPrefixLines(textarea, (line, i) => `${i + 1}. ${line.replace(/^\d+\.\s*/, '')}`); break;
        default: return;
    }

    // textarea без view/edit-переключения (composer комментария) — событие input
    // нужно, чтобы сработали уже висящие обработчики (например, показ кнопок отправки)
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
};

window.closeCardModal = async function() {
    if (!currentCardId || !currentCardDbId) return;

    const newTitle = document.getElementById('cmTitle').textContent.trim();
    const newDesc  = document.getElementById('cmDescription').value;

    // Сохраняем в DOM
    const cardEl = document.getElementById(currentCardId);
    if (cardEl && newTitle) {
        const t = cardEl.querySelector('.card-title');
        if (t) t.textContent = newTitle;
    }

    // Сохраняем в БД
    fetch(`/api/cards/${currentCardDbId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: newTitle, description: newDesc })
    });

    document.getElementById('cardDetailModal').style.display = 'none';
    document.body.style.overflow = '';
    currentCardId   = null;
    currentCardDbId = null;
    currentBoardId  = null;
    hideMentionSuggestions();

    const boardId = document.getElementById('boardColumns')?.dataset.boardId;
    if (boardId) history.replaceState(null, '', `/board/${boardId}`);
};

window.copyCardLink = async function() {
    if (!currentCardDbId) return;
    const link = `${location.origin}/card/${currentCardDbId}`;
    await _copyToClipboard(link, 'Ссылка на карточку скопирована');
};

window.handleModalOverlayClick = e => {
    if (e.target === document.getElementById('cardDetailModal')) closeCardModal();
};

document.addEventListener('keydown', e => { if (e.key === 'Escape') closeCardModal(); });


// ===== ATTACHMENTS =====

const FILE_CFG = {
    image:   { icon: '🖼', color: '#0052cc', bg: '#e3f0ff' },
    pdf:     { icon: '📄', color: '#de350b', bg: '#ffebe6' },
    excel:   { icon: '📊', color: '#00875a', bg: '#e3fcef' },
    word:    { icon: '📝', color: '#0052cc', bg: '#e3f0ff' },
    ppt:     { icon: '📊', color: '#ff8b00', bg: '#fff7e6' },
    archive: { icon: '🗜', color: '#6b778c', bg: '#f4f5f7' },
    file:    { icon: '📁', color: '#6b778c', bg: '#f4f5f7' }
};

function getFileType(name) {
    const ext = name.split('.').pop().toLowerCase();
    if (['jpg','jpeg','png','gif','webp','svg'].includes(ext)) return 'image';
    if (ext === 'pdf')                                          return 'pdf';
    if (['xlsx','xls','csv'].includes(ext))                    return 'excel';
    if (['docx','doc'].includes(ext))                          return 'word';
    if (['pptx','ppt'].includes(ext))                          return 'ppt';
    if (['zip','rar','7z'].includes(ext))                      return 'archive';
    return 'file';
}

window.handleAttach = async function(input) {
    if (!currentCardDbId || !input.files.length) return;
    for (const file of Array.from(input.files)) {
        const fd = new FormData();
        fd.append('file', file);
        try {
            const res = await fetch(`/api/cards/${currentCardDbId}/attachments`, {
                method: 'POST',
                body: fd
            });
            if (res.ok) {
                appendAttachmentToDOM(await res.json());
            } else {
                const data = await res.json().catch(() => null);
                showToast(data?.message || `Не удалось загрузить файл «${file.name}»`, 'error');
            }
        } catch (err) {
            console.error('Ошибка загрузки файла', err);
            showToast(`Не удалось загрузить файл «${file.name}»`, 'error');
        }
    }
    input.value = '';
};

function renderAttachments(list) {
    const container = document.getElementById('cmAttachments');
    const empty     = document.getElementById('cmAttachEmpty');
    container.querySelectorAll('.cm-attach-item').forEach(el => el.remove());
    if (!list || !list.length) { empty.style.display = 'block'; return; }
    empty.style.display = 'none';
    list.forEach(appendAttachmentToDOM);
}

function appendAttachmentToDOM(att) {
    const container = document.getElementById('cmAttachments');
    document.getElementById('cmAttachEmpty').style.display = 'none';

    const ftype      = getFileType(att.filename);
    const cfg        = FILE_CFG[ftype] || FILE_CFG.file;
    const date       = att.uploaded_at ? att.uploaded_at.slice(0, 10).split('-').reverse().join('.') : '';
    const dlUrl      = `/api/attachments/${att.id}`;
    const inlineUrl  = `${dlUrl}?inline=1`;

    const thumb = (ftype === 'image')
        ? `<a href="${inlineUrl}" target="_blank" class="cm-attach-thumb-link">
               <img src="${inlineUrl}" class="cm-attach-thumb" alt="${escHtml(att.filename)}">
           </a>`
        : `<div class="cm-attach-icon" style="background:${cfg.bg};color:${cfg.color}">${cfg.icon}</div>`;

    const item = document.createElement('div');
    item.className        = 'cm-attach-item';
    item.dataset.attachId = att.id;
    item.innerHTML = `
        ${thumb}
        <div class="cm-attach-info">
            <a href="${dlUrl}" target="_blank" class="cm-attach-link">${escHtml(att.filename)}</a>
            <p class="cm-attach-meta">${escHtml(att.filesize)} · ${escHtml(date)}</p>
        </div>
        <button class="cm-attach-del" onclick="deleteAttachment(${att.id})" title="Удалить">✕</button>
    `;
    container.appendChild(item);
}

window.deleteAttachment = async function(id) {
    if (!confirm('Удалить вложение?')) return;
    const res = await fetch(`/api/attachments/${id}`, { method: 'DELETE' });
    if (res.ok) {
        document.querySelector(`[data-attach-id="${id}"]`)?.remove();
        if (!document.querySelector('.cm-attach-item')) {
            document.getElementById('cmAttachEmpty').style.display = 'block';
        }
    }
};


// ===== CARD LINKS =====

function renderLinks(list) {
    const container = document.getElementById('cmLinks');
    const empty      = document.getElementById('cmLinksEmpty');
    container.querySelectorAll('.cm-link-item').forEach(el => el.remove());
    if (!list || !list.length) { empty.style.display = 'block'; return; }
    empty.style.display = 'none';
    list.forEach(appendLinkToDOM);
}

function appendLinkToDOM(link) {
    const container = document.getElementById('cmLinks');
    document.getElementById('cmLinksEmpty').style.display = 'none';

    const item = document.createElement('div');
    item.className      = 'cm-link-item';
    item.dataset.linkId = link.id;
    item.innerHTML = `
        <span class="cm-link-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg></span>
        <div class="cm-link-info">
            <a href="${escHtml(link.url)}" target="_blank" rel="noopener" class="cm-link-anchor">${escHtml(link.title || link.url)}</a>
            ${link.title ? `<p class="cm-link-meta">${escHtml(link.url)}</p>` : ''}
        </div>
        <button class="cm-attach-del" onclick="deleteCardLink(${link.id})" title="Удалить">✕</button>
    `;
    container.appendChild(item);
}

window.showAddLinkForm = function() {
    document.getElementById('cmLinkForm').style.display = 'block';
    document.getElementById('cmLinkUrlInput')?.focus();
};

window.hideAddLinkForm = function() {
    document.getElementById('cmLinkForm').style.display = 'none';
    document.getElementById('cmLinkUrlInput').value   = '';
    document.getElementById('cmLinkTitleInput').value = '';
};

window.addCardLink = async function() {
    const urlInput   = document.getElementById('cmLinkUrlInput');
    const titleInput = document.getElementById('cmLinkTitleInput');
    const url   = urlInput?.value.trim();
    const title = titleInput?.value.trim();
    if (!url || !currentCardDbId) return;
    const res = await fetch(`/api/cards/${currentCardDbId}/links`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, title })
    });
    if (res.ok) {
        appendLinkToDOM(await res.json());
        hideAddLinkForm();
    }
};

window.deleteCardLink = async function(id) {
    if (!confirm('Удалить ссылку?')) return;
    const res = await fetch(`/api/cards/${currentCardDbId}/links/${id}`, { method: 'DELETE' });
    if (res.ok) {
        document.querySelector(`[data-link-id="${id}"]`)?.remove();
        if (!document.querySelector('.cm-link-item')) {
            document.getElementById('cmLinksEmpty').style.display = 'block';
        }
    }
};


// ===== СВЯЗАННЫЕ КАРТОЧКИ (двусторонняя связь карточка↔карточка, Should №31) =====

function renderCardRelations(list) {
    const container = document.getElementById('cmRelations');
    const empty      = document.getElementById('cmRelationsEmpty');
    if (!container || !empty) return;
    container.querySelectorAll('.cm-relation-item').forEach(el => el.remove());
    if (!list || !list.length) { empty.style.display = 'block'; return; }
    empty.style.display = 'none';
    list.forEach(appendRelationToDOM);
}

function appendRelationToDOM(rel) {
    const container = document.getElementById('cmRelations');
    document.getElementById('cmRelationsEmpty').style.display = 'none';

    const item = document.createElement('div');
    item.className = 'cm-relation-item' + (rel.completed ? ' cm-relation-item--done' : '');
    item.dataset.relationCardId = rel.id;
    item.innerHTML = `
        <span class="cm-relation-dot" style="background:${escHtml(rel.board_color || '#4361EE')}"></span>
        <a href="/card/${rel.id}" class="cm-relation-info">
            <span class="cm-relation-title">${escHtml(rel.title)}</span>
            <span class="cm-relation-meta">${escHtml(rel.board_name)} · ${escHtml(rel.column_name)}</span>
        </a>
        <button class="cm-attach-del" onclick="removeCardRelation(${rel.id})" title="Убрать связь">✕</button>
    `;
    container.appendChild(item);
}

window.showAddRelationForm = function() {
    document.getElementById('cmRelationForm').style.display = 'block';
    document.getElementById('cmRelationResults').innerHTML = '';
    document.getElementById('cmRelationSearchInput').value = '';
    document.getElementById('cmRelationSearchInput')?.focus();
};

window.hideAddRelationForm = function() {
    document.getElementById('cmRelationForm').style.display = 'none';
};

let _relationSearchTimer = null;

window.searchRelationCandidates = function(q) {
    clearTimeout(_relationSearchTimer);
    const results = document.getElementById('cmRelationResults');
    q = q.trim();
    if (q.length < 2) { results.innerHTML = ''; return; }
    _relationSearchTimer = setTimeout(async () => {
        let cards = [];
        try {
            const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
            if (res.ok) cards = await res.json();
        } catch (err) { console.error('searchRelationCandidates error:', err); }

        cards = cards.filter(c => c.id !== currentCardDbId);
        if (!cards.length) {
            results.innerHTML = '<p class="bl-empty">Ничего не найдено</p>';
            return;
        }
        results.innerHTML = cards.map(c => `
            <button class="cm-relation-candidate" onclick="addCardRelation(${c.id})">
                <span class="cm-relation-title">${escHtml(c.title)}</span>
                <span class="cm-relation-meta">${escHtml(c.board_name)} · ${escHtml(c.column_name)}</span>
            </button>
        `).join('');
    }, 250);
};

window.addCardRelation = async function(otherCardId) {
    if (!currentCardDbId) return;
    const res = await fetch(`/api/cards/${currentCardDbId}/relations`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ other_card_id: otherCardId })
    });
    if (!res.ok) { showToast('Не удалось добавить связь', 'error'); return; }
    hideAddRelationForm();
    const listRes = await fetch(`/api/cards/${currentCardDbId}/relations`);
    if (listRes.ok) renderCardRelations(await listRes.json());
};

window.removeCardRelation = async function(otherCardId) {
    if (!currentCardDbId) return;
    await fetch(`/api/cards/${currentCardDbId}/relations/${otherCardId}`, { method: 'DELETE' });
    document.querySelector(`[data-relation-card-id="${otherCardId}"]`)?.remove();
    if (!document.querySelector('.cm-relation-item')) {
        document.getElementById('cmRelationsEmpty').style.display = 'block';
    }
};


// ===== COMMENTS =====

let mentionCandidates = [];
let mentionBoardId = null;
let mentionSuggestions = [];
let mentionActiveIndex = 0;
let currentBoardId = null;

function hideMentionSuggestions() {
    const panel = document.getElementById('cmMentionSuggestions');
    if (panel) {
        panel.innerHTML = '';
        panel.style.display = 'none';
    }
    mentionSuggestions = [];
    mentionActiveIndex = 0;
}

function getMentionAlias(user) {
    const emailLocal = String(user?.email || '').split('@')[0].trim();
    if (emailLocal) return emailLocal;
    return String(user?.name || 'user')
        .replace(/\s+/g, '_')
        .replace(/[^A-Za-z0-9._-]/g, '')
        .toLowerCase() || 'user';
}

function getMentionContext() {
    const input = document.getElementById('cmCommentInput');
    if (!input) return null;
    const text = input.value || '';
    const cursor = input.selectionStart ?? text.length;
    const beforeCursor = text.slice(0, cursor);
    const atIndex = beforeCursor.lastIndexOf('@');
    if (atIndex < 0) return null;
    const prefix = beforeCursor.slice(0, atIndex);
    if (prefix.length && !/\s$/.test(prefix)) return null;
    const query = beforeCursor.slice(atIndex + 1);
    return { start: atIndex, end: cursor, query };
}

function filterMentionCandidates(query = '') {
    const term = String(query || '').trim().toLowerCase();
    if (!mentionCandidates.length) return [];
    if (!term) return mentionCandidates;
    return mentionCandidates.filter(user => {
        const name = String(user?.name || '').toLowerCase();
        const email = String(user?.email || '').toLowerCase();
        const alias = getMentionAlias(user).toLowerCase();
        return name.includes(term) || email.includes(term) || alias.includes(term);
    });
}

function renderMentionSuggestions(list = []) {
    const panel = document.getElementById('cmMentionSuggestions');
    if (!panel) return;
    if (!list.length) {
        panel.innerHTML = '';
        panel.style.display = 'none';
        mentionSuggestions = [];
        mentionActiveIndex = 0;
        return;
    }
    mentionSuggestions = list;
    mentionActiveIndex = 0;
    panel.innerHTML = list.map((user, index) => {
        const name = String(user?.name || user?.email || 'Пользователь');
        const email = String(user?.email || '');
        const alias = getMentionAlias(user);
        return `
            <button type="button" class="cm-mention-item${index === 0 ? ' is-active' : ''}" data-index="${index}" onclick="selectMentionSuggestion(${index})">
                <span class="cm-mention-name">${escHtml(name)}</span>
                <span class="cm-mention-meta">${escHtml(alias)}${email ? ` · ${escHtml(email)}` : ''}</span>
            </button>
        `;
    }).join('');
    panel.style.display = 'block';
}

async function loadMentionCandidates(query = '') {
    if (!currentBoardId) {
        hideMentionSuggestions();
        return;
    }
    if (mentionBoardId === currentBoardId && mentionCandidates.length) {
        renderMentionSuggestions(filterMentionCandidates(query));
        return;
    }
    try {
        const res = await fetch(`/api/boards/${currentBoardId}/members`);
        if (!res.ok) throw new Error('failed');
        const members = await res.json();
        mentionCandidates = Array.isArray(members) ? members : [];
        mentionBoardId = currentBoardId;
        renderMentionSuggestions(filterMentionCandidates(query));
    } catch (err) {
        console.error('Ошибка загрузки кандидатов для @упоминаний', err);
        hideMentionSuggestions();
    }
}

function updateMentionSuggestions() {
    const context = getMentionContext();
    if (!context) {
        hideMentionSuggestions();
        return;
    }
    if (!currentBoardId) {
        hideMentionSuggestions();
        return;
    }
    loadMentionCandidates(context.query);
}

window.selectMentionSuggestion = function(index) {
    const input = document.getElementById('cmCommentInput');
    const item = mentionSuggestions[index];
    if (!input || !item) return;
    const context = getMentionContext();
    if (!context) return;
    const alias = getMentionAlias(item);
    const replacement = `@${alias}`;
    const text = input.value || '';
    const before = text.slice(0, context.start);
    const after = text.slice(context.end);
    input.value = `${before}${replacement}${after}`;
    const cursorPos = before.length + replacement.length;
    input.focus();
    input.setSelectionRange(cursorPos, cursorPos);
    hideMentionSuggestions();
    showCommentActions();
};

window.showCommentActions = () => {
    document.getElementById('cmCommentActions').style.display = 'flex';
    document.getElementById('cmCommentToolbar').style.display = 'flex';
};

window.cancelComment = () => {
    const input = document.getElementById('cmCommentInput');
    input.value = '';
    document.getElementById('cmCommentActions').style.display = 'none';
    document.getElementById('cmCommentToolbar').style.display = 'none';
    hideMentionSuggestions();
    input.blur();
};

window.submitComment = async function() {
    const input = document.getElementById('cmCommentInput');
    const text = input.value.trim();
    if (!text || !currentCardDbId) return;

    const btn = document.querySelector('#cmCommentActions .btn-primary');
    btn.disabled = true;

    try {
        const res     = await fetch(`/api/cards/${currentCardDbId}/comments`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text })
        });
        const comment = await res.json();
        appendCommentToDOM(comment);
        cancelComment();
        hideMentionSuggestions();
    } finally {
        btn.disabled = false;
    }
};

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function _highlightMentionsInNode(root, pattern) {
    // Проходим только по текстовым узлам уже готового (санитизированного) HTML —
    // не трогаем содержимое <code>/<pre>/<a>, чтобы разметка @упоминаний не
    // ломала код-спаны и ссылки.
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    const textNodes = [];
    let node;
    while ((node = walker.nextNode())) {
        const tag = node.parentElement?.tagName;
        if (tag === 'CODE' || tag === 'PRE' || tag === 'A') continue;
        pattern.lastIndex = 0;
        if (pattern.test(node.textContent)) textNodes.push(node);
    }
    textNodes.forEach(textNode => {
        const text = textNode.textContent;
        const frag = document.createDocumentFragment();
        let lastIndex = 0, match;
        pattern.lastIndex = 0;
        while ((match = pattern.exec(text))) {
            if (match.index > lastIndex) frag.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
            const span = document.createElement('span');
            span.className = 'comment-mention';
            span.textContent = match[0];
            frag.appendChild(span);
            lastIndex = match.index + match[0].length;
            if (match[0].length === 0) pattern.lastIndex++; // защита от зацикливания
        }
        if (lastIndex < text.length) frag.appendChild(document.createTextNode(text.slice(lastIndex)));
        textNode.parentNode.replaceChild(frag, textNode);
    });
}

function formatCommentText(text, mentions = []) {
    const html = DOMPurify.sanitize(marked.parse(text || '', { breaks: true }));
    const tokens = [...new Set((mentions || [])
        .map(m => String(m.mention || '').trim())
        .filter(Boolean))];

    const container = document.createElement('div');
    container.innerHTML = html;
    if (tokens.length) {
        const pattern = new RegExp(`@(?:${tokens.map(escapeRegExp).join('|')})`, 'gi');
        _highlightMentionsInNode(container, pattern);
    }
    return container.innerHTML;
}

function renderComments(list) {
    const container = document.getElementById('cmCommentsList');
    const empty     = document.getElementById('cmCommentsEmpty');
    container.querySelectorAll('.cm-comment-item').forEach(el => el.remove());

    if (!list || !list.length) { empty.style.display = 'block'; return; }
    empty.style.display = 'none';
    list.forEach(appendCommentToDOM);
}

function appendCommentToDOM(c) {
    const empty = document.getElementById('cmCommentsEmpty');
    empty.style.display = 'none';

    const item = document.createElement('div');
    item.className       = 'cm-comment-item';
    item.dataset.commentId = c.id;

    const avatar = (c.author || 'П')[0].toUpperCase();
    const time   = c.created_at
        ? c.created_at.replace('T', ' ').slice(0, 16)
        : new Date().toLocaleString('ru-RU');

    item.innerHTML = `
        <div class="cm-comment-avatar">${escHtml(avatar)}</div>
        <div class="cm-comment-body">
            <div class="cm-comment-header">
                <span class="cm-comment-author">${escHtml(c.author || 'Пользователь')}</span>
                <span class="cm-comment-time">${escHtml(time)}</span>
                <button class="cm-comment-del" onclick="deleteComment(${c.id})" title="Удалить">✕</button>
            </div>
            <div class="cm-comment-text">${formatCommentText(c.text, c.mentions || [])}</div>
        </div>
    `;
    document.getElementById('cmCommentsList').prepend(item);
}

const ACTIVITY_LABELS = {
    created:                  () => 'создал(а) карточку',
    renamed:                  (d) => `переименовал(а) карточку: ${d}`,
    description_changed:      () => 'изменил(а) описание',
    due_date_changed:         (d) => `установил(а) срок: ${d}`,
    due_date_removed:         () => 'убрал(а) срок',
    start_date_changed:       (d) => `установил(а) дату начала: ${d}`,
    start_date_removed:       () => 'убрал(а) дату начала',
    completed:                () => 'отметил(а) карточку как выполненную',
    reopened:                 () => 'снял(а) отметку о выполнении',
    archived:                 () => 'отправил(а) карточку в архив',
    restored:                 () => 'восстановил(а) карточку из архива',
    moved_column:             (d) => `переместил(а) карточку: ${d}`,
    label_added:              (d) => `добавил(а) метку «${d}»`,
    label_removed:            (d) => `убрал(а) метку «${d}»`,
    importance_set:           (d) => `установил(а) важность: «${d}»`,
    importance_cleared:       (d) => `снял(а) важность «${d}»`,
    member_added:             (d) => `добавил(а) участника: ${d}`,
    member_removed:           (d) => `убрал(а) участника: ${d}`,
    checklist_item_checked:   (d) => `отметил(а) пункт чек-листа: «${d}»`,
    checklist_item_unchecked: (d) => `снял(а) отметку с пункта чек-листа: «${d}»`,
    checklist_copied:         (d) => `скопировал(а) чек-лист «${d}» с другой карточки`,
    relation_added:           (d) => `связал(а) с карточкой «${d}»`,
    relation_removed:         (d) => `убрал(а) связь с карточкой «${d}»`,
    mirror_added:             () => `создал(а) зеркало карточки в другой колонке`,
    attachment_added:         (d) => `добавил(а) вложение: ${d}`,
    attachment_removed:       (d) => `удалил(а) вложение: ${d}`,
    link_added:               (d) => `добавил(а) ссылку: ${d}`,
    link_removed:             (d) => `удалил(а) ссылку: ${d}`,
    custom_field_changed:     (d) => `изменил(а) поле: ${d}`,
};

function renderActivity(list) {
    const container = document.getElementById('cmActivityList');
    const empty     = document.getElementById('cmActivityEmpty');
    container.querySelectorAll('.cm-activity-item').forEach(el => el.remove());

    if (!list || !list.length) { empty.style.display = 'block'; return; }
    empty.style.display = 'none';

    list.forEach(a => {
        const describe = ACTIVITY_LABELS[a.event_type];
        if (!describe) return;
        const actor = a.actor_name || 'Пользователь';
        const time  = a.created_at ? a.created_at.replace('T', ' ').slice(0, 16) : '';

        const item = document.createElement('div');
        item.className = 'cm-activity-item';
        item.innerHTML = `
            <span class="cm-activity-dot"></span>
            <div class="cm-activity-body">
                <div class="cm-activity-text"><b>${escHtml(actor)}</b> ${escHtml(describe(a.detail || ''))}</div>
                <span class="cm-activity-time">${escHtml(time)}</span>
            </div>
        `;
        container.appendChild(item);
    });
}

window.deleteComment = async function(id) {
    await fetch(`/api/comments/${id}`, { method: 'DELETE' });
    const item = document.querySelector(`[data-comment-id="${id}"]`);
    if (item) item.remove();
    if (!document.querySelector('.cm-comment-item')) {
        document.getElementById('cmCommentsEmpty').style.display = 'block';
    }
};

window.deleteCurrentCard = function() {
    if (!currentCardDbId) return;
    const cardId  = currentCardDbId;
    const cardEl  = document.getElementById(currentCardId);
    const parent  = cardEl?.parentNode;
    const nextSib = cardEl?.nextSibling;
    if (cardEl) cardEl.remove();
    closeCardModal();
    updateColumnCounts();
    showUndoToast('Карточка перемещена в архив',
        function() { fetch('/api/cards/' + cardId, { method: 'DELETE' }); },
        function() { if (parent) parent.insertBefore(cardEl, nextSib); updateColumnCounts(); }
    );
};

// Ctrl+Enter → отправить комментарий
document.getElementById('cmCommentInput').addEventListener('input', updateMentionSuggestions);
document.getElementById('cmCommentInput').addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' && mentionSuggestions.length) {
        e.preventDefault();
        mentionActiveIndex = (mentionActiveIndex + 1) % mentionSuggestions.length;
        const panel = document.getElementById('cmMentionSuggestions');
        if (panel) {
            panel.querySelectorAll('.cm-mention-item').forEach((el, idx) => {
                el.classList.toggle('is-active', idx === mentionActiveIndex);
            });
        }
        return;
    }
    if (e.key === 'ArrowUp' && mentionSuggestions.length) {
        e.preventDefault();
        mentionActiveIndex = (mentionActiveIndex - 1 + mentionSuggestions.length) % mentionSuggestions.length;
        const panel = document.getElementById('cmMentionSuggestions');
        if (panel) {
            panel.querySelectorAll('.cm-mention-item').forEach((el, idx) => {
                el.classList.toggle('is-active', idx === mentionActiveIndex);
            });
        }
        return;
    }
    if (e.key === 'Enter' && mentionSuggestions.length) {
        e.preventDefault();
        selectMentionSuggestion(mentionActiveIndex);
        return;
    }
    if (e.key === 'Escape' && mentionSuggestions.length) {
        e.preventDefault();
        hideMentionSuggestions();
        return;
    }
    if (e.key === 'Enter' && e.ctrlKey) submitComment();
});

// ===== SIDEBAR POPOVER =====

function openPopover(title, bodyHtml) {
    document.getElementById('cmSidebarDefault').style.display = 'none';
    document.getElementById('cspTitle').textContent = title;
    document.getElementById('cspBody').innerHTML = bodyHtml;
    document.getElementById('cmSidebarPopover').style.display = 'block';
}

window.closePopover = function() {
    const def = document.getElementById('cmSidebarDefault');
    const pop = document.getElementById('cmSidebarPopover');
    if (def) def.style.display = 'block';
    if (pop) pop.style.display = 'none';
};

// --- Метки (несколько произвольных на карточку) ---
let selectedPopColor = '#0052cc';

window.openLabelPopover = async function() {
    if (!currentCardDbId) return;
    openPopover('Метки', '<div class="mp-loading">Загрузка...</div>');

    let labels = [];
    try {
        const res = await fetch(`/api/cards/${currentCardDbId}/labels`);
        if (res.ok) labels = await res.json();
    } catch (err) {
        console.error('openLabelPopover error:', err);
    }

    const palette = ['#0052cc','#6554c0','#00875a','#de350b','#ff8b00','#00b8d9'];
    selectedPopColor = palette[0];

    const existingHtml = labels.map(l => `
        <div class="mp-user" data-label-id="${l.id}">
            <span class="card-label" style="background:${l.color}20;color:${l.color};border:1px solid ${l.color}40">${escHtml(l.name)}</span>
            <button class="cm-attach-del" onclick="removeCardLabel(${l.id})" title="Удалить">✕</button>
        </div>`).join('');

    const swatches = palette.map(c =>
        `<div class="pop-color${c === selectedPopColor ? ' active' : ''}"
              style="background:${c}" data-color="${c}"
              onclick="selectPopColor(this)"></div>`
    ).join('');

    document.getElementById('cspBody').innerHTML = `
        ${existingHtml || '<p class="cm-empty-hint">Нет меток</p>'}
        <div class="csp-form-group" style="margin-top:10px">
            <label class="csp-label">Новая метка</label>
            <input class="csp-input" id="popLabelText" type="text" placeholder="Разработка, Сеть...">
        </div>
        <div class="csp-form-group">
            <label class="csp-label">Цвет</label>
            <div class="pop-colors">${swatches}</div>
        </div>
        <button class="csp-btn csp-btn--primary" onclick="addCardLabel()">Добавить метку</button>
    `;
    setTimeout(() => document.getElementById('popLabelText')?.focus(), 50);
};

window.selectPopColor = el => {
    document.querySelectorAll('.pop-color').forEach(e => e.classList.remove('active'));
    el.classList.add('active');
    selectedPopColor = el.dataset.color;
};

window.addCardLabel = async function() {
    const input = document.getElementById('popLabelText');
    const name  = input?.value.trim();
    const color = selectedPopColor;
    if (!name || !currentCardDbId) return;
    await fetch(`/api/cards/${currentCardDbId}/labels`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, color })
    });
    renderCardLabelsInMeta(currentCardDbId);
    openLabelPopover();
};

window.removeCardLabel = async function(labelId) {
    if (!currentCardDbId) return;
    await fetch(`/api/cards/${currentCardDbId}/labels/${labelId}`, { method: 'DELETE' });
    renderCardLabelsInMeta(currentCardDbId);
    openLabelPopover();
};

async function renderCardLabelsInMeta(cardId) {
    try {
        const res = await fetch(`/api/cards/${cardId}/labels`);
        if (!res.ok) return;
        const labels = await res.json();
        updateModalLabels(labels);
        updateCardLabelsOnBoard(currentCardId, labels);
    } catch {}
}

function updateModalLabels(labels) {
    const meta = document.getElementById('cmMeta');
    if (!meta) return;
    meta.querySelectorAll('.card-label').forEach(el => el.remove());
    const due = meta.querySelector('.cm-due-badge');
    (labels || []).forEach(l => {
        const span = document.createElement('span');
        span.className = 'card-label';
        span.dataset.labelId = l.id;
        span.style.cssText = `background:${l.color}20;color:${l.color};border:1px solid ${l.color}40`;
        span.textContent = l.name;
        meta.insertBefore(span, due || null);
    });
}

function updateCardLabelsOnBoard(cardDomId, labels) {
    const cardEl = document.getElementById(cardDomId);
    if (!cardEl) return;
    cardEl.querySelector('.card-labels')?.remove();
    if (labels && labels.length) {
        const wrap = document.createElement('div');
        wrap.className = 'card-labels';
        labels.forEach(l => {
            const span = document.createElement('span');
            span.className = 'card-label';
            span.style.cssText = `background:${l.color}20;color:${l.color};border:1px solid ${l.color}40`;
            span.textContent = l.name;
            wrap.appendChild(span);
        });
        const checkBtn = cardEl.querySelector('.card-check-btn');
        checkBtn ? checkBtn.after(wrap) : cardEl.prepend(wrap);
    }
}

// --- Важность (ровно один уровень на карточку, автоматически ставит обложку) ---
const IMPORTANCE_LEVELS = [
    { name: 'Срочно',           color: '#de350b' },
    { name: 'Средняя важность', color: '#ffab00' },
    { name: 'Низкий приоритет', color: '#00875a' },
];

window.openImportancePopover = async function() {
    if (!currentCardDbId) return;
    openPopover('Важность', '<div class="mp-loading">Загрузка...</div>');

    let activeName = '';
    try {
        const res = await fetch(`/api/cards/${currentCardDbId}/importance`);
        if (res.ok) activeName = (await res.json()).name || '';
    } catch (err) {
        console.error('openImportancePopover error:', err);
    }

    const buttonsHtml = IMPORTANCE_LEVELS.map(l => `
        <button class="importance-btn${l.name === activeName ? ' importance-btn--active' : ''}"
                style="--pl-color:${l.color}"
                onclick="toggleImportance('${l.name}')">
            <span class="importance-dot" style="background:${l.color}"></span>
            ${escHtml(l.name)}
        </button>`).join('');

    document.getElementById('cspBody').innerHTML = `
        <div class="importance-list">${buttonsHtml}</div>
        <p class="cm-empty-hint" style="margin-top:8px">Важность ставит обложку того же цвета; повторный клик по активному уровню снимает его и убирает обложку.</p>
    `;
};

window.toggleImportance = async function(name) {
    if (!currentCardDbId) return;
    let data = { name: '', color: '' };
    try {
        const res = await fetch(`/api/cards/${currentCardDbId}/importance`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name })
        });
        data = await res.json();
    } catch (err) { console.error('toggleImportance error:', err); }

    updateCardCoverDOM(currentCardId, data.color || '');
    updateModalImportance(data);
    updateCardImportanceOnBoard(currentCardId, data);
    openImportancePopover();
};

function updateModalImportance(imp) {
    const meta = document.getElementById('cmMeta');
    if (!meta) return;
    meta.querySelectorAll('.card-importance').forEach(el => el.remove());
    if (imp && imp.name) {
        const span = document.createElement('span');
        span.className = 'card-importance';
        span.style.cssText = `background:${imp.color}20;color:${imp.color};border:1px solid ${imp.color}40`;
        span.textContent = imp.name;
        meta.appendChild(span);
    }
}

function updateCardImportanceOnBoard(cardDomId, imp) {
    const cardEl = document.getElementById(cardDomId);
    if (!cardEl) return;
    cardEl.querySelector('.card-importance')?.remove();
    if (imp && imp.name) {
        const span = document.createElement('span');
        span.className = 'card-importance';
        span.style.cssText = `background:${imp.color}20;color:${imp.color};border:1px solid ${imp.color}40`;
        span.textContent = imp.name;
        const anchor = cardEl.querySelector('.card-labels') || cardEl.querySelector('.card-edit-btn');
        anchor ? anchor.after(span) : cardEl.prepend(span);
    }
}

// --- Срок — мини-календарь ---
const _cal = { year: 0, month: 0, selected: '', onSelect: null, onClear: null, clearLabel: 'Убрать срок' };
const _RU_MONTHS = ['Январь','Февраль','Март','Апрель','Май','Июнь',
                    'Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
const _CAL_SVG = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`;

function _calBuild() {
    const { year, month, selected } = _cal;
    const today = new Date(); today.setHours(0,0,0,0);
    const first  = new Date(year, month, 1);
    let   startDow = first.getDay();
    startDow = startDow === 0 ? 6 : startDow - 1;
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    let selDate = null;
    if (selected) {
        const [dd, mm, yy] = selected.split('.').map(Number);
        selDate = new Date(yy, mm-1, dd); selDate.setHours(0,0,0,0);
    }
    let cells = '';
    for (let i = 0; i < startDow; i++) cells += '<span class="cal-day cal-day--empty"></span>';
    for (let d = 1; d <= daysInMonth; d++) {
        const dt = new Date(year, month, d); dt.setHours(0,0,0,0);
        const isSel   = selDate && dt.getTime() === selDate.getTime();
        const isToday = dt.getTime() === today.getTime();
        const isPast  = dt < today;
        let cls = 'cal-day';
        if (isSel)   cls += ' cal-day--selected';
        if (isToday) cls += ' cal-day--today';
        if (isPast)  cls += ' cal-day--past';
        cells += `<button class="${cls}" onclick="calSelectDay(${d},${month+1},${year})">${d}</button>`;
    }
    return `<div class="cal-wrap">
        <div class="cal-hdr">
            <button class="cal-nav" onclick="calPrevMonth()">‹</button>
            <span class="cal-my">${_RU_MONTHS[month]} ${year}</span>
            <button class="cal-nav" onclick="calNextMonth()">›</button>
        </div>
        <div class="cal-grid">
            <span class="cal-dow">Пн</span><span class="cal-dow">Вт</span><span class="cal-dow">Ср</span>
            <span class="cal-dow">Чт</span><span class="cal-dow">Пт</span>
            <span class="cal-dow cal-dow--we">Сб</span><span class="cal-dow cal-dow--we">Вс</span>
            ${cells}
        </div>
        ${selected ? `<button class="csp-btn csp-btn--secondary" style="margin-top:10px" onclick="clearDueDate()">${_cal.clearLabel}</button>` : ''}
    </div>`;
}

function _calRefresh() {
    const body = document.getElementById('cspBody');
    if (body) body.innerHTML = _calBuild();
}

function _calOpenForDate(currentDue, title = 'Срок', clearLabel = 'Убрать срок') {
    const now = new Date();
    let iy = now.getFullYear(), im = now.getMonth();
    if (currentDue) {
        const [, mm, yy] = currentDue.split('.').map(Number);
        if (!isNaN(yy)) { iy = yy; im = mm - 1; }
    }
    _cal.year = iy; _cal.month = im; _cal.selected = currentDue; _cal.clearLabel = clearLabel;
    openPopover(title, _calBuild());
}

window.openDueDatePopover = function() {
    const dueEl = document.getElementById('cmMeta')?.querySelector('.cm-due-badge');
    const currentDue = dueEl ? (dueEl.dataset.due || '') : '';
    _cal.onSelect = async (due) => {
        if (!currentCardDbId) return;
        await fetch(`/api/cards/${currentCardDbId}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ due_date: due })
        });
        updateModalDue(due);
        updateCardDue(currentCardId, due);
    };
    _cal.onClear = async () => {
        if (!currentCardDbId) return;
        await fetch(`/api/cards/${currentCardDbId}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ due_date: '' })
        });
        updateModalDue('');
        updateCardDue(currentCardId, '');
    };
    _calOpenForDate(currentDue);
};

window.calPrevMonth = function() {
    _cal.month--; if (_cal.month < 0) { _cal.month = 11; _cal.year--; }
    _calRefresh();
};

window.calNextMonth = function() {
    _cal.month++; if (_cal.month > 11) { _cal.month = 0; _cal.year++; }
    _calRefresh();
};

window.calSelectDay = async function(d, m, y) {
    const due = String(d).padStart(2,'0') + '.' + String(m).padStart(2,'0') + '.' + y;
    _cal.selected = due;
    _calRefresh();
    if (_cal.onSelect) await _cal.onSelect(due);
    setTimeout(closePopover, 260);
};

window.clearDueDate = async function() {
    if (_cal.onClear) await _cal.onClear();
    closePopover();
};

function updateModalDue(due) {
    const meta = document.getElementById('cmMeta');
    meta.querySelector('.cm-due-badge')?.remove();
    if (due) {
        const span = document.createElement('span');
        span.className = 'cm-due-badge';
        span.dataset.due = due;
        span.innerHTML = `${_CAL_SVG} ${escHtml(due)}`;
        meta.appendChild(span);
    }
}

function updateCardDue(cardDomId, due) {
    const cardEl = document.getElementById(cardDomId);
    if (!cardEl) return;
    cardEl.querySelector('.card-due')?.remove();
    if (due) {
        const div = document.createElement('div');
        div.className = 'card-due ' + dueDateClass(due);
        div.innerHTML = `<span class="due-icon">${_CAL_SVG}</span> ${escHtml(due)}`;
        cardEl.appendChild(div);
    }
}

// --- Дата начала (переиспользует календарь срока, см. _cal) ---
window.openStartDatePopover = function() {
    const startEl = document.getElementById('cmMeta')?.querySelector('.cm-start-badge');
    const currentStart = startEl ? (startEl.dataset.start || '') : '';
    _cal.onSelect = async (start) => {
        if (!currentCardDbId) return;
        await fetch(`/api/cards/${currentCardDbId}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ start_date: start })
        });
        updateModalStart(start);
    };
    _cal.onClear = async () => {
        if (!currentCardDbId) return;
        await fetch(`/api/cards/${currentCardDbId}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ start_date: '' })
        });
        updateModalStart('');
    };
    _calOpenForDate(currentStart, 'Дата начала', 'Убрать дату начала');
};

function updateModalStart(start) {
    const meta = document.getElementById('cmMeta');
    meta.querySelector('.cm-start-badge')?.remove();
    if (start) {
        const span = document.createElement('span');
        span.className = 'cm-start-badge';
        span.dataset.start = start;
        span.innerHTML = `${_CAL_SVG} ${escHtml(start)}`;
        meta.appendChild(span);
    }
}

// --- Переместить ---
window.openMovePopover = function() {
    const currentColId = parseInt(
        document.getElementById(currentCardId)?.closest('.column')?.dataset.colId || '0'
    );
    const cols  = [...document.querySelectorAll('.column:not(.column--add)')];
    const items = cols.map(col => {
        const colId    = parseInt(col.dataset.colId);
        const colName  = col.querySelector('.column-title')?.textContent.trim() || '';
        const isCurrent = colId === currentColId;
        return `<div class="move-col-item${isCurrent ? ' current-col' : ''}"
                     ${isCurrent ? '' : `onclick="moveCardToColumn(${colId})"`}>
                    ${escHtml(colName)}${isCurrent ? ' ← текущая' : ''}
                </div>`;
    }).join('');

    const otherBoardBtn = `
        <div class="move-col-item" onclick="openMoveBoardPicker()">→ На другую доску</div>`;

    openPopover('Переместить', `<div>${items}${otherBoardBtn}</div>`);
};

window.moveCardToColumn = async function(targetColId) {
    if (!currentCardDbId) return;
    await fetch(`/api/cards/${currentCardDbId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ column_id: targetColId, position: 9999 })
    });
    const cardEl     = document.getElementById(currentCardId);
    const targetList = document.getElementById('cards-' + targetColId);
    if (cardEl && targetList) { targetList.appendChild(cardEl); updateColumnCounts(); }
    closePopover();
    closeCardModal();
};

// ===== ЗЕРКАЛЬНЫЕ КАРТОЧКИ (Should №30) =====

window.openMirrorPopover = function() {
    const cols  = [...document.querySelectorAll('.column:not(.column--add)')];
    const items = cols.map(col => {
        const colId   = parseInt(col.dataset.colId);
        const colName = col.querySelector('.column-title')?.textContent.trim() || '';
        return `<div class="move-col-item" onclick="createMirror(${colId})">${escHtml(colName)}</div>`;
    }).join('');

    const otherBoardBtn = `<div class="move-col-item" onclick="openMirrorBoardPicker()">→ На другую доску</div>`;

    openPopover('Зеркало в колонку', `
        <p class="cm-empty-hint" style="margin-bottom:6px">Карточка появится ещё и в выбранной колонке — это не копия: изменения видны везде.</p>
        <div>${items}${otherBoardBtn}</div>
    `);
};

window.openMirrorBoardPicker = async function() {
    const currentBoardId = parseInt(document.getElementById('boardColumns').dataset.boardId);

    if (!_blBoards) {
        try {
            const res = await fetch('/api/boards');
            _blBoards = await res.json();
        } catch {
            openPopover('Другая доска', '<div class="mp-note">Ошибка загрузки</div>');
            return;
        }
    }

    const items = _blBoards
        .filter(b => b.id !== currentBoardId)
        .map(b => `
            <div class="move-col-item" data-mirror-board-id="${b.id}" data-mirror-board-name="${escHtml(b.name)}"
                 onclick="openMirrorColumnPicker(this)">
                <span class="bl-dot" style="background:${escHtml(b.color)}"></span>
                ${escHtml(b.name)}
            </div>`).join('');

    const back = `<div class="move-col-item" onclick="openMirrorPopover()">← Назад</div>`;
    openPopover('Другая доска', `<div>${back}${items || '<p class="bl-empty">Нет других досок</p>'}</div>`);
};

window.openMirrorColumnPicker = async function(el) {
    const boardId   = parseInt(el.dataset.mirrorBoardId);
    const boardName = el.dataset.mirrorBoardName;
    openPopover(boardName, '<div class="mp-loading">Загрузка...</div>');

    let cols = [];
    try {
        const res = await fetch(`/api/boards/${boardId}/columns`);
        cols = await res.json();
    } catch {
        openPopover(boardName, '<div class="mp-note">Ошибка загрузки</div>');
        return;
    }

    const items = cols.map(c =>
        `<div class="move-col-item" onclick="createMirror(${c.id})">${escHtml(c.name)}</div>`
    ).join('');
    const back = `<div class="move-col-item" onclick="openMirrorBoardPicker()">← Назад к доскам</div>`;

    openPopover(boardName, `<div>${back}${items || '<p class="bl-empty">Нет колонок</p>'}</div>`);
};

window.createMirror = async function(targetColId) {
    if (!currentCardDbId) return;
    const res = await fetch(`/api/cards/${currentCardDbId}/mirror`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ column_id: targetColId })
    });
    if (!res.ok) { showToast('Не удалось создать зеркало', 'error'); closePopover(); return; }
    closePopover();
    showToast('Зеркало создано — появится в выбранной колонке при следующей загрузке доски');
};

window.removeMirror = async function(e, mirrorId) {
    e.stopPropagation();
    if (!confirm('Убрать зеркало из этой колонки? Исходная карточка не удалится.')) return;
    await fetch(`/api/card-mirrors/${mirrorId}`, { method: 'DELETE' });
    document.getElementById('card-mirror-' + mirrorId)?.remove();
};

window.openMoveBoardPicker = async function() {
    const currentBoardId = parseInt(document.getElementById('boardColumns').dataset.boardId);

    if (!_blBoards) {
        try {
            const res = await fetch('/api/boards');
            _blBoards = await res.json();
        } catch {
            openPopover('Другая доска', '<div class="mp-note">Ошибка загрузки</div>');
            return;
        }
    }

    const items = _blBoards
        .filter(b => b.id !== currentBoardId)
        .map(b => `
            <div class="move-col-item" data-move-board-id="${b.id}" data-move-board-name="${escHtml(b.name)}"
                 onclick="openMoveColumnPicker(this)">
                <span class="bl-dot" style="background:${escHtml(b.color)}"></span>
                ${escHtml(b.name)}
            </div>`).join('');

    const back = `<div class="move-col-item" onclick="openMovePopover()">← Назад</div>`;

    openPopover('Другая доска', `<div>${back}${items || '<p class="bl-empty">Нет других досок</p>'}</div>`);
};

window.openMoveColumnPicker = async function(el) {
    const boardId   = parseInt(el.dataset.moveBoardId);
    const boardName = el.dataset.moveBoardName;
    openPopover(boardName, '<div class="mp-loading">Загрузка...</div>');

    let cols = [];
    try {
        const res = await fetch(`/api/boards/${boardId}/columns`);
        cols = await res.json();
    } catch {
        openPopover(boardName, '<div class="mp-note">Ошибка загрузки</div>');
        return;
    }

    const items = cols.map(c =>
        `<div class="move-col-item" onclick="moveCardToBoard(${boardId}, ${c.id})">${escHtml(c.name)}</div>`
    ).join('');
    const back = `<div class="move-col-item" onclick="openMoveBoardPicker()">← Назад к доскам</div>`;

    openPopover(boardName, `<div>${back}${items || '<p class="bl-empty">Нет колонок</p>'}</div>`);
};

window.moveCardToBoard = async function(targetBoardId, targetColId) {
    if (!currentCardDbId) return;
    await fetch(`/api/cards/${currentCardDbId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ column_id: targetColId, position: 9999 })
    });
    document.getElementById(currentCardId)?.remove();
    updateColumnCounts();
    closePopover();
    closeCardModal();
};

// ===== MEMBERS PANEL =====

window.openMembersPanel = async function(triggerBtn) {
    const panel = document.getElementById('membersPanel');
    if (!panel) return;

    if (panel.style.display !== 'none') {
        panel.style.display = 'none';
        triggerBtn?.classList.remove('btn-board-action--active');
        return;
    }

    closeBoardSwitcher();
    triggerBtn?.classList.add('btn-board-action--active');
    panel.style.display = '';
    await renderMembersPanel();
};

window.renderMembersPanel = async function() {
    const list = document.getElementById('mpList');
    list.innerHTML = '<div class="mp-loading">Загрузка...</div>';

    const boardEl = document.getElementById('boardColumns');
    const boardId = parseInt(boardEl?.dataset.boardId || '0');
    const isAdmin = boardEl?.dataset.userRole === 'admin';

    try {
        // Список тех, у кого реально есть доступ к доске — виден всем участникам доски
        const membersRes = await fetch(`/api/boards/${boardId}/members`);
        if (!membersRes.ok) {
            list.innerHTML = '<div class="mp-note">Не удалось загрузить участников.</div>';
            return;
        }
        const members = await membersRes.json();

        // Для админа дополнительно тянем полный список пользователей с флагом доступа —
        // нужен, чтобы показать кнопки управления и список кандидатов на добавление
        let accessByEmail = null;
        let candidates = [];
        if (isAdmin) {
            const accessRes = await fetch(`/api/boards/${boardId}/access`);
            if (accessRes.ok) {
                const users = await accessRes.json();
                accessByEmail = new Map(users.map(u => [(u.email || '').toLowerCase(), u]));
                candidates = users.filter(u => !u.has_access);
            }
        }

        if (!members.length) {
            list.innerHTML = '<div class="mp-note">Нет пользователей с доступом к доске.</div>';
        } else {
            list.innerHTML = members.map(m => {
                const avatar = (m.name || m.email || '?')[0].toUpperCase();
                const u = accessByEmail?.get((m.email || '').toLowerCase());
                return `<div class="mp-user">
                    <div class="mp-avatar">${escHtml(avatar)}</div>
                    <div class="mp-info">
                        <span class="mp-name">${escHtml(m.name || m.email)}</span>
                        <span class="mp-email">${escHtml(m.email)}</span>
                    </div>
                    ${u ? `
                    <button class="mp-icon-btn" title="Убрать с доски" onclick="mpRevokeAccess(${boardId}, ${u.id})">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                    </button>
                    <button class="mp-icon-btn mp-icon-btn--danger" title="Удалить пользователя из системы" onclick="mpDeleteUser('${escHtml(m.email)}')">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
                    </button>` : ''}
                </div>`;
            }).join('');
        }

        if (isAdmin) {
            const addHtml = `<div class="mp-add-row">
                <select id="mpAddSelect" class="mp-add-select" onchange="mpAddMember(${boardId}, this.value)">
                    <option value="">${candidates.length ? '+ Добавить участника…' : 'Нет пользователей для добавления'}</option>
                    ${candidates.map(u => `<option value="${u.id}">${escHtml(u.name || u.email)}</option>`).join('')}
                </select>
            </div>`;
            list.insertAdjacentHTML('beforeend', addHtml);
        }
    } catch (err) {
        console.error('Members panel error:', err);
        list.innerHTML = '<div class="mp-note">Ошибка загрузки участников.</div>';
    }
};

window.mpRevokeAccess = async function(boardId, userId) {
    await toggleMemberAccess(boardId, userId, false);
    renderMembersPanel();
};

window.mpAddMember = async function(boardId, userId) {
    if (!userId) return;
    await toggleMemberAccess(boardId, parseInt(userId), true);
    renderMembersPanel();
};

window.mpDeleteUser = async function(email) {
    if (!confirm(`Удалить пользователя ${email} из системы?\n\nОн потеряет доступ ко всем доскам. Действие необратимо.`)) return;
    await fetch('/api/users/' + encodeURIComponent(email), { method: 'DELETE' });
    renderMembersPanel();
};

window.closeMembersPanel = function() {
    document.getElementById('membersPanel').style.display = 'none';
    document.getElementById('btnMembers')?.classList.remove('btn-board-action--active');
};

window.toggleMemberAccess = async function(boardId, userId, grant) {
    if (grant) {
        await fetch(`/api/boards/${boardId}/access`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_id: userId })
        });
    } else {
        await fetch(`/api/boards/${boardId}/access/${userId}`, { method: 'DELETE' });
    }
};

// --- Копировать ---
window.duplicateCard = async function() {
    if (!currentCardDbId) return;
    const res  = await fetch(`/api/cards/${currentCardDbId}/duplicate`, { method: 'POST' });
    const card = await res.json();
    const colId = parseInt(
        document.getElementById(currentCardId)?.closest('.column')?.dataset.colId || '0'
    );
    if (colId) appendCardToDOM(card, colId);
    closeCardModal();
};


// ===== QUICK EDIT =====

let qeCardId   = null;
let qeCardDomId = null;

window.openQuickEdit = function(e, btn) {
    e.stopPropagation();
    const card = btn.closest('.card');
    qeCardDomId = card.id;
    qeCardId    = parseInt(card.dataset.cardId);

    const title = card.querySelector('.card-title')?.textContent.trim() || '';
    document.getElementById('qeTitle').value = title;

    // Позиционируем попап рядом с карточкой
    const rect   = card.getBoundingClientRect();
    const popup  = document.getElementById('quickEditPopup');
    popup.style.display = 'flex';  // нужно для измерения размеров
    const popH   = popup.offsetHeight;
    const popW   = popup.offsetWidth;
    let top  = rect.top + window.scrollY;
    let left = rect.right + 8 + window.scrollX;

    // Если не помещается справа — слева
    if (left + popW > window.innerWidth - 8) {
        left = rect.left - popW - 8 + window.scrollX;
    }
    // Если не помещается снизу — сдвигаем вверх
    if (top + popH > window.innerHeight + window.scrollY - 8) {
        top = window.innerHeight + window.scrollY - popH - 8;
    }

    popup.style.top  = top + 'px';
    popup.style.left = left + 'px';
    popup.classList.add('active');
    document.getElementById('quickEditOverlay').classList.add('active');

    setTimeout(() => {
        const ta = document.getElementById('qeTitle');
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
    }, 30);
};

window.closeQuickEdit = function() {
    document.getElementById('quickEditPopup').classList.remove('active');
    document.getElementById('quickEditOverlay').classList.remove('active');
    document.getElementById('quickEditPopup').style.display = 'none';
    qeCardId    = null;
    qeCardDomId = null;
};

window.saveQuickEdit = async function() {
    if (!qeCardId) return;
    const newTitle = document.getElementById('qeTitle').value.trim();
    if (!newTitle) return;

    await fetch(`/api/cards/${qeCardId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: newTitle })
    });

    const cardEl = document.getElementById(qeCardDomId);
    if (cardEl) {
        const t = cardEl.querySelector('.card-title');
        if (t) t.textContent = newTitle;
    }
    closeQuickEdit();
};

window.qeOpenCardModal = function() {
    const cardEl = document.getElementById(qeCardDomId);
    closeQuickEdit();
    if (cardEl) openCardModal({}, cardEl);
};

window.qeMoveCard = function() {
    const cardEl = document.getElementById(qeCardDomId);
    closeQuickEdit();
    if (cardEl) {
        openCardModal({}, cardEl);
        setTimeout(() => openMovePopover(), 150);
    }
};

window.qeLabel = function() {
    const cardEl = document.getElementById(qeCardDomId);
    closeQuickEdit();
    if (cardEl) {
        openCardModal({}, cardEl);
        setTimeout(() => openLabelPopover(), 150);
    }
};

window.qeDueDate = function() {
    const cardEl = document.getElementById(qeCardDomId);
    closeQuickEdit();
    if (cardEl) {
        openCardModal({}, cardEl);
        setTimeout(() => openDueDatePopover(), 150);
    }
};

window.qeDelete = function() {
    if (!qeCardId) return;
    const cardId  = qeCardId;
    const cardEl  = document.getElementById(qeCardDomId);
    const parent  = cardEl?.parentNode;
    const nextSib = cardEl?.nextSibling;
    if (cardEl) cardEl.remove();
    closeQuickEdit();
    updateColumnCounts();
    showUndoToast('Карточка перемещена в архив',
        function() { fetch('/api/cards/' + cardId, { method: 'DELETE' }); },
        function() { if (parent) parent.insertBefore(cardEl, nextSib); updateColumnCounts(); }
    );
};

document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && qeCardId) closeQuickEdit();
});


// ===== CARD COMPLETE =====

window.toggleComplete = async function(e, btn) {
    e.stopPropagation();
    const card    = btn.closest('.card');
    const cardId  = parseInt(card.dataset.cardId);
    const isDone  = card.classList.contains('card--done');

    card.classList.toggle('card--done', !isDone);

    fetch(`/api/cards/${cardId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ completed: isDone ? 0 : 1 })
    });
};


// ===== COLUMN RENAME =====

window.startRenameColumn = function(h3El) {
    const colEl   = h3El.closest('.column');
    const colId   = parseInt(colEl.dataset.colId);
    const oldName = h3El.textContent.trim();

    const input       = document.createElement('input');
    input.type        = 'text';
    input.value       = oldName;
    input.className   = 'column-title-input';
    input.maxLength   = 80;

    h3El.replaceWith(input);
    input.select();

    let saved = false;

    const save = async () => {
        if (saved) return;
        saved = true;

        const newName = input.value.trim() || oldName;
        const h3 = document.createElement('h3');
        h3.className = 'column-title';
        h3.title     = 'Нажмите для переименования';
        h3.textContent = newName;
        h3.onclick   = () => startRenameColumn(h3);
        input.replaceWith(h3);

        if (newName !== oldName) {
            fetch(`/api/columns/${colId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: newName })
            });
        }
    };

    const cancel = () => {
        if (saved) return;
        saved = true;
        const h3 = document.createElement('h3');
        h3.className = 'column-title';
        h3.title     = 'Нажмите для переименования';
        h3.textContent = oldName;
        h3.onclick   = () => startRenameColumn(h3);
        input.replaceWith(h3);
    };

    input.addEventListener('blur',    save);
    input.addEventListener('keydown', e => {
        if (e.key === 'Enter')  { e.preventDefault(); save(); }
        if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    });
};


// ===== CHECKLISTS (несколько именованных чек-листов на карточку) =====

window.addChecklist = async function() {
    if (!currentCardDbId) return;
    const res = await fetch(`/api/cards/${currentCardDbId}/checklists`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Чек-лист' })
    });
    if (!res.ok) return;
    const cl = await res.json();
    document.getElementById('cmChecklistSection').style.display = '';
    const group = renderChecklistGroup(cl);
    const titleEl = group.querySelector('.cm-checklist-group-title');
    if (titleEl) startRenameChecklist(titleEl);
};

window.openCopyChecklistPopover = async function() {
    if (!currentCardDbId) return;
    openPopover('Копировать чек-лист', '<div class="mp-loading">Загрузка...</div>');

    const boardId = _getBoardId();
    let checklists = [];
    try {
        const res = await fetch(`/api/boards/${boardId}/checklists`);
        if (res.ok) checklists = await res.json();
    } catch (err) {
        console.error('openCopyChecklistPopover error:', err);
    }

    // Не предлагаем копировать чек-лист с этой же карточки на неё же
    checklists = checklists.filter(cl => cl.card_id !== currentCardDbId);

    const body = document.getElementById('cspBody');
    if (!checklists.length) {
        body.innerHTML = '<p class="cm-empty-hint">На этой доске нет чек-листов на других карточках</p>';
        return;
    }
    body.innerHTML = `
        <input class="csp-input" id="copyClSearch" type="text"
               placeholder="Поиск по названию карточки или чек-листа..."
               oninput="filterCopyChecklistList(this.value)">
        <div class="copy-cl-list" id="copyClList"></div>
    `;
    _copyClAll = checklists;
    renderCopyChecklistList(checklists);
    setTimeout(() => document.getElementById('copyClSearch')?.focus(), 50);
};

let _copyClAll = [];

function renderCopyChecklistList(items) {
    const list = document.getElementById('copyClList');
    if (!list) return;
    if (!items.length) {
        list.innerHTML = '<p class="cm-empty-hint">Ничего не найдено</p>';
        return;
    }
    list.innerHTML = items.map(cl => `
        <button class="copy-cl-item" onclick="copyChecklistFrom(${cl.id})">
            <span class="copy-cl-title">${escHtml(cl.title)}</span>
            <span class="copy-cl-meta">${escHtml(cl.card_title)} · ${cl.item_count} пункт(ов)</span>
        </button>
    `).join('');
}

window.filterCopyChecklistList = function(q) {
    q = q.toLowerCase().trim();
    const filtered = _copyClAll.filter(cl =>
        cl.title.toLowerCase().includes(q) || cl.card_title.toLowerCase().includes(q)
    );
    renderCopyChecklistList(filtered);
};

window.copyChecklistFrom = async function(sourceChecklistId) {
    if (!currentCardDbId) return;
    const res = await fetch(`/api/cards/${currentCardDbId}/checklists/copy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source_checklist_id: sourceChecklistId })
    });
    if (!res.ok) { showToast('Не удалось скопировать чек-лист', 'error'); return; }
    const cl = await res.json();
    document.getElementById('cmChecklistSection').style.display = '';
    renderChecklistGroup(cl);
    updateChecklistProgress();
    closePopover();
    showToast('Чек-лист скопирован');
};


// ===== ШАБЛОНЫ КАРТОЧЕК (Should №10) =====

window.openSaveAsTemplatePopover = function() {
    if (!currentCardDbId) return;
    openPopover('Сохранить как шаблон', `
        <div class="csp-form-group">
            <label class="csp-label">Название шаблона</label>
            <input class="csp-input" id="tplNameInput" type="text" placeholder="Например: Онбординг сотрудника">
        </div>
        <p class="cm-empty-hint" style="margin-top:6px">В шаблон войдут название, описание, важность, метки, чек-листы и кастомные поля этой карточки.</p>
        <button class="csp-btn csp-btn--primary" style="margin-top:8px" onclick="saveCardAsTemplate()">Сохранить</button>
    `);
    setTimeout(() => document.getElementById('tplNameInput')?.focus(), 50);
};

window.saveCardAsTemplate = async function() {
    const input = document.getElementById('tplNameInput');
    const name  = input?.value.trim();
    if (!name || !currentCardDbId) return;
    const res = await fetch(`/api/cards/${currentCardDbId}/save-as-template`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
    });
    if (!res.ok) { showToast('Не удалось сохранить шаблон', 'error'); return; }
    closePopover();
    showToast('Шаблон сохранён');
};

let cardTemplateTargetColId = null;

window.openCardTemplatePicker = function(e, colId) {
    e.stopPropagation();
    cardTemplateTargetColId = colId;
    const dd   = document.getElementById('cardTemplateDropdown');
    const rect = e.currentTarget.getBoundingClientRect();
    dd.style.top  = (rect.bottom + window.scrollY + 4) + 'px';
    dd.style.left = rect.left + 'px';
    dd.style.display = 'block';
    _refreshCardTemplateDropdown();
};

async function _refreshCardTemplateDropdown() {
    const dd = document.getElementById('cardTemplateDropdown');
    dd.innerHTML = '<div class="col-menu-item" style="color:#6b778c">Загрузка...</div>';

    const boardId = _getBoardId();
    let templates = [];
    try {
        const res = await fetch(`/api/boards/${boardId}/card-templates`);
        if (res.ok) templates = await res.json();
    } catch (err) {
        console.error('_refreshCardTemplateDropdown error:', err);
    }

    if (!templates.length) {
        dd.innerHTML = '<div class="col-menu-item" style="color:#6b778c">Нет шаблонов на этой доске</div>';
        return;
    }
    dd.innerHTML = templates.map(t => `
        <div class="col-menu-item-row">
            <button class="col-menu-item" style="flex:1" onclick="createCardFromTemplate(${t.id})">${escHtml(t.name)}</button>
            <button class="col-menu-item-del" onclick="deleteCardTemplate(event, ${t.id})" title="Удалить шаблон">✕</button>
        </div>
    `).join('');
}

window.createCardFromTemplate = async function(templateId) {
    document.getElementById('cardTemplateDropdown').style.display = 'none';
    const colId = cardTemplateTargetColId;
    if (!colId) return;
    const res = await fetch(`/api/card-templates/${templateId}/instantiate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ column_id: colId })
    });
    if (!res.ok) { showToast('Не удалось создать карточку из шаблона', 'error'); return; }
    const card = await res.json();
    appendCardToDOM(card, colId);
    updateColumnCounts();
    inlineCardCancel(colId);
    showToast('Карточка создана из шаблона');
};

window.deleteCardTemplate = async function(e, templateId) {
    e.stopPropagation();
    if (!confirm('Удалить этот шаблон карточки? Уже созданные из него карточки не пострадают.')) return;
    await fetch(`/api/card-templates/${templateId}`, { method: 'DELETE' });
    _refreshCardTemplateDropdown();
};

document.addEventListener('click', function(e) {
    const dd = document.getElementById('cardTemplateDropdown');
    if (dd && dd.style.display !== 'none' && !dd.contains(e.target) && !e.target.closest('.tpl-picker-btn')) {
        dd.style.display = 'none';
    }
});

function renderChecklists(checklists) {
    const container = document.getElementById('cmChecklistsContainer');
    const section    = document.getElementById('cmChecklistSection');
    if (!container) return;
    container.innerHTML = '';
    section.style.display = (checklists && checklists.length) ? '' : 'none';
    (checklists || []).forEach(cl => renderChecklistGroup(cl));
    updateChecklistProgress();
}

function renderChecklistGroup(cl) {
    const container = document.getElementById('cmChecklistsContainer');
    const group = document.createElement('div');
    group.className = 'cm-checklist-group';
    group.dataset.checklistId = cl.id;
    group.innerHTML = `
        <div class="cm-checklist-group-head">
            <span class="cm-checklist-group-title" onclick="startRenameChecklist(this)"
                  title="Нажмите для переименования">${escHtml(cl.title)}</span>
            <span class="cm-checklist-progress-text"></span>
            <button class="cm-checklist-group-del" onclick="deleteChecklistGroup(${cl.id})" title="Удалить чек-лист">✕</button>
        </div>
        <div class="cm-checklist-bar-wrap"><div class="cm-checklist-bar"></div></div>
        <div class="cm-checklist-items"></div>
        <div class="cm-checklist-add">
            <input class="cm-checklist-input" type="text" placeholder="Добавить пункт..."
                   onkeydown="if(event.key==='Enter'){event.preventDefault(); submitChecklistItem(${cl.id}, this);}">
            <button class="btn-primary btn-sm" onclick="submitChecklistItem(${cl.id}, this)">Добавить</button>
        </div>
    `;
    container.appendChild(group);
    (cl.items || []).forEach(item => appendChecklistItemToDOM(cl.id, item));
    updateChecklistGroupProgress(cl.id);
    return group;
}

function appendChecklistItemToDOM(checklistId, item) {
    const group     = document.querySelector(`.cm-checklist-group[data-checklist-id="${checklistId}"]`);
    const container = group?.querySelector('.cm-checklist-items');
    if (!container) return;

    const div = document.createElement('div');
    div.className = 'cm-checklist-item' + (item.checked ? ' cl-done' : '');
    div.dataset.clId = item.id;

    div.innerHTML = `
        <input class="cm-cl-check" type="checkbox" ${item.checked ? 'checked' : ''}
               onchange="toggleChecklistItem(${item.id}, this)">
        <span class="cm-cl-text"
              onclick="startEditChecklistItem(this)"
              title="Нажмите для редактирования">${escHtml(item.text)}</span>
        <span class="cm-cl-due" onclick="openItemDuePopover(event, ${item.id})" title="Срок"></span>
        <span class="cm-cl-assignee" onclick="openItemAssigneePopover(event, ${item.id})" title="Исполнитель"></span>
        <button class="cm-cl-del" onclick="deleteChecklistItem(${item.id})" title="Удалить">✕</button>
    `;
    container.appendChild(div);
    renderItemDueBadge(div, item.due_date || '');
    renderItemAssigneeBadge(div, item.assignee_name || '');
}

function renderItemDueBadge(itemEl, due) {
    const badge = itemEl.querySelector('.cm-cl-due');
    if (!badge) return;
    itemEl.dataset.due = due || '';
    badge.classList.remove('due--overdue', 'due--soon', 'is-empty');
    if (due) {
        badge.innerHTML = `${_CAL_SVG} ${escHtml(due)}`;
        const cls = dueDateClass(due);
        if (cls) badge.classList.add(cls);
    } else {
        badge.textContent = '+ срок';
        badge.classList.add('is-empty');
    }
}

function renderItemAssigneeBadge(itemEl, name) {
    const badge = itemEl.querySelector('.cm-cl-assignee');
    if (!badge) return;
    itemEl.dataset.assigneeName = name || '';
    if (name) {
        badge.textContent = name[0].toUpperCase();
        badge.title = name;
        badge.classList.remove('is-empty');
    } else {
        badge.textContent = '+';
        badge.title = 'Назначить исполнителя';
        badge.classList.add('is-empty');
    }
}

function updateChecklistGroupProgress(checklistId) {
    const group = document.querySelector(`.cm-checklist-group[data-checklist-id="${checklistId}"]`);
    if (!group) return;
    const items   = group.querySelectorAll('.cm-checklist-item');
    const done    = group.querySelectorAll('.cm-checklist-item.cl-done');
    const total   = items.length;
    const checked = done.length;
    const pct     = total ? Math.round((checked / total) * 100) : 0;

    const bar  = group.querySelector('.cm-checklist-bar');
    const text = group.querySelector('.cm-checklist-progress-text');
    if (bar)  bar.style.width = pct + '%';
    if (text) text.textContent = total ? `${checked}/${total}` : '';

    updateChecklistProgress();
}

function updateChecklistProgress() {
    const items   = document.querySelectorAll('#cmChecklistsContainer .cm-checklist-item');
    const done    = document.querySelectorAll('#cmChecklistsContainer .cm-checklist-item.cl-done');
    const total   = items.length;
    const checked = done.length;

    // Обновляем прогресс-бар на превью карточки (суммарно по всем чек-листам)
    if (currentCardId) updateCardChecklistBar(currentCardId, checked, total);
}

window.submitChecklistItem = async function(checklistId, triggerEl) {
    const wrap  = triggerEl.closest('.cm-checklist-add');
    const input = wrap.querySelector('.cm-checklist-input');
    const text  = input.value.trim();
    if (!text) return;

    const res = await fetch(`/api/checklists/${checklistId}/items`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text })
    });
    if (res.ok) {
        appendChecklistItemToDOM(checklistId, await res.json());
        updateChecklistGroupProgress(checklistId);
        input.value = '';
        input.focus();
    }
};

window.toggleChecklistItem = async function(itemId, checkbox) {
    const item  = checkbox.closest('.cm-checklist-item');
    const group = checkbox.closest('.cm-checklist-group');
    const checked = checkbox.checked ? 1 : 0;
    item.classList.toggle('cl-done', !!checked);

    await fetch(`/api/checklist/${itemId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ checked })
    });
    if (group) updateChecklistGroupProgress(parseInt(group.dataset.checklistId));
};

window.deleteChecklistItem = async function(itemId) {
    const item  = document.querySelector(`.cm-checklist-item[data-cl-id="${itemId}"]`);
    const group = item?.closest('.cm-checklist-group');
    item?.remove();
    await fetch(`/api/checklist/${itemId}`, { method: 'DELETE' });
    if (group) updateChecklistGroupProgress(parseInt(group.dataset.checklistId));
};

window.startEditChecklistItem = function(span) {
    if (span.getAttribute('contenteditable') === 'true') return;
    const item   = span.closest('.cm-checklist-item');
    const itemId = parseInt(item.dataset.clId);
    const orig   = span.textContent;

    span.setAttribute('contenteditable', 'true');
    span.focus();
    const range = document.createRange();
    range.selectNodeContents(span);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);

    const save = async () => {
        span.removeAttribute('contenteditable');
        const newText = span.textContent.trim() || orig;
        span.textContent = newText;
        if (newText !== orig) {
            await fetch(`/api/checklist/${itemId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: newText })
            });
        }
    };

    span.addEventListener('blur', save, { once: true });
    span.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); span.blur(); }
        if (e.key === 'Escape') { span.textContent = orig; span.blur(); }
    }, { once: true });
};

window.startRenameChecklist = function(el) {
    if (el.getAttribute('contenteditable') === 'true') return;
    const group       = el.closest('.cm-checklist-group');
    const checklistId = parseInt(group.dataset.checklistId);
    const orig        = el.textContent;

    el.setAttribute('contenteditable', 'true');
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);

    const save = async () => {
        el.removeAttribute('contenteditable');
        const newTitle = el.textContent.trim() || orig;
        el.textContent = newTitle;
        if (newTitle !== orig) {
            await fetch(`/api/checklists/${checklistId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ title: newTitle })
            });
        }
    };

    el.addEventListener('blur', save, { once: true });
    el.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); el.blur(); }
        if (e.key === 'Escape') { el.textContent = orig; el.blur(); }
    }, { once: true });
};

window.deleteChecklistGroup = async function(checklistId) {
    if (!confirm('Удалить чек-лист со всеми пунктами?')) return;
    const group = document.querySelector(`.cm-checklist-group[data-checklist-id="${checklistId}"]`);
    group?.remove();
    await fetch(`/api/checklists/${checklistId}`, { method: 'DELETE' });
    updateChecklistProgress();
    if (!document.querySelector('.cm-checklist-group')) {
        document.getElementById('cmChecklistSection').style.display = 'none';
    }
};

// --- Срок на пункт чек-листа (переиспользует календарь карточки, см. _cal) ---
window.openItemDuePopover = function(event, itemId) {
    event.stopPropagation();
    const itemEl = document.querySelector(`.cm-checklist-item[data-cl-id="${itemId}"]`);
    const currentDue = itemEl?.dataset.due || '';
    _cal.onSelect = async (due) => {
        await fetch(`/api/checklist/${itemId}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ due_date: due })
        });
        if (itemEl) renderItemDueBadge(itemEl, due);
    };
    _cal.onClear = async () => {
        await fetch(`/api/checklist/${itemId}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ due_date: '' })
        });
        if (itemEl) renderItemDueBadge(itemEl, '');
    };
    _calOpenForDate(currentDue);
};

// --- Исполнитель на пункт чек-листа (из пользователей с доступом к доске) ---
window.openItemAssigneePopover = async function(event, itemId) {
    event.stopPropagation();
    const boardId = parseInt(document.getElementById('boardColumns').dataset.boardId);
    openPopover('Исполнитель', '<div class="mp-loading">Загрузка...</div>');

    let users = [];
    try {
        const res = await fetch(`/api/boards/${boardId}/members`);
        users = await res.json();
    } catch {
        openPopover('Исполнитель', '<div class="mp-note">Ошибка загрузки</div>');
        return;
    }

    const itemEl = document.querySelector(`.cm-checklist-item[data-cl-id="${itemId}"]`);
    const currentEmail = itemEl?.dataset.assigneeEmail || '';

    const rows = users.map(u => `
        <div class="mp-user mp-user--pick" data-email="${escHtml(u.email)}" data-name="${escHtml(u.name || u.email)}"
             onclick="pickItemAssignee(${itemId}, this)">
            <div class="mp-avatar">${escHtml((u.name || u.email || '?')[0].toUpperCase())}</div>
            <div class="mp-info"><span class="mp-name">${escHtml(u.name || u.email)}</span></div>
            ${u.email === currentEmail ? '<span class="mp-check">✓</span>' : ''}
        </div>`).join('');

    const clearBtn = currentEmail
        ? `<button class="csp-btn csp-btn--secondary" style="margin-top:8px" onclick="clearItemAssignee(${itemId})">Убрать исполнителя</button>`
        : '';

    openPopover('Исполнитель', `<div>${rows || '<p class="bl-empty">Нет пользователей</p>'}</div>${clearBtn}`);
};

window.pickItemAssignee = async function(itemId, el) {
    const email = el.dataset.email;
    const name  = el.dataset.name;
    await fetch(`/api/checklist/${itemId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assignee_email: email, assignee_name: name })
    });
    const itemEl = document.querySelector(`.cm-checklist-item[data-cl-id="${itemId}"]`);
    if (itemEl) {
        itemEl.dataset.assigneeEmail = email;
        renderItemAssigneeBadge(itemEl, name);
    }
    closePopover();
};

window.clearItemAssignee = async function(itemId) {
    await fetch(`/api/checklist/${itemId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assignee_email: '', assignee_name: '' })
    });
    const itemEl = document.querySelector(`.cm-checklist-item[data-cl-id="${itemId}"]`);
    if (itemEl) {
        itemEl.dataset.assigneeEmail = '';
        renderItemAssigneeBadge(itemEl, '');
    }
    closePopover();
};

function updateCardChecklistBar(cardDomId, checked, total) {
    const cardEl = document.getElementById(cardDomId);
    if (!cardEl) return;
    let bar = cardEl.querySelector('.card-checklist-bar');
    if (total === 0) { bar?.remove(); return; }
    if (!bar) {
        bar = document.createElement('div');
        bar.className = 'card-checklist-bar';
        bar.innerHTML = '<div class="card-checklist-bar-fill"></div>';
        cardEl.appendChild(bar);
    }
    const pct = Math.round((checked / total) * 100);
    bar.querySelector('.card-checklist-bar-fill').style.width = pct + '%';
}


// ===== CARD COVER =====

window.openCoverPopover = function() {
    const cardEl     = currentCardId ? document.getElementById(currentCardId) : null;
    const currentCover = cardEl?.querySelector('.card-cover')?.style.background || '';

    const colors = [
        '#de350b','#ff8b00','#f4d03f','#00875a','#0052cc',
        '#6554c0','#00b8d9','#172b4d','#5e6c84','#eb7443',
    ];
    const swatches = colors.map(c =>
        `<div class="pop-color${currentCover === c ? ' active' : ''}"
              style="background:${c}" data-color="${c}"
              onclick="applyCover('${c}')"></div>`
    ).join('');

    openPopover('Обложка', `
        <div class="csp-form-group">
            <label class="csp-label">Цвет обложки</label>
            <div class="pop-colors" style="flex-wrap:wrap;gap:8px">${swatches}</div>
        </div>
        <button class="csp-btn csp-btn--secondary" onclick="applyCover('')">Убрать обложку</button>
    `);
};

window.applyCover = async function(color) {
    if (!currentCardDbId) return;
    await fetch(`/api/cards/${currentCardDbId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cover_color: color })
    });
    updateCardCoverDOM(currentCardId, color);
    closePopover();
};

function updateCardCoverDOM(cardDomId, color) {
    const cardEl = document.getElementById(cardDomId);
    if (!cardEl) return;
    let cover = cardEl.querySelector('.card-cover');
    if (!color) { cover?.remove(); return; }
    if (!cover) {
        cover = document.createElement('div');
        cover.className = 'card-cover';
        cardEl.prepend(cover);
    }
    cover.style.background = color;
}


// ===== DUE DATE HIGHLIGHTING =====

function dueDateClass(dateStr) {
    if (!dateStr) return '';
    // Формат дд.мм.гггг
    const parts = dateStr.trim().split('.');
    if (parts.length !== 3) return '';
    const [d, m, y] = parts.map(Number);
    const due   = new Date(y, m - 1, d);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const diff  = (due - today) / 86400000;
    if (diff < 0)  return 'due--overdue';
    if (diff <= 1) return 'due--soon';
    return '';
}

function applyDueDateClasses() {
    document.querySelectorAll('.card-due').forEach(el => {
        const text = el.textContent.trim();
        el.className = 'card-due ' + dueDateClass(text);
    });
}

document.addEventListener('DOMContentLoaded', applyDueDateClasses);


// ===== ПРЯМАЯ ССЫЛКА НА КАРТОЧКУ (?card=) =====

document.addEventListener('DOMContentLoaded', function() {
    const cardId = new URLSearchParams(location.search).get('card');
    if (!cardId) return;
    const cardEl = document.querySelector(`.card[data-card-id="${cardId}"]`);
    if (cardEl) {
        cardEl.scrollIntoView({ block: 'center' });
        openCardModal(null, cardEl);
    } else {
        showToast('Карточка не найдена (возможно, в архиве или на другой доске)', 'error');
        // Убираем только card= — вид/фильтры из ссылки (Should №45) не трогаем
        const params = new URLSearchParams(location.search);
        params.delete('card');
        const qs = params.toString();
        history.replaceState(null, '', location.pathname + (qs ? `?${qs}` : ''));
    }
});


// ===== FILTER BAR =====

let activeFilters = { labels: new Set(), importance: new Set(), due: null, done: null, customFields: new Set(), members: new Set() };

window.toggleFiltersPanel = function() {
    const bar = document.getElementById('filterBar');
    if (!bar) return;
    const open = bar.style.display !== 'none';
    if (open) {
        bar.style.display = 'none';
        document.getElementById('btnFilters')?.classList.remove('btn-board-action--active');
    } else {
        buildLabelChips();
        buildImportanceChips();
        buildCustomFieldChips();
        buildMemberChips();
        renderSavedFilterChips();
        bar.style.display = '';
        document.getElementById('btnFilters')?.classList.add('btn-board-action--active');
    }
};

function buildLabelChips() {
    const labels = new Map();
    document.querySelectorAll('.card-label').forEach(el => {
        const text  = el.textContent.trim();
        const color = el.style.color;
        if (text && color) labels.set(text, color);
    });

    const container = document.getElementById('fbLabelChips');
    if (!container) return;
    container.innerHTML = '';

    if (!labels.size) {
        container.innerHTML = '<span class="fb-no-labels">Нет меток</span>';
        return;
    }
    labels.forEach((color, text) => {
        const btn = document.createElement('button');
        btn.className = 'fb-chip fb-chip--label';
        btn.dataset.filterLabel = text;
        btn.style.setProperty('--lc', color);
        btn.textContent = text;
        if (activeFilters.labels.has(text)) btn.classList.add('fb-chip--active');
        btn.onclick = () => {
            if (activeFilters.labels.has(text)) {
                activeFilters.labels.delete(text);
                btn.classList.remove('fb-chip--active');
            } else {
                activeFilters.labels.add(text);
                btn.classList.add('fb-chip--active');
            }
            applyFilters();
        };
        container.appendChild(btn);
    });
}

function buildImportanceChips() {
    const levels = new Map();
    document.querySelectorAll('.card-importance').forEach(el => {
        const text  = el.textContent.trim();
        const color = el.style.color;
        if (text && color) levels.set(text, color);
    });

    const container = document.getElementById('fbImportanceChips');
    if (!container) return;
    container.innerHTML = '';

    if (!levels.size) {
        container.innerHTML = '<span class="fb-no-labels">Нет важности</span>';
        return;
    }
    levels.forEach((color, text) => {
        const btn = document.createElement('button');
        btn.className = 'fb-chip fb-chip--label';
        btn.dataset.filterImportance = text;
        btn.style.setProperty('--lc', color);
        btn.textContent = text;
        if (activeFilters.importance.has(text)) btn.classList.add('fb-chip--active');
        btn.onclick = () => {
            if (activeFilters.importance.has(text)) {
                activeFilters.importance.delete(text);
                btn.classList.remove('fb-chip--active');
            } else {
                activeFilters.importance.add(text);
                btn.classList.add('fb-chip--active');
            }
            applyFilters();
        };
        container.appendChild(btn);
    });
}

function buildCustomFieldChips() {
    const combos = new Map();
    document.querySelectorAll('.card-cf-chip').forEach(el => {
        const name  = el.dataset.cfName;
        const value = el.dataset.cfValue;
        if (name && value) combos.set(`${name}::${value}`, { name, value });
    });

    const section   = document.getElementById('fbCustomFieldsSection');
    const container = document.getElementById('fbCustomFieldChips');
    if (!section || !container) return;
    container.innerHTML = '';

    if (!combos.size) { section.style.display = 'none'; return; }
    section.style.display = '';

    combos.forEach((info, key) => {
        const btn = document.createElement('button');
        btn.className   = 'fb-chip';
        btn.textContent  = `${info.name}: ${info.value}`;
        if (activeFilters.customFields.has(key)) btn.classList.add('fb-chip--active');
        btn.onclick = () => {
            if (activeFilters.customFields.has(key)) {
                activeFilters.customFields.delete(key);
                btn.classList.remove('fb-chip--active');
            } else {
                activeFilters.customFields.add(key);
                btn.classList.add('fb-chip--active');
            }
            applyFilters();
        };
        container.appendChild(btn);
    });
}

function buildMemberChips() {
    const members = new Map(); // email -> name
    document.querySelectorAll('.card[data-members]').forEach(card => {
        const raw = card.dataset.members;
        if (!raw) return;
        raw.split('|').forEach(pair => {
            const [email, name] = pair.split('::');
            if (email) members.set(email, name || email);
        });
    });

    const container = document.getElementById('fbMemberChips');
    if (!container) return;
    container.innerHTML = '';

    if (!members.size) {
        container.innerHTML = '<span class="fb-no-labels">Нет участников</span>';
        return;
    }
    members.forEach((name, email) => {
        const btn = document.createElement('button');
        btn.className = 'fb-chip';
        btn.dataset.filterMember = email;
        btn.textContent = name;
        if (activeFilters.members.has(email)) btn.classList.add('fb-chip--active');
        btn.onclick = () => {
            if (activeFilters.members.has(email)) {
                activeFilters.members.delete(email);
                btn.classList.remove('fb-chip--active');
            } else {
                activeFilters.members.add(email);
                btn.classList.add('fb-chip--active');
            }
            applyFilters();
        };
        container.appendChild(btn);
    });
}

window.toggleDueFilter = function(btn) {
    const val = btn.dataset.filterDue;
    if (activeFilters.due === val) {
        activeFilters.due = null;
        btn.classList.remove('fb-chip--active');
    } else {
        document.querySelectorAll('[data-filter-due]').forEach(b => b.classList.remove('fb-chip--active'));
        activeFilters.due = val;
        btn.classList.add('fb-chip--active');
    }
    applyFilters();
};

window.toggleDoneFilter = function(btn) {
    const val = btn.dataset.filterDone;
    if (activeFilters.done === val) {
        activeFilters.done = null;
        btn.classList.remove('fb-chip--active');
    } else {
        document.querySelectorAll('[data-filter-done]').forEach(b => b.classList.remove('fb-chip--active'));
        activeFilters.done = val;
        btn.classList.add('fb-chip--active');
    }
    applyFilters();
};

function applyFilters() {
    const { labels, importance, due, done, customFields, members } = activeFilters;
    const hasAny = labels.size > 0 || importance.size > 0 || due || done || customFields.size > 0 || members.size > 0;

    document.querySelectorAll('.card').forEach(card => {
        let show = true;

        if (labels.size > 0) {
            const cardLabelTexts = [...card.querySelectorAll('.card-label')].map(el => el.textContent.trim());
            show = show && cardLabelTexts.some(text => labels.has(text));
        }

        if (importance.size > 0) {
            const cardImportanceText = card.querySelector('.card-importance')?.textContent.trim() || '';
            show = show && importance.has(cardImportanceText);
        }

        if (members.size > 0) {
            const cardMemberEmails = (card.dataset.members || '').split('|')
                .map(pair => pair.split('::')[0]).filter(Boolean);
            show = show && cardMemberEmails.some(email => members.has(email));
        }

        if (customFields.size > 0) {
            const cardCfKeys = [...card.querySelectorAll('.card-cf-chip')]
                .map(el => `${el.dataset.cfName}::${el.dataset.cfValue}`);
            show = show && cardCfKeys.some(k => customFields.has(k));
        }

        if (due) {
            const dueEl  = card.querySelector('.card-due');
            const cls    = dueEl ? dueEl.className : '';
            if (due === 'overdue') show = show && cls.includes('due--overdue');
            if (due === 'today')   show = show && cls.includes('due--soon');
        }

        if (done === 'active') show = show && !card.classList.contains('card--done');
        if (done === 'done')   show = show && card.classList.contains('card--done');

        card.style.display = show ? '' : 'none';
    });

    document.getElementById('btnFilters')?.classList.toggle('btn-board-action--active', hasAny);

    document.querySelectorAll('.column').forEach(col => {
        const counter = col.querySelector('.column-count');
        const list    = col.querySelector('.cards-list');
        if (counter && list) {
            const visible = [...list.querySelectorAll('.card')].filter(c => c.style.display !== 'none').length;
            _setColumnCountDisplay(col, counter, visible);
        }
    });

    _syncBoardStateToURL();
}

window.clearFilters = function() {
    activeFilters = { labels: new Set(), importance: new Set(), due: null, done: null, customFields: new Set(), members: new Set() };
    document.querySelectorAll('.fb-chip').forEach(b => b.classList.remove('fb-chip--active'));
    document.querySelectorAll('.card').forEach(c => c.style.display = '');
    document.getElementById('btnFilters')?.classList.remove('btn-board-action--active');
    updateColumnCounts();
    _syncBoardStateToURL();
};


// ===== СОХРАНЁННЫЕ ФИЛЬТРЫ / УМНЫЕ СПИСКИ (Should №50) =====
// Хранятся в localStorage на доску — так же, как избранные доски (№12).
// В отличие от №45 (ссылка) — это именованные, локальные для пользователя пресеты,
// быстро доступные из панели фильтров без необходимости кому-то что-то присылать.

function _savedFiltersKey() {
    return `kanban_saved_filters_${_getBoardId()}`;
}

function _getSavedFilters() {
    try { return JSON.parse(localStorage.getItem(_savedFiltersKey()) || '[]'); }
    catch { return []; }
}

function _setSavedFilters(list) {
    localStorage.setItem(_savedFiltersKey(), JSON.stringify(list));
}

function renderSavedFilterChips() {
    const container = document.getElementById('fbSavedFilters');
    if (!container) return;
    const list = _getSavedFilters();
    if (!list.length) {
        container.innerHTML = '<span class="fb-no-labels">Нет сохранённых</span>';
        return;
    }
    container.innerHTML = list.map((preset, i) => `
        <span class="fb-chip fb-chip--preset" onclick="applySavedFilter(${i})">
            ${escHtml(preset.name)}
            <button class="fb-chip-del" onclick="deleteSavedFilter(event, ${i})" title="Удалить">✕</button>
        </span>
    `).join('');
}

window.saveCurrentFilterAsPreset = function() {
    const name = prompt('Название для этого набора фильтров и вида:');
    if (!name) return;
    const list = _getSavedFilters();
    list.push({
        name,
        view: _activeViewName() || 'kanban',
        labels: [...activeFilters.labels],
        importance: [...activeFilters.importance],
        due: activeFilters.due,
        done: activeFilters.done,
        members: [...activeFilters.members],
        customFields: [...activeFilters.customFields],
    });
    _setSavedFilters(list);
    renderSavedFilterChips();
    showToast('Фильтр сохранён');
};

window.applySavedFilter = function(idx) {
    const preset = _getSavedFilters()[idx];
    if (!preset) return;

    activeFilters = {
        labels: new Set(preset.labels || []),
        importance: new Set(preset.importance || []),
        due: preset.due || null,
        done: preset.done || null,
        members: new Set(preset.members || []),
        customFields: new Set(preset.customFields || []),
    };
    buildLabelChips();
    buildImportanceChips();
    buildCustomFieldChips();
    buildMemberChips();
    document.querySelectorAll('[data-filter-due]').forEach(b =>
        b.classList.toggle('fb-chip--active', b.dataset.filterDue === activeFilters.due));
    document.querySelectorAll('[data-filter-done]').forEach(b =>
        b.classList.toggle('fb-chip--active', b.dataset.filterDone === activeFilters.done));
    applyFilters();
    _switchBoardView(preset.view && _BOARD_VIEWS[preset.view] ? preset.view : 'kanban');
    showToast(`Применён фильтр «${preset.name}»`);
};

window.deleteSavedFilter = function(e, idx) {
    e.stopPropagation();
    const list = _getSavedFilters();
    list.splice(idx, 1);
    _setSavedFilters(list);
    renderSavedFilterChips();
};


// ===== COLUMN MENU =====

let colMenuTargetId = null;

let _colMenuDefaultHTML = null;

window.openColumnMenu = function(e, btn) {
    e.stopPropagation();
    const col = btn.closest('.column');
    colMenuTargetId = parseInt(col.dataset.colId);

    const dd = document.getElementById('colMenuDropdown');
    if (_colMenuDefaultHTML === null) _colMenuDefaultHTML = dd.innerHTML;
    dd.innerHTML = _colMenuDefaultHTML;

    const rect = btn.getBoundingClientRect();
    dd.style.top  = (rect.bottom + window.scrollY + 4) + 'px';
    dd.style.left = rect.left + 'px';
    dd.style.display = 'block';
};

window.colMenuReopen = function(e) {
    e?.stopPropagation();
    document.getElementById('colMenuDropdown').innerHTML = _colMenuDefaultHTML;
};

window.colMenuCopyToBoard = async function(e) {
    // Важно: клик на этот пункт переписывает innerHTML того же дропдауна, из-за чего
    // кликнутая кнопка «отсоединяется» от DOM ещё до того, как событие дойдёт до
    // document — общий обработчик «клик снаружи» ошибочно считает это кликом снаружи
    // и закрывает меню. stopPropagation() не даёт этому случиться.
    e?.stopPropagation();
    const dd = document.getElementById('colMenuDropdown');
    dd.innerHTML = '<div class="col-menu-item" style="color:#6b778c">Загрузка...</div>';

    const currentBoardId = parseInt(document.getElementById('boardColumns').dataset.boardId);
    let boards = [];
    try {
        const res = await fetch('/api/boards');
        boards = await res.json();
    } catch (err) {
        console.error('colMenuCopyToBoard error:', err);
    }

    const items = boards
        .filter(b => b.id !== currentBoardId)
        .map(b => `<button class="col-menu-item" onclick="colMenuDuplicateToBoard(${b.id}, '${escHtml(b.name).replace(/'/g, '&#39;')}', event)">${escHtml(b.name)}</button>`)
        .join('');
    const back = `<button class="col-menu-item" onclick="colMenuReopen(event)">← Назад</button>`;
    dd.innerHTML = back + (items || '<div class="col-menu-item" style="color:#6b778c">Нет других досок</div>');
};

window.colMenuDuplicateToBoard = async function(targetBoardId, targetBoardName, e) {
    e?.stopPropagation();
    document.getElementById('colMenuDropdown').style.display = 'none';
    const colId = colMenuTargetId;
    if (!colId) return;
    const res = await fetch(`/api/columns/${colId}/duplicate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_board_id: targetBoardId })
    });
    if (!res.ok) { showToast('Не удалось скопировать список', 'error'); return; }
    showToast(`Список скопирован на доску «${targetBoardName}»`);
};

document.addEventListener('click', function(e) {
    const dd = document.getElementById('colMenuDropdown');
    if (dd && dd.style.display !== 'none' && !dd.contains(e.target) && !e.target.closest('.column-menu-btn')) {
        dd.style.display = 'none';
    }
});

window.colMenuSort = function(type) {
    document.getElementById('colMenuDropdown').style.display = 'none';
    const col  = document.querySelector(`.column[data-col-id="${colMenuTargetId}"]`);
    const list = col?.querySelector('.cards-list');
    if (!list) return;

    const cards = Array.from(list.querySelectorAll(':scope > .card'));
    cards.sort(function(a, b) {
        if (type === 'name') {
            const ta = a.querySelector('.card-title')?.textContent.trim() || '';
            const tb = b.querySelector('.card-title')?.textContent.trim() || '';
            return ta.localeCompare(tb, 'ru');
        }
        if (type === 'due') {
            const da = a.querySelector('.card-due')?.textContent.trim() || '';
            const db = b.querySelector('.card-due')?.textContent.trim() || '';
            if (!da && !db) return 0;
            if (!da) return 1;
            if (!db) return -1;
            return da.localeCompare(db);
        }
        // created — по ID (отражает порядок создания)
        return parseInt(a.dataset.cardId) - parseInt(b.dataset.cardId);
    });

    cards.forEach(function(card) { list.appendChild(card); });
    showToast('Карточки отсортированы');
};

window.colMenuRename = function() {
    document.getElementById('colMenuDropdown').style.display = 'none';
    const col = document.querySelector(`.column[data-col-id="${colMenuTargetId}"]`);
    const h3  = col?.querySelector('.column-title');
    if (h3) startRenameColumn(h3);
};

window.colMenuSetWipLimit = async function() {
    document.getElementById('colMenuDropdown').style.display = 'none';
    const colId = colMenuTargetId;
    const col   = document.querySelector(`.column[data-col-id="${colId}"]`);
    if (!col) return;

    const current = parseInt(col.dataset.wipLimit || '0');
    const input = prompt('WIP-лимит для этой колонки (0 — без лимита):', current || '');
    if (input === null) return;
    const limit = Math.max(0, parseInt(input) || 0);

    const res = await fetch(`/api/columns/${colId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wip_limit: limit })
    });
    if (!res.ok) { showToast('Не удалось обновить лимит', 'error'); return; }

    col.dataset.wipLimit = limit;
    const counter = col.querySelector('.column-count');
    const list    = col.querySelector('.cards-list');
    if (counter && list) _setColumnCountDisplay(col, counter, list.querySelectorAll('.card').length);
    showToast(limit ? `Лимит установлен: ${limit}` : 'Лимит снят');
};

window.colMenuDuplicate = async function() {
    document.getElementById('colMenuDropdown').style.display = 'none';
    const colId = colMenuTargetId;
    if (!colId) return;

    const res = await fetch('/api/columns/' + colId + '/duplicate', { method: 'POST' });
    if (!res.ok) { showToast('Не удалось дублировать список', 'error'); return; }
    const data = await res.json();

    const col = document.createElement('div');
    col.className        = 'column';
    col.id                = 'column-' + data.id;
    col.dataset.colId     = data.id;
    col.dataset.wipLimit  = data.wip_limit || 0;
    col.innerHTML = `
        <div class="column-header">
            <button class="column-collapse-btn" onclick="toggleColumnCollapse(event, this)" title="Свернуть список">‹</button>
            <h3 class="column-title" onclick="startRenameColumn(this)"
                title="Нажмите для переименования">${escHtml(data.name)}</h3>
            <span class="column-count">0</span>
            <button class="column-menu-btn" onclick="openColumnMenu(event, this)" title="Меню">⋯</button>
        </div>
        <div class="cards-list" id="cards-${data.id}" data-col-id="${data.id}"></div>
        <div class="inline-add-card" id="inline-add-${data.id}" style="display:none">
            <textarea class="inline-card-input" id="inline-input-${data.id}"
                      placeholder="Название карточки..."
                      onkeydown="inlineCardKey(event, ${data.id})"></textarea>
            <div class="inline-add-actions">
                <button class="btn-primary btn-sm" onclick="inlineCardSave(${data.id})">Добавить карточку</button>
                <button class="inline-cancel-btn" onclick="inlineCardCancel(${data.id})">✕</button>
            </div>
        </div>
        <button class="btn-add-card" id="btn-add-${data.id}" onclick="addCard(${data.id})">
            <span>+</span> Добавить карточку
        </button>
    `;

    const srcCol = document.querySelector(`.column[data-col-id="${colId}"]`);
    if (srcCol) srcCol.after(col); else document.querySelector('.column--add').before(col);

    (data.cards || []).forEach(card => appendCardToDOM(card, data.id));

    new Sortable(col.querySelector('.cards-list'), {
        group: 'cards',
        animation: 150,
        ghostClass: 'sortable-ghost',
        dragClass: 'sortable-drag',
        delay: 300,
        delayOnTouchOnly: true,
        touchStartThreshold: 8,
        onEnd: () => { updateColumnCounts(); persistOrder(); }
    });

    updateColumnCounts();
    showToast('Список продублирован');
};

window.colMenuDelete = function() {
    document.getElementById('colMenuDropdown').style.display = 'none';
    const colId   = colMenuTargetId;
    const col     = document.querySelector(`.column[data-col-id="${colId}"]`);
    const name    = col?.querySelector('.column-title')?.textContent.trim() || 'список';
    if (!confirm(`Удалить список «${name}» со всеми карточками?`)) return;
    const parent  = col?.parentNode;
    const nextSib = col?.nextSibling;
    if (col) col.remove();
    updateColumnCounts();
    showUndoToast(`Список «${name}» отправлен в архив`,
        function() { fetch('/api/columns/' + colId, { method: 'DELETE' }); },
        function() { if (parent) parent.insertBefore(col, nextSib); updateColumnCounts(); }
    );
};


// ===== CARD MEMBERS POPOVER =====

window.openMembersPopover = async function() {
    if (!currentCardDbId) return;
    openPopover('Участники', '<div class="mp-loading">Загрузка...</div>');

    let cardMembers   = [];
    let boardMembers  = [];
    const boardId = _getBoardId();

    try {
        const [mRes, bRes] = await Promise.all([
            fetch(`/api/cards/${currentCardDbId}/members`),
            boardId ? fetch(`/api/boards/${boardId}/members`) : Promise.resolve(null)
        ]);
        if (mRes.ok) cardMembers  = await mRes.json();
        if (bRes && bRes.ok) boardMembers = await bRes.json();
    } catch (err) {
        console.error('openMembersPopover error:', err);
    }

    const assignedEmails = new Set(cardMembers.map(m => m.user_email));

    // Список кандидатов — участники доски (у кого есть доступ); если почему-то
    // не удалось загрузить — хотя бы показываем уже назначенных на карточку
    const users = boardMembers.length
        ? boardMembers
        : cardMembers.map(m => ({ email: m.user_email, name: m.user_name }));

    const body = document.getElementById('cspBody');
    body.innerHTML = '';

    if (!users.length) {
        body.innerHTML = '<p class="bl-empty">Нет пользователей с доступом к доске</p>';
        return;
    }

    users.forEach(u => {
        const email = u.email || u.user_email || '';
        const name  = u.name  || u.user_name  || email;
        const isAssigned = assignedEmails.has(email);

        const row = document.createElement('div');
        row.className = 'mp-user';

        const av = document.createElement('div');
        av.className = 'mp-avatar';
        av.textContent = (name || email || '?')[0].toUpperCase();

        const info = document.createElement('div');
        info.className = 'mp-info';
        info.innerHTML = `<span class="mp-name">${escHtml(name)}</span>
                          <span class="mp-email">${escHtml(email)}</span>`;

        row.appendChild(av);
        row.appendChild(info);

        const lbl    = document.createElement('label');
        lbl.className = 'mp-toggle';
        const chk    = document.createElement('input');
        chk.type     = 'checkbox';
        chk.checked  = isAssigned;
        chk.dataset.email = email;
        chk.dataset.name  = name;
        chk.onchange = function() {
            toggleCardMember(currentCardDbId, this.dataset.email, this.dataset.name, this.checked);
        };
        const slider = document.createElement('span');
        slider.className = 'mp-slider';
        lbl.appendChild(chk);
        lbl.appendChild(slider);
        row.appendChild(lbl);

        body.appendChild(row);
    });
};

window.toggleCardMember = async function(cardId, email, name, assign) {
    if (assign) {
        await fetch(`/api/cards/${cardId}/members`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ email, name })
        });
    } else {
        await fetch(`/api/cards/${cardId}/members/${encodeURIComponent(email)}`, { method: 'DELETE' });
    }
    if (currentCardDbId === cardId) renderCardMembersInMeta(cardId);

    const cardEl = document.getElementById('card-' + cardId);
    if (cardEl) {
        let pairs = (cardEl.dataset.members || '').split('|').filter(Boolean);
        pairs = pairs.filter(p => p.split('::')[0] !== email);
        if (assign) pairs.push(`${email}::${name || email}`);
        cardEl.dataset.members = pairs.join('|');
    }
};

async function renderCardMembersInMeta(cardId) {
    try {
        const res = await fetch(`/api/cards/${cardId}/members`);
        if (!res.ok) return;
        const members = await res.json();
        updateCardMembersMeta(members);
    } catch {}
}

function updateCardMembersMeta(members) {
    const meta = document.getElementById('cmMeta');
    if (!meta) return;
    meta.querySelector('.cm-members-row')?.remove();
    if (!members || !members.length) return;

    const row = document.createElement('div');
    row.className = 'cm-members-row';
    members.forEach(m => {
        const av = document.createElement('div');
        av.className = 'cm-member-av';
        av.title     = m.user_name || m.user_email;
        av.textContent = (m.user_name || m.user_email || '?')[0].toUpperCase();
        row.appendChild(av);
    });
    meta.appendChild(row);
}


// ===== BOARD SWITCHER =====

let _bsBoards = null;

window.openBoardSwitcher = async function(triggerBtn) {
    const panel = document.getElementById('boardSwitcherPanel');
    if (!panel) return;

    if (panel.style.display !== 'none') {
        panel.style.display = 'none';
        triggerBtn?.classList.remove('btn-board-action--active');
        return;
    }

    closeMembersPanel();
    triggerBtn?.classList.add('btn-board-action--active');
    panel.style.display = '';

    if (!_bsBoards) {
        document.getElementById('bsList').innerHTML = '<div class="mp-loading">Загрузка...</div>';
        try {
            const res = await fetch('/api/boards');
            _bsBoards = await res.json();
        } catch {
            document.getElementById('bsList').innerHTML = '<div class="mp-note">Ошибка загрузки</div>';
            return;
        }
    }

    renderBoardSwitcher(_bsBoards);
    setTimeout(() => document.getElementById('bsSearchInput')?.focus(), 50);
};

window.closeBoardSwitcher = function() {
    document.getElementById('boardSwitcherPanel').style.display = 'none';
    document.getElementById('btnBoardSwitcher')?.classList.remove('btn-board-action--active');
};

function renderBoardSwitcher(boards) {
    const currentBoardId = parseInt(document.getElementById('boardColumns').dataset.boardId);
    const list = document.getElementById('bsList');
    if (!boards || !boards.length) {
        list.innerHTML = '<div class="mp-note">Нет доступных досок</div>';
        return;
    }

    const groups = {};
    boards.forEach(b => {
        const ws = b.workspace_name || 'Без проекта';
        if (!groups[ws]) groups[ws] = [];
        groups[ws].push(b);
    });

    let html = '';
    Object.entries(groups).forEach(([ws, bds]) => {
        html += `<div class="bs-ws-header">${escHtml(ws)}</div>`;
        bds.forEach(b => {
            const isCurrent = b.id === currentBoardId;
            html += `<div class="bs-board-item${isCurrent ? ' bs-board-item--current' : ''}"
                          ${isCurrent ? '' : `onclick="location.href='/board/${b.id}'"`}>
                <div class="bs-board-color" style="background:${escHtml(b.color)}"></div>
                <span class="bs-board-name">${escHtml(b.name)}</span>
                ${isCurrent ? '<span class="bs-current-badge">текущая</span>' : ''}
            </div>`;
        });
    });
    list.innerHTML = html;
}

window.filterBoardSwitcher = function(query) {
    if (!_bsBoards) return;
    const q = query.trim().toLowerCase();
    const filtered = q ? _bsBoards.filter(b =>
        b.name.toLowerCase().includes(q) ||
        (b.workspace_name || '').toLowerCase().includes(q)
    ) : _bsBoards;
    renderBoardSwitcher(filtered);
};

// Закрываем switcher при клике вне панели
document.addEventListener('click', e => {
    const panel = document.getElementById('boardSwitcherPanel');
    if (panel && panel.style.display !== 'none' &&
        !panel.contains(e.target) &&
        !e.target.closest('#btnBoardSwitcher')) {
        closeBoardSwitcher();
    }
});

// Хоткей b — открыть switcher
document.addEventListener('keydown', e => {
    if (e.key !== 'b' || e.ctrlKey || e.metaKey || e.altKey) return;
    const tag = document.activeElement?.tagName;
    if (['INPUT', 'TEXTAREA'].includes(tag)) return;
    if (document.activeElement?.isContentEditable) return;
    openBoardSwitcher(document.getElementById('btnBoardSwitcher'));
});


// ===== BOARD LINK IN CARD =====

let _blBoards = null;

window.openBoardLinkPopover = async function() {
    openPopover('Связать доску', '<div class="mp-loading">Загрузка...</div>');

    if (!_blBoards) {
        try {
            const res = await fetch('/api/boards');
            _blBoards = await res.json();
        } catch {
            document.getElementById('cspBody').innerHTML = '<div class="mp-note">Ошибка загрузки</div>';
            return;
        }
    }

    const currentBoardId  = parseInt(document.getElementById('boardColumns').dataset.boardId);
    const currentLinkedId = parseInt(document.getElementById(currentCardId)?.dataset.linkedBoardId || '0');

    const options = _blBoards
        .filter(b => b.id !== currentBoardId)
        .map(b => {
            const isLinked = b.id === currentLinkedId;
            return `<div class="move-col-item${isLinked ? ' current-col' : ''}"
                         data-bl-id="${b.id}"
                         data-bl-name="${escHtml(b.name)}"
                         data-bl-color="${escHtml(b.color)}"
                         ${isLinked ? '' : 'onclick="pickBoardLink(this)"'}>
                <span class="bl-dot" style="background:${escHtml(b.color)}"></span>
                ${escHtml(b.name)}${isLinked ? ' ← выбрана' : ''}
            </div>`;
        }).join('');

    const body = document.getElementById('cspBody');
    body.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.innerHTML = options || '<p class="bl-empty">Нет других досок</p>';
    body.appendChild(wrap);
    if (currentLinkedId) {
        const clearBtn = document.createElement('button');
        clearBtn.className = 'csp-btn csp-btn--secondary';
        clearBtn.style.marginTop = '8px';
        clearBtn.textContent = 'Убрать ссылку';
        clearBtn.onclick = clearBoardLink;
        body.appendChild(clearBtn);
    }
};

window.pickBoardLink = function(el) {
    const id    = parseInt(el.dataset.blId);
    const name  = el.dataset.blName;
    const color = el.dataset.blColor;
    saveBoardLink(id, name, color);
};

window.saveBoardLink = async function(boardId, boardName, boardColor) {
    if (!currentCardDbId) return;
    await fetch(`/api/cards/${currentCardDbId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ linked_board_id: boardId })
    });

    const cardEl = document.getElementById(currentCardId);
    if (cardEl) {
        cardEl.dataset.linkedBoardId = boardId;
        if (!cardEl.querySelector('.card-board-badge')) {
            const badge = document.createElement('div');
            badge.className = 'card-board-badge';
            badge.title     = 'Связана с другой доской';
            badge.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg> Доска`;
            cardEl.appendChild(badge);
        }
    }

    updateBoardLinkMeta(boardId, boardName, boardColor);
    _blBoards = null;  // сбрасываем кэш на случай изменений
    closePopover();
};

window.clearBoardLink = async function() {
    if (!currentCardDbId) return;
    await fetch(`/api/cards/${currentCardDbId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ linked_board_id: null })
    });

    const cardEl = document.getElementById(currentCardId);
    if (cardEl) {
        cardEl.dataset.linkedBoardId = '';
        cardEl.querySelector('.card-board-badge')?.remove();
    }

    updateBoardLinkMeta(null, null, null);
    closePopover();
};

function updateBoardLinkMeta(boardId, boardName, boardColor) {
    const meta = document.getElementById('cmMeta');
    if (!meta) return;
    meta.querySelector('.cm-board-link')?.remove();
    if (!boardId || !boardName) return;

    const link = document.createElement('a');
    link.className = 'cm-board-link';
    link.href      = `/board/${boardId}`;
    link.target    = '_blank';
    link.title     = 'Открыть доску в новой вкладке';
    link.innerHTML = `<span class="cm-board-link-dot" style="background:${escHtml(boardColor)}"></span>${escHtml(boardName)}<span class="cm-board-link-arrow">↗</span>`;
    meta.appendChild(link);
}


// ===== UTILS =====

function escHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g,'&amp;')
        .replace(/</g,'&lt;')
        .replace(/>/g,'&gt;')
        .replace(/"/g,'&quot;');
}


// ===== ПРОФИЛЬ ПОЛЬЗОВАТЕЛЯ =====

let _profileColor = document.querySelector('#userAvatarBtn')?.dataset.color || '#4361EE';

window.toggleProfileDropdown = function(e) {
    e.stopPropagation();
    const dd  = document.getElementById('profileDropdown');
    const btn = document.getElementById('userAvatarBtn');
    if (!dd || !btn) return;
    const rect   = btn.getBoundingClientRect();
    const isOpen = dd.classList.contains('profile-dropdown--open');
    if (!isOpen) {
        dd.style.top   = (rect.bottom + window.scrollY + 6) + 'px';
        dd.style.right = (window.innerWidth - rect.right) + 'px';
    }
    dd.classList.toggle('profile-dropdown--open', !isOpen);
};

window.closeProfileDropdown = function() {
    document.getElementById('profileDropdown')?.classList.remove('profile-dropdown--open');
};

document.addEventListener('click', e => {
    if (!e.target.closest('#profileDropdown') && !e.target.closest('#userAvatarBtn')) {
        closeProfileDropdown();
    }
});

window.openProfileModal = function() {
    document.getElementById('profileModal').style.display = 'flex';
};

window.closeProfileModal = function() {
    document.getElementById('profileModal').style.display = 'none';
    document.getElementById('pmMsg').textContent    = '';
    document.getElementById('pmPwdMsg').textContent = '';
};

window.handleProfileOverlayClick = function(e) {
    if (e.target === document.getElementById('profileModal')) closeProfileModal();
};

window.selectAvatarColor = function(c) {
    _profileColor = c;
    document.querySelectorAll('.pm-color-swatch').forEach(s =>
        s.classList.toggle('pm-color-swatch--active', s.dataset.color === c)
    );
    const el = document.getElementById('pmAvatarInitials');
    if (el) el.style.background = c;
};

function _showProfileMsg(id, text, ok) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    el.style.color = ok ? '#00875a' : '#de350b';
}

window.saveProfile = async function() {
    const name = (document.getElementById('pmNameInput')?.value || '').trim();
    if (!name) return _showProfileMsg('pmMsg', 'Имя не может быть пустым', false);
    const res  = await fetch('/api/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, avatar_color: _profileColor })
    });
    const data = await res.json();
    if (!res.ok) return _showProfileMsg('pmMsg', data.error || 'Ошибка', false);
    _showProfileMsg('pmMsg', 'Сохранено', true);
    document.getElementById('pdName').textContent = data.name;
    document.querySelectorAll('.ua-initials').forEach(el => {
        el.textContent   = data.name[0].toUpperCase();
        el.style.background = data.avatar_color;
    });
};

window.changePassword = async function() {
    const cur = document.getElementById('pmCurrentPwd')?.value || '';
    const nw  = document.getElementById('pmNewPwd')?.value || '';
    if (!cur || !nw) return _showProfileMsg('pmPwdMsg', 'Заполните оба поля', false);
    if (nw.length < 4) return _showProfileMsg('pmPwdMsg', 'Пароль слишком короткий', false);
    const res  = await fetch('/api/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ current_password: cur, new_password: nw })
    });
    const data = await res.json();
    if (!res.ok) return _showProfileMsg('pmPwdMsg', data.error || 'Ошибка', false);
    _showProfileMsg('pmPwdMsg', 'Пароль изменён', true);
    document.getElementById('pmCurrentPwd').value = '';
    document.getElementById('pmNewPwd').value     = '';
};

window.uploadProfilePhoto = async function(input) {
    const file = input.files[0];
    if (!file) return;
    const form = new FormData();
    form.append('photo', file);
    const res  = await fetch('/api/profile/photo', { method: 'POST', body: form });
    const data = await res.json();
    if (!res.ok) return _showProfileMsg('pmMsg', data.error || 'Ошибка загрузки', false);
    const img = `<img src="${escHtml(data.photo_url)}" class="ua-photo" alt="">`;
    document.getElementById('pmAvatarPreview').innerHTML  = img;
    document.getElementById('pdAvatarPreview').innerHTML  = img;
    document.getElementById('userAvatarBtn').innerHTML    = img;
    const rm = document.getElementById('pmRemovePhotoBtn');
    if (rm) rm.style.display = '';
};

window.removeProfilePhoto = async function() {
    const res = await fetch('/api/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ remove_photo: true })
    });
    if (!res.ok) return;
    const color   = _profileColor;
    const initial = (document.getElementById('pmNameInput')?.value || 'U')[0].toUpperCase();
    const span    = `<span class="ua-initials" id="pmAvatarInitials" style="background:${color}">${escHtml(initial)}</span>`;
    document.getElementById('pmAvatarPreview').innerHTML = span;
    document.getElementById('pdAvatarPreview').innerHTML = `<span class="ua-initials" style="background:${color}">${escHtml(initial)}</span>`;
    document.getElementById('userAvatarBtn').innerHTML   = `<span class="ua-initials" style="background:${color}">${escHtml(initial)}</span>`;
    const rm = document.getElementById('pmRemovePhotoBtn');
    if (rm) rm.style.display = 'none';
};

// ===== НАСТРОЙКИ ДОСКИ =====

let _boardColor = '';

function _getBoardId() {
    return parseInt(document.getElementById('boardColumns')?.dataset.boardId || '0');
}

window.openBoardSettings = function(btn) {
    const panel = document.getElementById('boardSettingsPanel');
    if (!panel) return;
    const isOpen = panel.style.display !== 'none';
    // Закрываем другие панели
    const mp = document.getElementById('membersPanel');
    const fb = document.getElementById('filterBar');
    const bs = document.getElementById('boardSwitcherPanel');
    if (mp) mp.style.display = 'none';
    if (fb) fb.style.display = 'none';
    if (bs) bs.style.display = 'none';
    document.querySelectorAll('.btn-board-action').forEach(b => b.classList.remove('active'));
    if (isOpen) { panel.style.display = 'none'; return; }
    panel.style.display = 'block';
    if (btn) btn.classList.add('active');
    // Инициализируем текущий цвет
    const active = document.querySelector('.bsp-color-swatch--active');
    _boardColor = active ? active.dataset.color
        : (document.getElementById('bspColorCustom')?.value || '#0052cc');
};

window.closeBoardSettings = function() {
    const panel = document.getElementById('boardSettingsPanel');
    if (panel) panel.style.display = 'none';
    document.getElementById('btnBoardSettings')?.classList.remove('active');
};

window.selectBoardColor = function(c) {
    _boardColor = c;
    document.querySelectorAll('.bsp-color-swatch').forEach(s =>
        s.classList.toggle('bsp-color-swatch--active', s.dataset.color === c)
    );
    const custom = document.getElementById('bspColorCustom');
    if (custom) custom.value = (c.startsWith('#') && c.length === 7) ? c : custom.value;
};

window.saveBoardSettings = function() {
    const boardId = _getBoardId();
    if (!boardId) return;
    const name  = document.getElementById('bspNameInput')?.value.trim();
    const color = _boardColor || document.getElementById('bspColorCustom')?.value || '';
    if (!name && !color) return;

    fetch(`/api/boards/${boardId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, color })
    }).then(r => r.json()).then(data => {
        if (!data.ok) {
            showBspMsg(data.error || 'Ошибка', true);
            return;
        }
        showBspMsg('Сохранено');
        // Обновляем название в breadcrumb
        const bcName = document.querySelector('.board-bc-name');
        if (bcName && data.name) bcName.textContent = data.name;
        document.title = data.name + ' — Almaly Kanban';
        // Обновляем CSS-переменную и цвет навбара
        if (data.color) {
            document.querySelector('.board-page')?.style.setProperty('--bcolor', data.color);
            const nav = document.querySelector('.navbar--board');
            if (nav && !document.querySelector('.board-page').style.backgroundImage) {
                nav.style.background = data.color + 'cc';
            }
        }
    }).catch(() => showBspMsg('Ошибка сети', true));
};

window.saveBoardAsTemplate = async function() {
    const boardId = _getBoardId();
    if (!boardId) return;
    const input = document.getElementById('bspTemplateNameInput');
    const name  = input?.value.trim();
    if (!name) { showBspMsg('Введите название шаблона', true); return; }

    const res = await fetch(`/api/boards/${boardId}/save-as-template`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
    });
    if (!res.ok) { showBspMsg('Не удалось сохранить шаблон', true); return; }
    input.value = '';
    showBspMsg('Шаблон доски сохранён');
};

window.uploadBoardBackground = async function(input) {
    const boardId = _getBoardId();
    if (!boardId || !input.files[0]) return;
    const fd = new FormData();
    fd.append('file', input.files[0]);
    const res  = await fetch(`/api/boards/${boardId}/background`, { method: 'POST', body: fd });
    const data = await res.json();
    if (!data.ok) { showBspMsg(data.error || 'Ошибка загрузки', true); return; }

    // Показываем превью в панели
    const preview = document.getElementById('bspBgPreview');
    const img = preview?.querySelector('img') || document.createElement('img');
    img.id  = 'bspBgImg';
    img.src = data.bg_url + '?t=' + Date.now();
    if (!preview.querySelector('img')) preview.appendChild(img);
    preview.style.display = '';
    document.getElementById('bspUploadLabel').style.display = 'none';

    // Применяем фон на страницу
    const page = document.querySelector('.board-page');
    if (page) {
        page.style.backgroundImage = `url('${data.bg_url}')`;
        page.style.backgroundSize = 'cover';
        page.style.backgroundPosition = 'center';
        page.style.backgroundAttachment = 'fixed';
    }
    // Затемнение
    let overlay = document.getElementById('boardBgOverlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'boardBgOverlay';
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.38);z-index:0;pointer-events:none;';
        document.body.appendChild(overlay);
    }
    // Тёмный navbar
    const nav = document.querySelector('.navbar--board');
    if (nav) { nav.style.background = 'rgba(0,0,0,0.48)'; nav.style.backdropFilter = 'blur(14px)'; }
    showBspMsg('Фон загружен');
    input.value = '';
};


// ===== ARCHIVE PANEL =====

window.openArchivePanel = async function() {
    const panel = document.getElementById('archivePanel');
    panel.style.display = 'flex';
    const list = document.getElementById('archiveList');
    list.innerHTML = '<div class="ap-loading">Загрузка...</div>';

    const boardId = _getBoardId();
    const res  = await fetch(`/api/archive?board_id=${boardId}`);
    const data = await res.json();

    if (!data.length) {
        list.innerHTML = '<p class="ap-empty">Архив пуст</p>';
        return;
    }

    list.innerHTML = data.map(function(item) {
        const color    = item.board_color || '#4361EE';
        const date     = item.archived_at ? item.archived_at.slice(0, 10) : '';
        const isColumn = item.type === 'column';
        const meta     = isColumn
            ? `${escHtml(item.board_name)} · список${date ? ' · ' + date : ''}`
            : `${escHtml(item.board_name)} · ${escHtml(item.column_name)}${date ? ' · ' + date : ''}`;
        const restoreCall = isColumn ? `restoreColumn(${item.id})` : `restoreCard(${item.id})`;
        return `<div class="ap-item" id="ap-${item.type}-${item.id}">
            <div class="ap-item-info">
                <span class="ap-dot" style="background:${color}"></span>
                <div class="ap-item-text">
                    <span class="ap-item-title">${isColumn ? '📋 ' : ''}${escHtml(item.title)}</span>
                    <span class="ap-item-meta">${meta}</span>
                </div>
            </div>
            <button class="ap-restore-btn" onclick="${restoreCall}">Восстановить</button>
        </div>`;
    }).join('');
};

window.closeArchivePanel = function() {
    document.getElementById('archivePanel').style.display = 'none';
};

window.restoreCard = async function(cardId) {
    const res = await fetch('/api/cards/' + cardId + '/restore', { method: 'POST' });
    if (!res.ok) return;
    const el = document.getElementById('ap-card-' + cardId);
    if (el) el.remove();
    const list = document.getElementById('archiveList');
    if (list && !list.querySelector('.ap-item')) {
        list.innerHTML = '<p class="ap-empty">Архив пуст</p>';
    }
    showToast('Карточка восстановлена', 'success');
};

window.restoreColumn = async function(colId) {
    const res = await fetch('/api/columns/' + colId + '/restore', { method: 'POST' });
    if (!res.ok) return;
    const el = document.getElementById('ap-column-' + colId);
    if (el) el.remove();
    const list = document.getElementById('archiveList');
    if (list && !list.querySelector('.ap-item')) {
        list.innerHTML = '<p class="ap-empty">Архив пуст</p>';
    }
    showToast('Список восстановлен', 'success');
};

function escHtml(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

window.removeBoardBackground = async function() {
    const boardId = _getBoardId();
    if (!boardId) return;
    const res  = await fetch(`/api/boards/${boardId}/background`, { method: 'DELETE' });
    const data = await res.json();
    if (!data.ok) { showBspMsg(data.error || 'Ошибка', true); return; }

    // Убираем фон со страницы
    const page = document.querySelector('.board-page');
    if (page) { page.style.backgroundImage = ''; }
    const overlay = document.getElementById('boardBgOverlay');
    if (overlay) overlay.remove();
    // Восстанавливаем цвет navbar
    const nav = document.querySelector('.navbar--board');
    const bcolor = getComputedStyle(document.querySelector('.board-page') || document.body)
        .getPropertyValue('--bcolor').trim() || '#0052cc';
    if (nav) { nav.style.background = bcolor + 'cc'; nav.style.backdropFilter = 'blur(8px)'; }

    // Скрываем превью, показываем кнопку загрузки
    const preview = document.getElementById('bspBgPreview');
    if (preview) preview.style.display = 'none';
    const uploadLabel = document.getElementById('bspUploadLabel');
    if (uploadLabel) uploadLabel.style.display = '';
    showBspMsg('Фон удалён');
};

// --- Кастомные поля (управление в настройках доски) ---
const CF_TYPE_LABELS = { text: 'Текст', number: 'Число', date: 'Дата', list: 'Список', checkbox: 'Чекбокс' };

window.onCfTypeChange = function() {
    const type = document.getElementById('bspCfTypeInput').value;
    document.getElementById('bspCfOptionsInput').style.display = type === 'list' ? '' : 'none';
};

window.addCustomField = async function() {
    const boardId   = _getBoardId();
    const nameInput = document.getElementById('bspCfNameInput');
    const typeInput = document.getElementById('bspCfTypeInput');
    const optsInput = document.getElementById('bspCfOptionsInput');
    const name = nameInput.value.trim();
    const type = typeInput.value;
    if (!name) { showToast('Введите название поля', 'error'); return; }
    const options = type === 'list'
        ? optsInput.value.split(',').map(s => s.trim()).filter(Boolean)
        : [];
    const res = await fetch(`/api/boards/${boardId}/custom-fields`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, type, options })
    });
    const field = await res.json();
    appendCfItemToSettings(field);
    nameInput.value = '';
    optsInput.value = '';
    optsInput.style.display = 'none';
    typeInput.value = 'text';
    showToast('Поле добавлено');
};

function appendCfItemToSettings(field) {
    const list = document.getElementById('bspCfList');
    if (!list) return;
    const item = document.createElement('div');
    item.className = 'bsp-cf-item';
    item.dataset.cfId = field.id;
    item.innerHTML = `
        <span class="bsp-cf-name"></span>
        <span class="bsp-cf-type"></span>
        <label class="bsp-cf-toggle">
            <input type="checkbox" onchange="toggleCustomFieldShowOnCard(${field.id}, this.checked)">
            на карточке
        </label>
        <button class="bsp-cf-delete" onclick="deleteCustomField(${field.id}, this)" title="Удалить поле">✕</button>
    `;
    item.querySelector('.bsp-cf-name').textContent = field.name;
    item.querySelector('.bsp-cf-type').textContent = CF_TYPE_LABELS[field.type] || field.type;
    list.appendChild(item);
}

window.toggleCustomFieldShowOnCard = async function(fieldId, checked) {
    await fetch(`/api/custom-fields/${fieldId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ show_on_card: checked })
    });
    showToast(checked ? 'Поле будет видно на карточках после обновления страницы' : 'Поле скрыто с карточек после обновления страницы');
};

window.deleteCustomField = async function(fieldId, btn) {
    if (!confirm('Удалить это поле? Значения на всех карточках доски будут потеряны.')) return;
    await fetch(`/api/custom-fields/${fieldId}`, { method: 'DELETE' });
    btn.closest('.bsp-cf-item')?.remove();
    showToast('Поле удалено');
};

function showBspMsg(text, isError) {
    const el = document.getElementById('bspMsg');
    if (!el) return;
    el.textContent = text;
    el.className = 'bsp-msg' + (isError ? ' error' : '');
    setTimeout(() => { if (el.textContent === text) el.textContent = ''; }, 3000);
}
