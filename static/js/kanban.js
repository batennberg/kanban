// ===== DRAG-AND-DROP (карточки) =====

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


// ===== DRAG-AND-DROP (колонки) =====

new Sortable(document.getElementById('boardColumns'), {
    animation: 200,
    handle: '.column-header',
    draggable: '.column:not(.column--add)',
    ghostClass: 'column-ghost',
    dragClass: 'column-dragging',
    onEnd: persistColumnOrder,
});

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
        if (counter && list) counter.textContent = list.querySelectorAll('.card').length;
    });
}

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
    el.onclick      = (e) => openCardModal(e, el);

    let html = `<button class="card-check-btn" onclick="toggleComplete(event, this)" title="Отметить выполненной">✓</button>`;
    html += `<button class="card-edit-btn" onclick="openQuickEdit(event, this)" title="Быстрое редактирование">✎</button>`;
    if (card.label) {
        const c = card.label_color || '#0052cc';
        html += `<span class="card-label" style="background:${c}20;color:${c};border:1px solid ${c}40">${escHtml(card.label)}</span>`;
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
    col.className     = 'column';
    col.id            = 'column-' + colId;
    col.dataset.colId = colId;
    col.innerHTML = `
        <div class="column-header">
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

    // Populate from DOM (instant — без задержки)
    const titleEl = cardEl.querySelector('.card-title');
    const labelEl = cardEl.querySelector('.card-label');
    const dueEl   = cardEl.querySelector('.card-due');

    document.getElementById('cmTitle').textContent = titleEl ? titleEl.textContent : '';

    const col      = cardEl.closest('.column');
    document.getElementById('cmColName').textContent = col ? col.querySelector('.column-title').textContent : '';

    const meta = document.getElementById('cmMeta');
    meta.innerHTML = '';
    if (labelEl) {
        const b = document.createElement('span');
        b.className = 'card-label';
        b.style.cssText = labelEl.style.cssText;
        b.textContent   = labelEl.textContent;
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
    renderComments([]);
    renderChecklist([]);
    updateCardMembersMeta([]);
    document.getElementById('cmChecklistSection').style.display = 'none';
    document.getElementById('cmCommentsEmpty').style.display = 'block';

    closePopover();
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
        renderAttachments(data.attachments || []);
        renderChecklist(data.checklist || []);
        // Показываем cover в modal-header если есть
        const coverColor = data.cover_color || '';
        const modalEl    = document.querySelector('.card-modal');
        if (modalEl) modalEl.style.setProperty('--card-cover', coverColor ? coverColor : 'transparent');

        // Участники карточки
        updateCardMembersMeta(data.members || []);

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

// --- Описание (Markdown) ---
function renderDescriptionView(text) {
    const view = document.getElementById('cmDescriptionView');
    if (!text || !text.trim()) {
        view.innerHTML = '<span class="cm-description-empty">Добавьте подробное описание задачи...</span>';
        return;
    }
    view.innerHTML = DOMPurify.sanitize(marked.parse(text));
}

window.editDescription = function() {
    document.getElementById('cmDescriptionView').style.display = 'none';
    const ta = document.getElementById('cmDescription');
    ta.style.display = 'block';
    ta.focus();
};

window.finishDescriptionEdit = function() {
    const ta = document.getElementById('cmDescription');
    renderDescriptionView(ta.value);
    ta.style.display = 'none';
    document.getElementById('cmDescriptionView').style.display = 'block';
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
            if (res.ok) appendAttachmentToDOM(await res.json());
        } catch (err) {
            console.error('Ошибка загрузки файла', err);
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


// ===== COMMENTS =====

window.showCommentActions = () => {
    document.getElementById('cmCommentActions').style.display = 'flex';
};

window.cancelComment = () => {
    document.getElementById('cmCommentInput').value = '';
    document.getElementById('cmCommentActions').style.display = 'none';
    document.getElementById('cmCommentInput').blur();
};

window.submitComment = async function() {
    const text = document.getElementById('cmCommentInput').value.trim();
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
    } finally {
        btn.disabled = false;
    }
};

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
            <p class="cm-comment-text">${escHtml(c.text).replace(/\n/g,'<br>')}</p>
        </div>
    `;
    document.getElementById('cmCommentsList').appendChild(item);
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
document.getElementById('cmCommentInput').addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.ctrlKey) submitComment();
});


// ===== SIDEBAR POPOVER =====

let selectedPopColor = '#0052cc';

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

// --- Метка ---
window.openLabelPopover = function() {
    const labelEl     = document.getElementById('cmMeta')?.querySelector('.card-label');
    const currentText = labelEl ? labelEl.textContent.trim() : '';
    const currentColor = labelEl ? labelEl.style.color : '#0052cc';
    selectedPopColor  = currentColor || '#0052cc';

    const palette = ['#0052cc','#6554c0','#00875a','#de350b','#ff8b00','#00b8d9'];
    const swatches = palette.map(c =>
        `<div class="pop-color${c === selectedPopColor ? ' active' : ''}"
              style="background:${c}" data-color="${c}"
              onclick="selectPopColor(this)"></div>`
    ).join('');

    openPopover('Метка', `
        <div class="csp-form-group">
            <label class="csp-label">Название</label>
            <input class="csp-input" id="popLabelText" type="text"
                   value="${escHtml(currentText)}" placeholder="Разработка, Сеть...">
        </div>
        <div class="csp-form-group">
            <label class="csp-label">Цвет</label>
            <div class="pop-colors">${swatches}</div>
        </div>
        <button class="csp-btn csp-btn--primary"   onclick="applyLabel()">Сохранить</button>
        <button class="csp-btn csp-btn--secondary"  onclick="clearLabel()">Убрать метку</button>
    `);
    setTimeout(() => document.getElementById('popLabelText')?.focus(), 50);
};

window.selectPopColor = el => {
    document.querySelectorAll('.pop-color').forEach(e => e.classList.remove('active'));
    el.classList.add('active');
    selectedPopColor = el.dataset.color;
};

window.applyLabel = async function() {
    const text  = document.getElementById('popLabelText').value.trim();
    const color = selectedPopColor;
    if (!currentCardDbId) return;
    await fetch(`/api/cards/${currentCardDbId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: text, label_color: color })
    });
    updateModalLabel(text, color);
    updateCardLabel(currentCardId, text, color);
    closePopover();
};

window.clearLabel = async function() {
    if (!currentCardDbId) return;
    await fetch(`/api/cards/${currentCardDbId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: '', label_color: '' })
    });
    updateModalLabel('', '');
    updateCardLabel(currentCardId, '', '');
    closePopover();
};

function updateModalLabel(text, color) {
    const meta = document.getElementById('cmMeta');
    meta.querySelector('.card-label')?.remove();
    if (text) {
        const badge = document.createElement('span');
        badge.className = 'card-label';
        badge.style.cssText = `background:${color}20;color:${color};border:1px solid ${color}40`;
        badge.textContent = text;
        const due = meta.querySelector('.cm-due-badge');
        meta.insertBefore(badge, due || null);
    }
}

function updateCardLabel(cardDomId, text, color) {
    const cardEl = document.getElementById(cardDomId);
    if (!cardEl) return;
    cardEl.querySelector('.card-label')?.remove();
    if (text) {
        const span = document.createElement('span');
        span.className = 'card-label';
        span.style.cssText = `background:${color}20;color:${color};border:1px solid ${color}40`;
        span.textContent = text;
        const checkBtn = cardEl.querySelector('.card-check-btn');
        checkBtn ? checkBtn.after(span) : cardEl.prepend(span);
    }
}

// --- Срок — мини-календарь ---
const _cal = { year: 0, month: 0, selected: '' };
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
        ${selected ? `<button class="csp-btn csp-btn--secondary" style="margin-top:10px" onclick="clearDueDate()">Убрать срок</button>` : ''}
    </div>`;
}

function _calRefresh() {
    const body = document.getElementById('cspBody');
    if (body) body.innerHTML = _calBuild();
}

window.openDueDatePopover = function() {
    const dueEl = document.getElementById('cmMeta')?.querySelector('.cm-due-badge');
    const currentDue = dueEl ? (dueEl.dataset.due || '') : '';
    const now = new Date();
    let iy = now.getFullYear(), im = now.getMonth();
    if (currentDue) {
        const [, mm, yy] = currentDue.split('.').map(Number);
        if (!isNaN(yy)) { iy = yy; im = mm - 1; }
    }
    _cal.year = iy; _cal.month = im; _cal.selected = currentDue;
    openPopover('Срок', _calBuild());
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
    if (!currentCardDbId) return;
    await fetch(`/api/cards/${currentCardDbId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ due_date: due })
    });
    updateModalDue(due);
    updateCardDue(currentCardId, due);
    setTimeout(closePopover, 260);
};

window.clearDueDate = async function() {
    if (!currentCardDbId) return;
    await fetch(`/api/cards/${currentCardDbId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ due_date: '' })
    });
    updateModalDue('');
    updateCardDue(currentCardId, '');
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
    const list = document.getElementById('mpList');
    list.innerHTML = '<div class="mp-loading">Загрузка...</div>';

    const boardEl = document.getElementById('boardColumns');
    const boardId = parseInt(boardEl?.dataset.boardId || '0');
    const isAdmin = boardEl?.dataset.userRole === 'admin';

    try {
        const res = await fetch(`/api/boards/${boardId}/access`);
        if (!res.ok) {
            list.innerHTML = '<div class="mp-note">Только администратор может управлять участниками.</div>';
            return;
        }
        const users = await res.json();
        if (!users.length) {
            list.innerHTML = '<div class="mp-note">Нет пользователей в системе.</div>';
            return;
        }
        list.innerHTML = users.map(u => {
            const avatar = (u.name || u.email || '?')[0].toUpperCase();
            return `<div class="mp-user">
                <div class="mp-avatar">${escHtml(avatar)}</div>
                <div class="mp-info">
                    <span class="mp-name">${escHtml(u.name || u.email)}</span>
                    <span class="mp-email">${escHtml(u.email)}</span>
                </div>
                ${isAdmin ? `
                <label class="mp-toggle">
                    <input type="checkbox" ${u.has_access ? 'checked' : ''}
                           onchange="toggleMemberAccess(${boardId}, ${u.id}, this.checked)">
                    <span class="mp-slider"></span>
                </label>` : (u.has_access ? '<span class="mp-check">✓</span>' : '')}
            </div>`;
        }).join('');
    } catch (err) {
        console.error('Members panel error:', err);
        list.innerHTML = '<div class="mp-note">Ошибка загрузки участников.</div>';
    }
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


// ===== CHECKLIST =====

window.toggleChecklist = function() {
    const sec = document.getElementById('cmChecklistSection');
    if (!sec) return;
    const isHidden = sec.style.display === 'none';
    sec.style.display = isHidden ? '' : 'none';
    if (isHidden) document.getElementById('cmChecklistInput')?.focus();
};

function renderChecklist(items) {
    const container = document.getElementById('cmChecklistItems');
    const section   = document.getElementById('cmChecklistSection');
    if (!container) return;

    container.innerHTML = '';
    if (items && items.length > 0) {
        section.style.display = '';
    }

    (items || []).forEach(item => appendChecklistItemToDOM(item));
    updateChecklistProgress();
}

function appendChecklistItemToDOM(item) {
    const container = document.getElementById('cmChecklistItems');
    const div = document.createElement('div');
    div.className = 'cm-checklist-item' + (item.checked ? ' cl-done' : '');
    div.dataset.clId = item.id;

    div.innerHTML = `
        <input class="cm-cl-check" type="checkbox" ${item.checked ? 'checked' : ''}
               onchange="toggleChecklistItem(${item.id}, this)">
        <span class="cm-cl-text"
              onclick="startEditChecklistItem(this)"
              title="Нажмите для редактирования">${escHtml(item.text)}</span>
        <button class="cm-cl-del" onclick="deleteChecklistItem(${item.id})" title="Удалить">✕</button>
    `;
    container.appendChild(div);
    updateChecklistProgress();
}

function updateChecklistProgress() {
    const items   = document.querySelectorAll('.cm-checklist-item');
    const done    = document.querySelectorAll('.cm-checklist-item.cl-done');
    const total   = items.length;
    const checked = done.length;
    const pct     = total ? Math.round((checked / total) * 100) : 0;

    const bar  = document.getElementById('cmChecklistBar');
    const text = document.getElementById('cmChecklistProgressText');
    if (bar)  bar.style.width = pct + '%';
    if (text) text.textContent = total ? `${checked}/${total}` : '';

    // Обновляем прогресс-бар на превью карточки
    if (currentCardId) updateCardChecklistBar(currentCardId, checked, total);
}

window.submitChecklistItem = async function() {
    const input = document.getElementById('cmChecklistInput');
    const text  = input?.value.trim();
    if (!text || !currentCardDbId) return;

    const res  = await fetch(`/api/cards/${currentCardDbId}/checklist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text })
    });
    if (res.ok) {
        appendChecklistItemToDOM(await res.json());
        input.value = '';
        input.focus();
        document.getElementById('cmChecklistSection').style.display = '';
    }
};

window.toggleChecklistItem = async function(itemId, checkbox) {
    const item = checkbox.closest('.cm-checklist-item');
    const checked = checkbox.checked ? 1 : 0;
    item.classList.toggle('cl-done', !!checked);

    await fetch(`/api/checklist/${itemId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ checked })
    });
    updateChecklistProgress();
};

window.deleteChecklistItem = async function(itemId) {
    const item = document.querySelector(`[data-cl-id="${itemId}"]`);
    if (!item) return;
    item.remove();
    await fetch(`/api/checklist/${itemId}`, { method: 'DELETE' });
    updateChecklistProgress();
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

document.getElementById('cmChecklistInput')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') submitChecklistItem();
});

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


// ===== FILTER BAR =====

let activeFilters = { labels: new Set(), due: null, done: null };

window.toggleFiltersPanel = function() {
    const bar = document.getElementById('filterBar');
    if (!bar) return;
    const open = bar.style.display !== 'none';
    if (open) {
        bar.style.display = 'none';
        document.getElementById('btnFilters')?.classList.remove('btn-board-action--active');
    } else {
        buildLabelChips();
        bar.style.display = '';
        document.getElementById('btnFilters')?.classList.add('btn-board-action--active');
    }
};

function buildLabelChips() {
    const labels = new Map();
    document.querySelectorAll('.card-label').forEach(el => {
        const text  = el.textContent.trim();
        const color = el.style.color;
        if (text && color) labels.set(color, text);
    });

    const container = document.getElementById('fbLabelChips');
    if (!container) return;
    container.innerHTML = '';

    if (!labels.size) {
        container.innerHTML = '<span class="fb-no-labels">Нет меток</span>';
        return;
    }
    labels.forEach((text, color) => {
        const btn = document.createElement('button');
        btn.className = 'fb-chip fb-chip--label';
        btn.dataset.filterLabel = color;
        btn.style.setProperty('--lc', color);
        btn.textContent = text;
        if (activeFilters.labels.has(color)) btn.classList.add('fb-chip--active');
        btn.onclick = () => {
            if (activeFilters.labels.has(color)) {
                activeFilters.labels.delete(color);
                btn.classList.remove('fb-chip--active');
            } else {
                activeFilters.labels.add(color);
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
    const { labels, due, done } = activeFilters;
    const hasAny = labels.size > 0 || due || done;

    document.querySelectorAll('.card').forEach(card => {
        let show = true;

        if (labels.size > 0) {
            const lbl   = card.querySelector('.card-label');
            const color = lbl ? lbl.style.color : '';
            show = show && labels.has(color);
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
            counter.textContent = visible;
        }
    });
}

window.clearFilters = function() {
    activeFilters = { labels: new Set(), due: null, done: null };
    document.querySelectorAll('.fb-chip').forEach(b => b.classList.remove('fb-chip--active'));
    document.querySelectorAll('.card').forEach(c => c.style.display = '');
    document.getElementById('btnFilters')?.classList.remove('btn-board-action--active');
    updateColumnCounts();
};


// ===== COLUMN MENU =====

let colMenuTargetId = null;

window.openColumnMenu = function(e, btn) {
    e.stopPropagation();
    const col = btn.closest('.column');
    colMenuTargetId = parseInt(col.dataset.colId);

    const dd   = document.getElementById('colMenuDropdown');
    const rect = btn.getBoundingClientRect();
    dd.style.top  = (rect.bottom + window.scrollY + 4) + 'px';
    dd.style.left = rect.left + 'px';
    dd.style.display = 'block';
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

window.colMenuDuplicate = async function() {
    document.getElementById('colMenuDropdown').style.display = 'none';
    const colId = colMenuTargetId;
    if (!colId) return;

    const res = await fetch('/api/columns/' + colId + '/duplicate', { method: 'POST' });
    if (!res.ok) { showToast('Не удалось дублировать список', 'error'); return; }
    const data = await res.json();

    const col = document.createElement('div');
    col.className     = 'column';
    col.id            = 'column-' + data.id;
    col.dataset.colId = data.id;
    col.innerHTML = `
        <div class="column-header">
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

    let cardMembers = [];
    let allUsers    = [];

    try {
        const [mRes, uRes] = await Promise.all([
            fetch(`/api/cards/${currentCardDbId}/members`),
            fetch('/api/users')
        ]);
        if (mRes.ok) cardMembers = await mRes.json();
        if (uRes.ok) allUsers    = await uRes.json();
    } catch (err) {
        console.error('openMembersPopover error:', err);
    }

    const assignedEmails = new Set(cardMembers.map(m => m.user_email));

    // Если /api/users недоступен (не-admin) — показываем только назначенных
    const users = allUsers.length
        ? allUsers
        : cardMembers.map(m => ({ email: m.user_email, name: m.user_name }));

    const body = document.getElementById('cspBody');
    body.innerHTML = '';

    if (!users.length) {
        body.innerHTML = '<p class="bl-empty">Нет пользователей</p>';
        return;
    }

    const isAdmin = allUsers.length > 0;  // если смогли загрузить /api/users — пользователь admin
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

        if (isAdmin) {
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
        } else if (isAssigned) {
            const check = document.createElement('span');
            check.className = 'mp-check';
            check.textContent = '✓';
            row.appendChild(check);
        }

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
    panel.style.display = 'block';
    const list = document.getElementById('archiveList');
    list.innerHTML = '<div class="ap-loading">Загрузка...</div>';

    const res  = await fetch('/api/archive');
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

function showBspMsg(text, isError) {
    const el = document.getElementById('bspMsg');
    if (!el) return;
    el.textContent = text;
    el.className = 'bsp-msg' + (isError ? ' error' : '');
    setTimeout(() => { if (el.textContent === text) el.textContent = ''; }, 3000);
}
