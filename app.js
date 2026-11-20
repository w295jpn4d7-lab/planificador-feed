/* Planificador de feed
   Todo se guarda en IndexedDB, solo en este dispositivo. */
'use strict';

/* ---------- Constantes ---------- */

const PALETTE = [
  { id: 'rosa',     c: 'oklch(68% 0.13 0)' },
  { id: 'terracota',c: 'oklch(66% 0.13 42)' },
  { id: 'ocre',     c: 'oklch(78% 0.12 82)' },
  { id: 'oliva',    c: 'oklch(66% 0.1 128)' },
  { id: 'salvia',   c: 'oklch(68% 0.08 180)' },
  { id: 'azul',     c: 'oklch(63% 0.11 250)' },
  { id: 'lavanda',  c: 'oklch(64% 0.1 300)' },
  { id: 'grafito',  c: 'oklch(50% 0.01 350)' },
];
const DEFAULT_TAGS = [
  { id: 't1', name: 'Matrimonio', color: 'rosa' },
  { id: 't2', name: 'Propuesta',  color: 'lavanda' },
  { id: 't3', name: 'Sesión',     color: 'salvia' },
  { id: 't4', name: 'Detrás de cámara', color: 'ocre' },
];
const STATUS = [
  { id: 'idea', label: 'Idea' },
  { id: 'lista', label: 'Lista' },
  { id: 'publicada', label: 'Publicada' },
];
const RATIOS = [
  { id: '3/4', label: '3:4', css: '3 / 4' },
  { id: '4/5', label: '4:5', css: '4 / 5' },
  { id: '1/1', label: '1:1', css: '1 / 1' },
];
const CAPTION_MAX = 2200;
const HASHTAG_MAX = 30;
const CAROUSEL_MAX = 20;
const THUMB_EDGE = 720;

const $ = (sel, root = document) => root.querySelector(sel);
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const colorOf = (colorId) => (PALETTE.find((p) => p.id === colorId) || PALETTE[7]).c;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

/* ---------- Base de datos ---------- */

let dbPromise = null;
function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open('planificador-feed', 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        d.createObjectStore('posts', { keyPath: 'id' });
        d.createObjectStore('images', { keyPath: 'id' });
        d.createObjectStore('meta');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}
async function run(stores, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(stores, mode);
    let out;
    Promise.resolve(fn(t)).then((v) => { out = v; });
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Transacción cancelada'));
  });
}
const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

const store = {
  all: (name) => run([name], 'readonly', (t) => reqP(t.objectStore(name).getAll())),
  get: (name, key) => run([name], 'readonly', (t) => reqP(t.objectStore(name).get(key))),
  put: (name, value, key) => run([name], 'readwrite', (t) => {
    const os = t.objectStore(name);
    if (key === undefined) os.put(value); else os.put(value, key);
  }),
  del: (name, keys) => run([name], 'readwrite', (t) => { [].concat(keys).forEach((k) => t.objectStore(name).delete(k)); }),
};

/* ---------- Estado ---------- */

const state = {
  posts: new Map(),     // id -> post
  order: [],            // ids, índice 0 = arriba a la izquierda
  tags: [],
  ratio: '3/4',
  highlight: null,      // id de marcador resaltado
  thumbs: new Map(),    // imageId -> objectURL
  dims: new Map(),      // imageId -> {w, h} del original
  accounts: [],         // [{id, name}], cada una con su propio feed
  account: null,        // id de la cuenta que se está viendo
  orders: {},           // accountId -> orden de su grilla
  stripView: 'joined',  // carrusel: 'joined' (tira continua) o 'separate'
};

async function load() {
  const [posts, order, tags, ratio, images, stripView, accounts, account, orders] = await Promise.all([
    store.all('posts'),
    store.get('meta', 'order'),
    store.get('meta', 'tags'),
    store.get('meta', 'ratio'),
    store.all('images'),
    store.get('meta', 'stripView'),
    store.get('meta', 'accounts'),
    store.get('meta', 'account'),
    store.get('meta', 'orders'),
  ]);
  state.accounts = accounts || [{ id: 'a1', name: 'Mi cuenta' }];
  if (!accounts) store.put('meta', state.accounts, 'accounts');
  const firstAcc = state.accounts[0].id;
  // Antes había un solo feed: sus publicaciones pasan a la primera cuenta
  posts.forEach((p) => { if (!p.account || !state.accounts.some((a) => a.id === p.account)) { p.account = firstAcc; savePost(p); } });
  if (stripView) state.stripView = stripView;
  posts.forEach((p) => state.posts.set(p.id, p));
  images.forEach((img) => {
    state.thumbs.set(img.id, URL.createObjectURL(img.thumb));
    state.dims.set(img.id, { w: img.w, h: img.h });
  });
  const saved = orders || { [firstAcc]: order || [] };
  state.orders = {};
  for (const acc of state.accounts) {
    const mine = posts.filter((p) => p.account === acc.id).map((p) => p.id);
    const known = (saved[acc.id] || []).filter((id) => mine.includes(id));
    state.orders[acc.id] = [...mine.filter((id) => !known.includes(id)), ...known];
  }
  state.account = state.accounts.some((a) => a.id === account) ? account : firstAcc;
  state.order = state.orders[state.account];
  state.tags = tags || DEFAULT_TAGS.map((t) => ({ ...t }));
  if (!tags) store.put('meta', state.tags, 'tags');
  state.ratio = ratio || '3/4';
  applyRatio();
}

const saveOrder = () => {
  state.orders[state.account] = [...state.order];
  return store.put('meta', structuredClone(state.orders), 'orders');
};
const saveAccounts = () => store.put('meta', state.accounts.map((a) => ({ ...a })), 'accounts');
const saveTags = () => store.put('meta', state.tags.map((t) => ({ ...t })), 'tags');
const savePost = (post) => store.put('posts', structuredClone(post));

function applyRatio() {
  const r = RATIOS.find((x) => x.id === state.ratio) || RATIOS[0];
  document.documentElement.style.setProperty('--ratio', r.css);
}

/* ---------- Imágenes ---------- */

function loadImage(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve({ img, url });
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('No se pudo leer la imagen')); };
    img.src = url;
  });
}

async function makeThumb(file) {
  const { img, url } = await loadImage(file);
  const w = img.naturalWidth, h = img.naturalHeight;
  const scale = Math.min(1, THUMB_EDGE / Math.min(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  URL.revokeObjectURL(url);
  const thumb = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.84));
  return { thumb, w, h };
}

async function addImages(files) {
  const out = [];
  for (const file of files) {
    const { thumb, w, h } = await makeThumb(file);
    const rec = { id: uid(), full: file, type: file.type || 'image/jpeg', name: file.name || 'foto.jpg', thumb, w, h };
    await store.put('images', rec);
    state.thumbs.set(rec.id, URL.createObjectURL(thumb));
    state.dims.set(rec.id, { w, h });
    out.push(rec.id);
  }
  return out;
}

function newPost(imageIds) {
  return { id: uid(), account: state.account, images: imageIds, caption: '', tags: [], status: 'idea', date: '', created: Date.now() };
}

/* ---------- Grilla ---------- */

const grid = $('#grid');
const tiles = new Map(); // postId -> elemento

function tileFor(post) {
  let el = tiles.get(post.id);
  if (!el) {
    el = document.createElement('button');
    el.className = 'tile';
    el.dataset.id = post.id;
    el.innerHTML = '<img alt="" draggable="false"><span class="tile-label"><span></span></span><span class="tile-mark"></span><span class="tile-foot"></span>';
    tiles.set(post.id, el);
  }
  const img = el.querySelector('img');
  const reserved = !post.images.length;
  const src = state.thumbs.get(post.images[0]) || '';
  if (reserved) img.removeAttribute('src');
  else if (img.getAttribute('src') !== src) img.src = src;
  el.classList.toggle('reserved', reserved);
  // Color del espacio: el elegido; si no hay, el del primer marcador
  const firstTag = state.tags.find((t) => t.id === post.tags[0]);
  const tint = post.color || firstTag?.color;
  if (reserved && tint) el.style.setProperty('--c', colorOf(tint)); else el.style.removeProperty('--c');
  el.classList.toggle('colored', reserved && !!post.color);
  el.querySelector('.tile-label span').textContent = reserved ? (post.label || 'Espacio reservado') : '';

  const marks = [];
  if (post.kind === 'reel') marks.push('<svg aria-hidden="true"><use href="#i-play"/></svg>');
  else if (post.images.length > 1) marks.push('<svg aria-hidden="true"><use href="#i-stack"/></svg>');
  if (post.status === 'publicada') marks.push('<svg aria-hidden="true"><use href="#i-check"/></svg>');
  el.querySelector('.tile-mark').innerHTML = marks.join('');

  const dots = post.tags
    .map((id) => state.tags.find((t) => t.id === id))
    .filter(Boolean)
    .map((t) => `<i style="--c:${colorOf(t.color)}"></i>`).join('');
  const date = post.date ? `<span class="tile-date">${fmtShort(post.date)}</span>` : '';
  el.querySelector('.tile-foot').innerHTML = (dots || date) ? `<span class="tile-dots">${dots}</span>${date}` : '';

  el.classList.toggle('dim', !!state.highlight && !post.tags.includes(state.highlight));
  const tagNames = post.tags.map((id) => state.tags.find((t) => t.id === id)?.name).filter(Boolean);
  const label = [
    reserved ? `Espacio reservado${post.label ? `: ${post.label}` : ''}` : post.images.length > 1 ? `Carrusel de ${post.images.length} fotos` : 'Foto',
    STATUS.find((s) => s.id === post.status)?.label,
    tagNames.length ? `marcadores: ${tagNames.join(', ')}` : '',
    post.date ? fmtLong(post.date) : '',
    post.caption ? '' : 'sin texto',
  ].filter(Boolean).join('. ');
  el.setAttribute('aria-label', label);
  return el;
}

function render() {
  const live = new Set(state.order);
  for (const [id, el] of tiles) if (!live.has(id)) { el.remove(); tiles.delete(id); }
  state.order.forEach((id, i) => {
    const el = tileFor(state.posts.get(id));
    if (grid.children[i] !== el) grid.insertBefore(el, grid.children[i] || null);
  });
  $('#empty').hidden = state.order.length > 0;
  renderSummary();
  renderChips();
}

function renderSummary() {
  const total = state.order.length;
  const pending = state.order.filter((id) => state.posts.get(id).status !== 'publicada').length;
  $('#summary').textContent = total
    ? `${total} ${total === 1 ? 'publicación' : 'publicaciones'}, ${pending} por publicar`
    : 'Tu feed planificado';
}

function renderChips() {
  const box = $('#filter-chips');
  const used = new Set(state.order.flatMap((id) => state.posts.get(id).tags));
  const tags = state.tags.filter((t) => used.has(t.id));
  if (state.highlight && !used.has(state.highlight)) state.highlight = null;
  if (!tags.length) { box.innerHTML = ''; return; }
  box.innerHTML = [
    `<button class="chip" data-tag="" aria-pressed="${!state.highlight}">Todas</button>`,
    ...tags.map((t) => `<button class="chip" data-tag="${t.id}" aria-pressed="${state.highlight === t.id}"><span class="swatch" style="--c:${colorOf(t.color)}"></span>${esc(t.name)}</button>`),
  ].join('');
}

$('#filter-chips').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  state.highlight = chip.dataset.tag || null;
  render();
  $('#filter-chips [aria-pressed="true"]')?.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: reduceMotion.matches ? 'auto' : 'smooth' });
});

/* Cambia el orden con animación FLIP */
function flipTo(newOrder) {
  const els = [...grid.children];
  const first = new Map(els.map((el) => [el, el.getBoundingClientRect()]));
  els.forEach((el) => el._anim?.cancel());
  state.order = newOrder;
  render();
  if (reduceMotion.matches) return;
  els.forEach((el) => {
    const a = first.get(el), b = el.getBoundingClientRect();
    const dx = a.left - b.left, dy = a.top - b.top;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
    el._anim = el.animate(
      [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }],
      { duration: 240, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' }
    );
  });
}

/* ---------- Arrastrar para ordenar ---------- */

let pending = null;   // pulsación que todavía no es arrastre
let drag = null;      // arrastre en curso
let swallowClick = false;
const LONG_PRESS = 280;

grid.addEventListener('pointerdown', (e) => {
  const tile = e.target.closest('.tile');
  if (!tile || drag || (e.pointerType === 'mouse' && e.button !== 0)) return;
  pending = { tile, id: tile.dataset.id, pointerId: e.pointerId, type: e.pointerType, x: e.clientX, y: e.clientY, timer: 0 };
  if (e.pointerType !== 'mouse') {
    pending.timer = setTimeout(() => { if (pending) startDrag(pending, pending.x, pending.y); }, LONG_PRESS);
  }
});

window.addEventListener('pointermove', (e) => {
  if (drag && e.pointerId === drag.pointerId) { moveDrag(e.clientX, e.clientY); return; }
  if (!pending || e.pointerId !== pending.pointerId) return;
  const dist = Math.hypot(e.clientX - pending.x, e.clientY - pending.y);
  if (pending.type === 'mouse') {
    if (dist > 6) startDrag(pending, e.clientX, e.clientY);
  } else if (dist > 10) {
    cancelPending(); // es un scroll
  } else {
    pending.x = e.clientX; pending.y = e.clientY;
  }
});

window.addEventListener('pointerup', (e) => {
  if (drag && e.pointerId === drag.pointerId) { endDrag(); return; }
  if (pending && e.pointerId === pending.pointerId) cancelPending();
});
window.addEventListener('pointercancel', (e) => {
  if (drag && e.pointerId === drag.pointerId) { endDrag(); return; }
  cancelPending();
});

// Mientras se arrastra, el dedo no debe mover la página
document.addEventListener('touchmove', (e) => { if (drag) e.preventDefault(); }, { passive: false });
grid.addEventListener('contextmenu', (e) => e.preventDefault());

function cancelPending() {
  if (pending) clearTimeout(pending.timer);
  pending = null;
}

function startDrag(p, x, y) {
  clearTimeout(p.timer);
  pending = null;
  const tile = p.tile;
  const rect = tile.getBoundingClientRect();
  const ghost = tile.cloneNode(true);
  ghost.classList.add('ghost');
  ghost.classList.remove('dim');
  ghost.removeAttribute('aria-label');
  Object.assign(ghost.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
  document.body.appendChild(ghost);
  tile.classList.add('placeholder');
  drag = {
    id: p.id, tile, ghost, pointerId: p.pointerId,
    ox: x - rect.left, oy: y - rect.top, x, y, startLeft: rect.left, startTop: rect.top,
    raf: 0,
  };
  if (navigator.vibrate) navigator.vibrate(8);
  if (!reduceMotion.matches) {
    ghost.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.06)' }], { duration: 160, easing: 'cubic-bezier(0.23, 1, 0.32, 1)', fill: 'forwards' })
      .finished.then(() => { if (drag && drag.ghost === ghost) positionGhost(); }).catch(() => {});
  }
  positionGhost();
  autoScroll();
}

function positionGhost() {
  const d = drag;
  const dx = d.x - d.ox - d.startLeft, dy = d.y - d.oy - d.startTop;
  d.ghost.getAnimations().forEach((a) => { a.commitStyles?.(); a.cancel(); });
  d.ghost.style.transform = `translate(${dx}px, ${dy}px) scale(${reduceMotion.matches ? 1 : 1.06})`;
}

function moveDrag(x, y) {
  drag.x = x; drag.y = y;
  positionGhost();
  retarget();
}

/* Calcula la celda bajo el dedo desde la geometría de la grilla (estable aunque haya animaciones) */
function retarget() {
  const n = state.order.length;
  if (!n) return;
  const g = grid.getBoundingClientRect();
  const gap = parseFloat(getComputedStyle(grid).gap) || 2;
  const cellW = (g.width + gap) / 3;
  const cellH = drag.tile.offsetHeight + gap;
  const col = Math.max(0, Math.min(2, Math.floor((drag.x - g.left) / cellW)));
  const row = Math.max(0, Math.floor((drag.y - g.top) / cellH));
  const target = Math.min(n - 1, row * 3 + col);
  const from = state.order.indexOf(drag.id);
  if (target === from) return;
  const next = [...state.order];
  next.splice(from, 1);
  next.splice(target, 0, drag.id);
  flipTo(next);
}

function autoScroll() {
  if (!drag) return;
  const edgeTop = $('.top').getBoundingClientRect().bottom + 60;
  const edgeBottom = innerHeight - 110;
  let v = 0;
  if (drag.y < edgeTop) v = -Math.min(18, (edgeTop - drag.y) / 4);
  else if (drag.y > edgeBottom) v = Math.min(18, (drag.y - edgeBottom) / 4);
  if (v) { window.scrollBy(0, v); retarget(); }
  drag.raf = requestAnimationFrame(autoScroll);
}

function endDrag() {
  const d = drag;
  drag = null;
  cancelAnimationFrame(d.raf);
  swallowClick = true;
  setTimeout(() => { swallowClick = false; }, 60);
  const to = d.tile.getBoundingClientRect();
  const dx = to.left - d.startLeft, dy = to.top - d.startTop;
  const finish = () => { d.ghost.remove(); d.tile.classList.remove('placeholder'); };
  saveOrder();
  if (reduceMotion.matches) { finish(); return; }
  const anim = d.ghost.animate(
    [{ transform: d.ghost.style.transform }, { transform: `translate(${dx}px, ${dy}px) scale(1)` }],
    { duration: 200, easing: 'cubic-bezier(0.23, 1, 0.32, 1)', fill: 'forwards' }
  );
  anim.finished.then(finish, finish);
}

grid.addEventListener('click', (e) => {
  const tile = e.target.closest('.tile');
  if (!tile) return;
  if (swallowClick) { e.preventDefault(); return; }
  openPost(tile.dataset.id);
});

/* Teclado: Alt + flechas mueve la publicación con foco */
grid.addEventListener('keydown', (e) => {
  const tile = e.target.closest('.tile');
  if (!tile || !e.altKey) return;
  const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -3, ArrowDown: 3 }[e.key];
  if (!step) return;
  e.preventDefault();
  const from = state.order.indexOf(tile.dataset.id);
  const to = Math.max(0, Math.min(state.order.length - 1, from + step));
  if (to === from) return;
  const next = [...state.order];
  next.splice(from, 1);
  next.splice(to, 0, tile.dataset.id);
  flipTo(next);
  saveOrder();
  tile.focus();
});

/* ---------- Hojas inferiores ---------- */

function openSheet(dialog) {
  if (dialog.open) return;
  dialog.showModal();
  document.body.classList.add('locked');
  requestAnimationFrame(() => requestAnimationFrame(() => dialog.classList.add('shown')));
}
function closeSheet(dialog) {
  if (!dialog.open || dialog.dataset.closing) return;
  dialog.dataset.closing = '1';
  dialog.classList.remove('shown', 'dragging');
  dialog.style.transform = '';
  const done = () => {
    delete dialog.dataset.closing;
    if (dialog.open) dialog.close();
    if (!document.querySelector('dialog[open]')) document.body.classList.remove('locked');
    dialog.dispatchEvent(new Event('sheetclosed'));
  };
  setTimeout(done, reduceMotion.matches ? 200 : 320);
}

document.querySelectorAll('dialog.sheet').forEach((dialog) => {
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) closeSheet(dialog);          // toque fuera de la hoja
    if (e.target.closest('[data-close]')) closeSheet(dialog);
  });
  dialog.addEventListener('cancel', (e) => { e.preventDefault(); closeSheet(dialog); });

  // Deslizar hacia abajo para cerrar
  const handles = dialog.querySelectorAll('[data-grab], .sheet-head');
  let start = null;
  handles.forEach((h) => {
    h.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      start = { y: e.clientY, t: performance.now(), id: e.pointerId };
      h.setPointerCapture(e.pointerId);
      dialog.classList.add('dragging');
    });
    h.addEventListener('pointermove', (e) => {
      if (!start || e.pointerId !== start.id) return;
      const dy = e.clientY - start.y;
      const y = dy > 0 ? dy : -Math.sqrt(-dy) * 2; // fricción hacia arriba
      dialog.style.transform = `translateY(${y}px)`;
    });
    const end = (e) => {
      if (!start || e.pointerId !== start.id) return;
      const dy = e.clientY - start.y;
      const v = dy / Math.max(1, performance.now() - start.t);
      start = null;
      dialog.classList.remove('dragging');
      if (dy > 120 || v > 0.5) closeSheet(dialog);
      else dialog.style.transform = '';
    };
    h.addEventListener('pointerup', end);
    h.addEventListener('pointercancel', end);
  });
});

/* ---------- Aviso breve ---------- */

const toastEl = $('#toast');
let toastTimer = 0;
function toast(msg, ms = 2600) {
  const host = document.querySelector('dialog[open]') || document.body;
  if (toastEl.parentElement !== host) host.appendChild(toastEl);
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
}

/* ---------- Agregar fotos ---------- */

const fileNew = $('#file-new');
const fileMore = $('#file-more');
const sheetMode = $('#sheet-mode');
let pendingFiles = [];

$('#btn-add').addEventListener('click', () => fileNew.click());

$('#btn-reserve').addEventListener('click', async () => {
  const p = { ...newPost([]), label: '' };
  state.posts.set(p.id, p);
  await savePost(p);
  flipTo([p.id, ...state.order]);
  await saveOrder();
  window.scrollTo({ top: 0, behavior: reduceMotion.matches ? 'auto' : 'smooth' });
  await openPost(p.id);
  setTimeout(() => $('#label', postBody)?.focus(), 360);
});

fileNew.addEventListener('change', () => {
  const files = [...fileNew.files];
  fileNew.value = '';
  if (!files.length) return;
  if (files.length === 1) { maybePanorama(files[0]); return; }
  pendingFiles = files;
  $('#mode-count').textContent = files.length;
  const tooMany = files.length > CAROUSEL_MAX;
  sheetMode.querySelector('[data-mode="carousel"]').disabled = tooMany;
  $('#mode-hint').textContent = tooMany
    ? `Un carrusel de Instagram admite hasta ${CAROUSEL_MAX} fotos, así que estas irán como publicaciones separadas.`
    : 'Las fotos separadas quedan arriba del feed en el orden en que las elegiste. Después puedes moverlas.';
  openSheet(sheetMode);
});

sheetMode.addEventListener('click', (e) => {
  const b = e.target.closest('[data-mode]');
  if (!b) return;
  const files = pendingFiles;
  pendingFiles = [];
  closeSheet(sheetMode);
  createPosts(files, b.dataset.mode);
});

async function createPosts(files, mode) {
  const btn = $('#btn-add');
  btn.disabled = true;
  toast(files.length > 1 ? `Preparando ${files.length} fotos` : 'Preparando la foto', 60000);
  try {
    const ids = await addImages(files);
    const posts = mode === 'carousel' ? [newPost(ids)] : ids.map((id) => newPost([id]));
    for (const p of posts) { state.posts.set(p.id, p); await savePost(p); }
    flipTo([...posts.map((p) => p.id), ...state.order]);
    await saveOrder();
    window.scrollTo({ top: 0, behavior: reduceMotion.matches ? 'auto' : 'smooth' });
    toast(posts.length > 1 ? `${posts.length} publicaciones agregadas` : 'Publicación agregada');
  } catch (err) {
    console.error(err);
    toast('No se pudieron agregar algunas fotos. Prueba de nuevo.');
  } finally {
    btn.disabled = false;
  }
}

/* ---------- Panorámica cortada en tira ---------- */

const sheetPano = $('#sheet-pano');
const panoBody = $('#pano-body');
const SLIDE_RATIOS = [
  { id: '4/5', label: '4:5', value: 4 / 5 },
  { id: '3/4', label: '3:4', value: 3 / 4 },
  { id: '1/1', label: '1:1', value: 1 },
];
let pano = null; // { file, url, w, h, n, ratio, post }

function isWide(d) { return !!d && d.w / d.h >= 1.4; }

// Instagram recorta todas las fotos del carrusel a la proporción de la primera (entre 3:4 y 1,91:1)
function carouselRatio(p) {
  const d = state.dims.get(p.images[0]);
  if (!d) return 0.8;
  return Math.min(1.91, Math.max(0.75, d.w / d.h)).toFixed(4);
}

function suggestCount(w, h, ratio) {
  return Math.min(10, Math.max(2, Math.round(w / h / ratio)));
}

async function maybePanorama(file) {
  try {
    const { img, url } = await loadImage(file);
    const w = img.naturalWidth, h = img.naturalHeight;
    URL.revokeObjectURL(url);
    if (isWide({ w, h })) { openPano(file, { w, h }); return; }
  } catch { /* si no se puede leer, sigue el camino normal y avisa ahí */ }
  createPosts([file], 'separate');
}

async function openPano(file, { w, h, post } = {}) {
  if (!w) {
    const { img, url } = await loadImage(file);
    w = img.naturalWidth; h = img.naturalHeight;
    URL.revokeObjectURL(url);
  }
  if (pano?.url) URL.revokeObjectURL(pano.url);
  const ratio = SLIDE_RATIOS[0];
  pano = { file, url: URL.createObjectURL(file), w, h, ratio, n: suggestCount(w, h, ratio.value), post: post || null };
  if (post) closeSheet(sheetPost);
  renderPano();
  setTimeout(() => openSheet(sheetPano), post ? 340 : 0);
}

function panoCrop() {
  const { w, h, n, ratio } = pano;
  let sw = w / n, sh = sw / ratio.value;
  if (sh > h) { sh = h; sw = h * ratio.value; }
  const x = (w - sw * n) / 2, y = (h - sh) / 2;
  return { sw, sh, x, y };
}

function renderPano() {
  const { w, h, n, ratio, post } = pano;
  const c = panoCrop();
  const box = `left:${(c.x / w) * 100}%; top:${(c.y / h) * 100}%; width:${((c.sw * n) / w) * 100}%; height:${(c.sh / h) * 100}%`;
  const cuts = Array.from({ length: n - 1 }, (_, i) => `<span style="left:${((i + 1) / n) * 100}%"></span>`).join('');
  const px = Math.round(c.sw);
  panoBody.innerHTML = `
    <div class="pano-preview" style="aspect-ratio:${w}/${h}">
      <img src="${pano.url}" alt="Vista previa de la foto panorámica">
      <div class="pano-box" style="${box}">${cuts}</div>
    </div>
    <div class="field">
      <div class="field-label">Cantidad de fotos <span class="counter">${px} px de ancho cada una</span></div>
      <div class="stepper">
        <button class="icon-btn" data-step="-1" aria-label="Una foto menos" ${n <= 2 ? 'disabled' : ''}>−</button>
        <output aria-live="polite">${n}</output>
        <button class="icon-btn" data-step="1" aria-label="Una foto más" ${n >= 10 ? 'disabled' : ''}>+</button>
      </div>
    </div>
    <div class="field">
      <div class="field-label">Formato de cada foto</div>
      <div class="seg">
        ${SLIDE_RATIOS.map((r) => `<button data-slide-ratio="${r.id}" aria-pressed="${r.id === ratio.id}">${r.label}</button>`).join('')}
      </div>
    </div>
    ${px < 1080 ? `<p class="hint">Cada foto queda de menos de 1080 px de ancho. Se verá bien en el feed, pero con menos cortes queda más nítida.</p>` : ''}
    <div class="stack-actions pano-actions">
      <button class="btn btn-primary" id="pano-go"><svg><use href="#i-scissors"/></svg>Cortar en ${n} fotos</button>
      ${post ? '' : '<button class="btn btn-secondary" id="pano-single">Dejarla como una sola foto</button>'}
    </div>`;
}

panoBody.addEventListener('click', async (e) => {
  if (!pano) return;
  const t = e.target;
  const step = t.closest('[data-step]');
  if (step) { pano.n = Math.min(10, Math.max(2, pano.n + Number(step.dataset.step))); renderPano(); return; }
  const r = t.closest('[data-slide-ratio]');
  if (r) {
    pano.ratio = SLIDE_RATIOS.find((x) => x.id === r.dataset.slideRatio);
    pano.n = suggestCount(pano.w, pano.h, pano.ratio.value);
    renderPano();
    return;
  }
  if (t.closest('#pano-single')) {
    const file = pano.file;
    closeSheet(sheetPano);
    createPosts([file], 'separate');
    return;
  }
  const go = t.closest('#pano-go');
  if (go) {
    go.disabled = true;
    const job = pano;
    try {
      toast(`Cortando en ${job.n} fotos`, 60000);
      const files = await slicePanorama(job);
      closeSheet(sheetPano);
      if (job.post) await replaceWithSlices(job.post, files);
      else await createPosts(files, 'carousel');
    } catch (err) {
      console.error(err);
      toast('No se pudo cortar la foto. Prueba con menos fotos.');
      go.disabled = false;
    }
  }
});

sheetPano.addEventListener('sheetclosed', () => {
  if (pano?.url) URL.revokeObjectURL(pano.url);
  pano = null;
});

async function slicePanorama(job) {
  const { img, url } = await loadImage(job.file);
  const { sw, sh, x, y } = (() => { const prev = pano; pano = job; const c = panoCrop(); pano = prev; return c; })();
  const scale = Math.min(1, 1440 / sw);           // Instagram muestra hasta 1080, se deja margen para nitidez
  const cw = Math.round(sw * scale), ch = Math.round(sh * scale);
  const base = (job.file.name || 'tira').replace(/\.[^.]+$/, '');
  const out = [];
  for (let i = 0; i < job.n; i++) {
    const canvas = document.createElement('canvas');
    canvas.width = cw; canvas.height = ch;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, x + i * sw, y, sw, sh, 0, 0, cw, ch);
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.92));
    out.push(new File([blob], `${base}-${i + 1}.jpg`, { type: 'image/jpeg' }));
  }
  URL.revokeObjectURL(url);
  return out;
}

async function replaceWithSlices(post, files) {
  const old = post.images;
  post.images = await addImages(files);
  await savePost(post);
  await store.del('images', old);
  old.forEach((id) => { URL.revokeObjectURL(state.thumbs.get(id)); state.thumbs.delete(id); state.dims.delete(id); });
  refreshTile(post);
  state.stripView = 'joined';
  store.put('meta', 'joined', 'stripView');
  toast(`Listo, ahora es un carrusel de ${files.length} fotos`);
  openPost(post.id);
}

/* ---------- Detalle de publicación ---------- */

const sheetPost = $('#sheet-post');
const postBody = $('#post-body');
let current = null;       // post abierto
let shareFiles = null;    // archivos listos para compartir (se preparan antes del toque)

async function openPost(id) {
  current = state.posts.get(id);
  if (!current) return;
  renderPost();
  openSheet(sheetPost);
  prepareShareFiles();
}

async function prepareShareFiles() {
  shareFiles = null;
  const post = current;
  const recs = await Promise.all(post.images.map((imgId) => store.get('images', imgId)));
  if (current !== post) return;
  shareFiles = recs.filter(Boolean).map((r, i) => {
    const ext = (r.type.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
    return new File([r.full], `feed-${i + 1}.${ext}`, { type: r.type });
  });
}

function hashtagCount(text) { return (text.match(/(^|\s)#[\p{L}\p{N}_]+/gu) || []).length; }

function renderPost() {
  const p = current;
  if (!p.images.length) { renderReserved(); return; }
  $('#post-title').textContent = p.images.length > 1 ? `Carrusel de ${p.images.length} fotos` : 'Publicación';
  const multi = p.images.length > 1;
  const joined = multi && state.stripView === 'joined';
  const strip = p.images.map((imgId, i) => `
    <figure class="strip-item" data-img="${imgId}">
      <img src="${state.thumbs.get(imgId) || ''}" alt="Foto ${i + 1}">
      ${multi ? `<span class="strip-badge">${i === 0 && !joined ? 'Portada' : i + 1}</span>` : ''}
      ${multi && !joined ? `<span class="strip-tools">
        ${i > 1 ? `<button data-move-left="${imgId}" aria-label="Mover una posición antes"><svg><use href="#i-arrow-left"/></svg></button>` : ''}
        ${i > 0 ? `<button data-cover="${imgId}" aria-label="Usar como portada"><svg><use href="#i-cover"/></svg></button>` : ''}
        <button data-remove-img="${imgId}" aria-label="Quitar esta foto del carrusel"><svg><use href="#i-x"/></svg></button>
      </span>` : ''}
    </figure>`).join('');
  const canAdd = p.images.length < CAROUSEL_MAX && !joined;
  const wide = !multi && isWide(state.dims.get(p.images[0]));

  postBody.innerHTML = `
    ${multi ? `<div class="seg strip-view" id="strip-view" role="group" aria-label="Cómo ver el carrusel">
      <button data-view="joined" aria-pressed="${joined}">Juntas en tira</button>
      <button data-view="separate" aria-pressed="${!joined}">Una por una</button>
    </div>` : ''}
    <div class="strip ${multi ? '' : 'single'} ${joined ? 'joined' : ''}" style="--n:${p.images.length}; --slide:${carouselRatio(p)}">
      ${strip}
      ${canAdd ? `<button class="strip-add" id="btn-more"><svg><use href="#i-plus"/></svg>${multi ? 'Agregar' : 'Hacer carrusel'}</button>` : ''}
    </div>
    ${joined ? `<p class="hint strip-hint">Así se ve el carrusel completo, una foto al lado de la otra. Las líneas finas marcan dónde se pasa a la siguiente. Para ordenar o quitar fotos, cambia a «Una por una».</p>` : ''}
    ${wide ? `<button class="btn btn-secondary btn-pano" id="btn-pano"><svg><use href="#i-scissors"/></svg>Cortar en tira para carrusel</button>` : ''}

    <div class="field">
      <label class="field-label" for="caption">Texto de la publicación <span class="counter" id="counter"></span></label>
      <textarea id="caption" placeholder="Escribe aquí el texto y los hashtags">${esc(p.caption)}</textarea>
    </div>

    <div class="field">
      <div class="field-label">Marcadores</div>
      <div class="tag-pick" id="tag-pick">
        ${state.tags.map((t) => `<button class="chip" data-toggle-tag="${t.id}" aria-pressed="${p.tags.includes(t.id)}"><span class="swatch" style="--c:${colorOf(t.color)}"></span>${esc(t.name)}</button>`).join('')}
      </div>
    </div>

    <div class="field">
      <div class="field-label">Estado</div>
      <div class="seg" id="status-seg">
        ${STATUS.map((s) => `<button data-status="${s.id}" aria-pressed="${p.status === s.id}">${s.label}</button>`).join('')}
      </div>
    </div>

    <div class="field">
      <label class="field-label" for="date">Fecha pensada para publicar</label>
      <input type="datetime-local" id="date" value="${p.date || ''}">
    </div>

    <div class="actions">
      <button class="btn btn-primary" id="btn-share"><svg><use href="#i-share"/></svg>Llevar a Instagram</button>
      <button class="btn btn-secondary" id="btn-copy"><svg><use href="#i-copy"/></svg>Copiar texto</button>
    </div>
    <div class="after-share" id="after-share" hidden>
      <span>¿Ya quedó publicada?</span>
      <button class="btn btn-primary" id="btn-mark">Marcar publicada</button>
    </div>
    <div class="foot-actions">
      <button class="btn btn-danger" id="btn-delete"><svg><use href="#i-trash"/></svg>Eliminar publicación</button>
    </div>`;
  updateCounter();
}

// Parte común del detalle: texto, marcadores, estado y fecha
function postFields(p) {
  return `
    <div class="field">
      <label class="field-label" for="caption">Texto de la publicación <span class="counter" id="counter"></span></label>
      <textarea id="caption" placeholder="Escribe aquí el texto y los hashtags">${esc(p.caption)}</textarea>
    </div>

    <div class="field">
      <div class="field-label">Marcadores</div>
      <div class="tag-pick" id="tag-pick">
        ${state.tags.map((t) => `<button class="chip" data-toggle-tag="${t.id}" aria-pressed="${p.tags.includes(t.id)}"><span class="swatch" style="--c:${colorOf(t.color)}"></span>${esc(t.name)}</button>`).join('')}
      </div>
    </div>

    <div class="field">
      <div class="field-label">Estado</div>
      <div class="seg" id="status-seg">
        ${STATUS.map((s) => `<button data-status="${s.id}" aria-pressed="${p.status === s.id}">${s.label}</button>`).join('')}
      </div>
    </div>

    <div class="field">
      <label class="field-label" for="date">Fecha pensada para publicar</label>
      <input type="datetime-local" id="date" value="${p.date || ''}">
    </div>`;
}

function renderReserved() {
  const p = current;
  $('#post-title').textContent = 'Espacio reservado';
  postBody.innerHTML = `
    <div class="reserved-box ${p.color ? 'colored' : ''}" style="${p.color ? `--c:${colorOf(p.color)}` : ''}">
      <p>Este lugar del feed está guardado. Cuando tengas las fotos, ponlas aquí y se queda en la misma posición.</p>
      <button class="btn btn-primary" id="btn-more"><svg><use href="#i-photo-plus"/></svg>Poner fotos</button>
    </div>

    <div class="field">
      <div class="field-label">Color</div>
      <div class="palette reserve-palette" role="group" aria-label="Color del espacio">
        <button data-reserve-color="" aria-pressed="${!p.color}" aria-label="Sin color (usa el del marcador)"><span class="no-color"></span></button>
        ${PALETTE.map((c) => `<button data-reserve-color="${c.id}" aria-pressed="${p.color === c.id}" aria-label="Color ${c.id}"><span style="--c:${c.c}"></span></button>`).join('')}
      </div>
    </div>

    <div class="field">
      <label class="field-label" for="label">Qué va aquí</label>
      <input type="text" id="label" maxlength="60" placeholder="Por ejemplo: Boda en la viña, detrás de cámara" value="${esc(p.label || '')}">
    </div>
    ${postFields(p)}

    <div class="actions">
      <button class="btn btn-secondary" id="btn-copy"><svg><use href="#i-copy"/></svg>Copiar texto</button>
    </div>
    <div class="foot-actions">
      <button class="btn btn-danger" id="btn-delete"><svg><use href="#i-trash"/></svg>Quitar espacio</button>
    </div>`;
  updateCounter();
}

function updateCounter() {
  const text = $('#caption', postBody)?.value || '';
  const tags = hashtagCount(text);
  const el = $('#counter', postBody);
  el.textContent = `${text.length}/${CAPTION_MAX}, ${tags}/${HASHTAG_MAX} #`;
  el.classList.toggle('over', text.length > CAPTION_MAX || tags > HASHTAG_MAX);
}

function refreshTile(post) { if (state.posts.has(post.id)) { tileFor(post); renderSummary(); renderChips(); } }

let captionTimer = 0;
postBody.addEventListener('input', (e) => {
  if (!current) return;
  if (e.target.id === 'label') {
    current.label = e.target.value;
    clearTimeout(captionTimer);
    const post = current;
    captionTimer = setTimeout(() => { savePost(post); refreshTile(post); }, 300);
    return;
  }
  if (e.target.id === 'caption') {
    current.caption = e.target.value;
    updateCounter();
    clearTimeout(captionTimer);
    const post = current;
    captionTimer = setTimeout(() => { savePost(post); refreshTile(post); }, 350);
  }
});
postBody.addEventListener('change', (e) => {
  if (!current) return;
  if (e.target.id === 'date') {
    current.date = e.target.value;
    savePost(current); refreshTile(current);
  }
});

postBody.addEventListener('click', async (e) => {
  const p = current;
  if (!p) return;
  const t = e.target;

  const tagBtn = t.closest('[data-toggle-tag]');
  if (tagBtn) {
    const id = tagBtn.dataset.toggleTag;
    p.tags = p.tags.includes(id) ? p.tags.filter((x) => x !== id) : [...p.tags, id];
    tagBtn.setAttribute('aria-pressed', p.tags.includes(id));
    savePost(p); refreshTile(p);
    return;
  }

  const st = t.closest('[data-status]');
  if (st) {
    setStatus(p, st.dataset.status);
    return;
  }

  if (t.closest('#btn-copy')) {
    const ok = await copyText(p.caption);
    toast(ok ? 'Texto copiado' : 'No se pudo copiar. Mantén el dedo sobre el texto para copiarlo.');
    return;
  }

  if (t.closest('#btn-share')) { shareToInstagram(p); return; }

  if (t.closest('#btn-mark')) {
    setStatus(p, 'publicada');
    $('#after-share', postBody).hidden = true;
    toast('Marcada como publicada');
    return;
  }

  if (t.closest('#btn-more')) { fileMore.click(); return; }

  const rc = t.closest('[data-reserve-color]');
  if (rc) {
    p.color = rc.dataset.reserveColor || '';
    postBody.querySelectorAll('[data-reserve-color]').forEach((b) => b.setAttribute('aria-pressed', b === rc));
    const box = $('.reserved-box', postBody);
    box.classList.toggle('colored', !!p.color);
    if (p.color) box.style.setProperty('--c', colorOf(p.color)); else box.style.removeProperty('--c');
    await savePost(p); refreshTile(p);
    return;
  }

  const view = t.closest('[data-view]');
  if (view) {
    if (state.stripView === view.dataset.view) return;
    state.stripView = view.dataset.view;
    store.put('meta', state.stripView, 'stripView');
    renderPost();
    return;
  }

  const left = t.closest('[data-move-left]');
  if (left) {
    const i = p.images.indexOf(left.dataset.moveLeft);
    if (i > 0) {
      const imgs = [...p.images];
      [imgs[i - 1], imgs[i]] = [imgs[i], imgs[i - 1]];
      p.images = imgs;
      await savePost(p); refreshTile(p); renderPost(); prepareShareFiles();
      $(`[data-img="${left.dataset.moveLeft}"]`, postBody)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
    return;
  }

  if (t.closest('#btn-pano')) {
    const rec = await store.get('images', p.images[0]);
    if (rec) openPano(rec.full, { post: p });
    return;
  }

  const cover = t.closest('[data-cover]');
  if (cover) {
    p.images = [cover.dataset.cover, ...p.images.filter((x) => x !== cover.dataset.cover)];
    await savePost(p); refreshTile(p); renderPost(); prepareShareFiles();
    return;
  }

  const rm = t.closest('[data-remove-img]');
  if (rm) {
    const imgId = rm.dataset.removeImg;
    p.images = p.images.filter((x) => x !== imgId);
    await savePost(p);
    await store.del('images', imgId);
    URL.revokeObjectURL(state.thumbs.get(imgId));
    state.thumbs.delete(imgId);
    refreshTile(p); renderPost(); prepareShareFiles();
    return;
  }

  const del = t.closest('#btn-delete');
  if (del) {
    if (!del.classList.contains('armed')) {
      del.classList.add('armed');
      const original = del.lastChild.textContent;
      del.lastChild.textContent = 'Toca otra vez para eliminar';
      setTimeout(() => { if (del.isConnected) { del.classList.remove('armed'); del.lastChild.textContent = original; } }, 3500);
      return;
    }
    await deletePost(p);
    closeSheet(sheetPost);
    toast('Publicación eliminada');
  }
});

function setStatus(p, status) {
  p.status = status;
  postBody.querySelectorAll('[data-status]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.status === status));
  savePost(p); refreshTile(p);
}

fileMore.addEventListener('change', async () => {
  const files = [...fileMore.files];
  fileMore.value = '';
  const p = current;
  if (!files.length || !p) return;
  const room = CAROUSEL_MAX - p.images.length;
  const use = files.slice(0, room);
  const wasReserved = !p.images.length;
  toast(wasReserved ? 'Poniendo las fotos' : 'Agregando al carrusel', 60000);
  const ids = await addImages(use);
  p.images = [...p.images, ...ids];
  await savePost(p);
  refreshTile(p);
  if (current === p) { renderPost(); prepareShareFiles(); }
  toast(files.length > room ? `Se agregaron ${use.length}. El máximo es ${CAROUSEL_MAX} fotos.`
    : wasReserved ? 'Listo, el espacio ya tiene sus fotos' : 'Fotos agregadas al carrusel');
});

async function deletePost(p) {
  state.posts.delete(p.id);
  await store.del('posts', p.id);
  await store.del('images', p.images);
  p.images.forEach((id) => { URL.revokeObjectURL(state.thumbs.get(id)); state.thumbs.delete(id); });
  flipTo(state.order.filter((id) => id !== p.id));
  saveOrder();
}

sheetPost.addEventListener('sheetclosed', () => {
  clearTimeout(captionTimer);
  if (current) { savePost(current); refreshTile(current); }
  current = null;
  shareFiles = null;
});

/* ---------- Copiar y compartir ---------- */

function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text).then(() => true, () => legacyCopy(text));
  }
  return Promise.resolve(legacyCopy(text));
}
function legacyCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;font-size:16px';
  (document.querySelector('dialog[open]') || document.body).appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return ok;
}

function shareToInstagram(p) {
  // Copiar primero, sin esperar, para no perder el permiso del toque antes de abrir el menú de compartir
  const copied = p.caption ? copyText(p.caption) : Promise.resolve(false);
  const files = shareFiles;
  if (!files || !files.length) { toast('Un segundo, preparando las fotos'); return; }

  if (navigator.canShare && navigator.canShare({ files })) {
    navigator.share({ files })
      .then(async () => {
        const ok = await copied;
        $('#after-share', postBody) && ($('#after-share', postBody).hidden = p.status === 'publicada');
        toast(ok ? 'Texto copiado. En Instagram, mantén el dedo en la descripción y pega.' : 'Fotos enviadas', 4200);
      })
      .catch(async (err) => {
        if (err && err.name === 'AbortError') {
          if (await copied) toast('El texto quedó copiado');
          return;
        }
        console.error(err);
        toast('No se pudo abrir el menú de compartir.');
      });
    return;
  }

  // Computador u otro navegador sin compartir archivos: descarga las fotos
  files.forEach((f) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(f);
    a.download = f.name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  });
  copied.then((ok) => toast(ok ? 'Fotos descargadas y texto copiado' : 'Fotos descargadas', 3600));
}

/* ---------- Ajustes y marcadores ---------- */

const sheetSettings = $('#sheet-settings');
const settingsBody = $('#settings-body');
let paletteOpenFor = null;

$('#btn-settings').addEventListener('click', async () => {
  paletteOpenFor = null;
  renderSettings();
  openSheet(sheetSettings);
  if (navigator.storage?.estimate) {
    const { usage } = await navigator.storage.estimate();
    const el = $('#usage', settingsBody);
    if (el && usage != null) el.textContent = `Ocupan ${fmtBytes(usage)} en este dispositivo.`;
  }
});

function renderSettings() {
  settingsBody.innerHTML = `
    <section class="set-group">
      <h3>Formato de la grilla</h3>
      <div class="seg" id="ratio-seg">
        ${RATIOS.map((r) => `<button data-ratio="${r.id}" aria-pressed="${state.ratio === r.id}">${r.label}</button>`).join('')}
      </div>
      <p class="hint">Instagram muestra el perfil en 3:4. Usa 1:1 si quieres ver la grilla cuadrada de antes.</p>
    </section>

    <section class="set-group">
      <h3>Marcadores</h3>
      <div class="tag-rows" id="tag-rows">
        ${state.tags.map((t) => `
          <div>
            <div class="tag-row" data-tag-row="${t.id}">
              <button class="swatch-btn" data-pick-color="${t.id}" aria-label="Cambiar color de ${esc(t.name)}" aria-expanded="${paletteOpenFor === t.id}"><span style="--c:${colorOf(t.color)}"></span></button>
              <input type="text" value="${esc(t.name)}" data-tag-name="${t.id}" aria-label="Nombre del marcador" maxlength="28">
              <button class="icon-btn" data-del-tag="${t.id}" aria-label="Eliminar marcador ${esc(t.name)}"><svg><use href="#i-trash"/></svg></button>
            </div>
            ${paletteOpenFor === t.id ? `<div class="palette">${PALETTE.map((c) => `<button data-set-color="${c.id}" data-for="${t.id}" aria-label="Color ${c.id}" aria-pressed="${t.color === c.id}"><span style="--c:${c.c}"></span></button>`).join('')}</div>` : ''}
          </div>`).join('')}
      </div>
      <button class="btn btn-secondary add-tag" id="btn-add-tag"><svg><use href="#i-plus"/></svg>Nuevo marcador</button>
    </section>

    <section class="set-group">
      <h3>Importar</h3>
      <button class="btn btn-secondary add-tag" id="btn-import"><svg><use href="#i-download"/></svg>Importar de Claude</button>
      <p class="hint">Abre un archivo preparado por Claude (por ejemplo tus últimas publicaciones de Metricool o un diseño de Canva). Se agrega a la cuenta que estás viendo.</p>
    </section>

    <section class="set-group">
      <h3>Tus fotos</h3>
      <p class="note">Se guardan solo en este teléfono, no en internet. Si borras la app de la pantalla de inicio o los datos de Safari, se pierden. <span id="usage"></span></p>
    </section>`;
}

settingsBody.addEventListener('click', (e) => {
  const t = e.target;
  const r = t.closest('[data-ratio]');
  if (r) {
    state.ratio = r.dataset.ratio;
    store.put('meta', state.ratio, 'ratio');
    applyRatio();
    settingsBody.querySelectorAll('[data-ratio]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.ratio === state.ratio));
    return;
  }
  const pick = t.closest('[data-pick-color]');
  if (pick) {
    paletteOpenFor = paletteOpenFor === pick.dataset.pickColor ? null : pick.dataset.pickColor;
    renderSettings();
    return;
  }
  const sc = t.closest('[data-set-color]');
  if (sc) {
    const tag = state.tags.find((x) => x.id === sc.dataset.for);
    tag.color = sc.dataset.setColor;
    paletteOpenFor = null;
    saveTags(); renderSettings(); render();
    return;
  }
  const del = t.closest('[data-del-tag]');
  if (del) {
    const id = del.dataset.delTag;
    const uses = [...state.posts.values()].filter((p) => p.tags.includes(id)).length;
    if (uses && !del.classList.contains('armed')) {
      del.classList.add('armed');
      toast(`Está en ${uses} ${uses === 1 ? 'publicación' : 'publicaciones'}. Toca otra vez para eliminarlo.`);
      setTimeout(() => del.isConnected && del.classList.remove('armed'), 3500);
      return;
    }
    state.tags = state.tags.filter((x) => x.id !== id);
    state.posts.forEach((p) => {
      if (p.tags.includes(id)) { p.tags = p.tags.filter((x) => x !== id); savePost(p); }
    });
    if (state.highlight === id) state.highlight = null;
    saveTags(); renderSettings(); render();
    return;
  }
  if (t.closest('#btn-import')) { fileImport.click(); return; }
  if (t.closest('#btn-add-tag')) {
    const used = new Set(state.tags.map((x) => x.color));
    const color = (PALETTE.find((c) => !used.has(c.id)) || PALETTE[state.tags.length % PALETTE.length]).id;
    const tag = { id: uid(), name: 'Nuevo marcador', color };
    state.tags.push(tag);
    saveTags(); renderSettings();
    const input = settingsBody.querySelector(`[data-tag-name="${tag.id}"]`);
    input.focus(); input.select();
  }
});

settingsBody.addEventListener('input', (e) => {
  const id = e.target.dataset.tagName;
  if (!id) return;
  const tag = state.tags.find((x) => x.id === id);
  tag.name = e.target.value.trim() || 'Sin nombre';
  saveTags();
});
sheetSettings.addEventListener('sheetclosed', () => render());

/* ---------- Utilidades ---------- */

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const dShort = new Intl.DateTimeFormat('es-CL', { day: 'numeric', month: 'short' });
const dLong = new Intl.DateTimeFormat('es-CL', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
function fmtShort(v) { const d = new Date(v); return isNaN(d) ? '' : dShort.format(d).replace('.', ''); }
function fmtLong(v) { const d = new Date(v); return isNaN(d) ? '' : `para el ${dLong.format(d)}`; }
function fmtBytes(n) {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

/* ---------- Inicio ---------- */

/* ---------- Importar de Claude ----------
   Archivo .json con este formato (ver FORMATO-IMPORTAR.md):
   { format: 'planificador-feed', version: 1, posts: [
       { ref, position: 'top'|'bottom', status, kind: 'post'|'reel', caption, date, tags: [nombres], label, color,
         images: [{ name, type, data: base64 }] } ] }
   Las publicaciones vienen en el orden del perfil (la más nueva primero). */

const fileImport = $('#file-import');

function b64ToBlob(data, type) {
  const bin = atob(data.replace(/^data:[^,]+,/, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

async function importPackage(pkg) {
  if (!pkg || pkg.format !== 'planificador-feed' || !Array.isArray(pkg.posts)) throw new Error('formato');
  const existing = new Set(state.order.map((id) => state.posts.get(id).ref).filter(Boolean));
  const top = [], bottom = [];
  let skipped = 0;
  for (const item of pkg.posts) {
    if (item.ref && existing.has(item.ref)) { skipped++; continue; }
    const files = (item.images || []).map((img, i) => new File([b64ToBlob(img.data, img.type || 'image/jpeg')], img.name || `foto-${i + 1}.jpg`, { type: img.type || 'image/jpeg' }));
    const ids = await addImages(files.slice(0, CAROUSEL_MAX));
    const post = newPost(ids);
    if (item.ref) post.ref = item.ref;
    if (item.kind === 'reel') post.kind = 'reel';
    post.caption = String(item.caption || '');
    post.status = STATUS.some((s) => s.id === item.status) ? item.status : 'idea';
    post.date = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(item.date || '') ? item.date.slice(0, 16) : '';
    post.tags = (item.tags || [])
      .map((name) => state.tags.find((t) => t.name.toLowerCase() === String(name).toLowerCase())?.id)
      .filter(Boolean);
    if (!ids.length) { post.label = String(item.label || ''); if (PALETTE.some((c) => c.id === item.color)) post.color = item.color; }
    state.posts.set(post.id, post);
    await savePost(post);
    if (item.ref) existing.add(item.ref);
    (item.position === 'top' ? top : bottom).push(post.id);
  }
  flipTo([...top, ...state.order, ...bottom]);
  await saveOrder();
  return { added: top.length + bottom.length, skipped };
}

fileImport.addEventListener('change', async () => {
  const files = [...fileImport.files];
  fileImport.value = '';
  if (!files.length) return;
  closeSheet(sheetSettings);
  toast('Importando', 60000);
  let added = 0, skipped = 0, failed = 0;
  for (const f of files) {
    try {
      const r = await importPackage(JSON.parse(await f.text()));
      added += r.added; skipped += r.skipped;
    } catch (err) { console.error(err); failed++; }
  }
  const acc = state.accounts.find((a) => a.id === state.account)?.name || 'esta cuenta';
  const parts = [];
  if (added) parts.push(`${added} ${added === 1 ? 'publicación importada' : 'publicaciones importadas'} en ${acc}`);
  if (skipped) parts.push(`${skipped} ya ${skipped === 1 ? 'estaba' : 'estaban'}`);
  if (failed) parts.push(failed === files.length ? 'No se pudo leer el archivo. ¿Es el que preparó Claude?' : `${failed} ${failed === 1 ? 'archivo no se pudo leer' : 'archivos no se pudieron leer'}`);
  toast(parts.join('. ') || 'No había nada nuevo', 4200);
});

/* ---------- Cuentas ---------- */

const sheetAccounts = $('#sheet-accounts');
const accountsBody = $('#accounts-body');

function renderAccountName() {
  const acc = state.accounts.find((a) => a.id === state.account);
  $('#account-name').textContent = acc ? acc.name || 'Sin nombre' : 'Feed';
  document.title = acc ? `${acc.name} · Planificador de feed` : 'Planificador de feed';
}

function renderAccounts() {
  const cur = state.accounts.find((a) => a.id === state.account);
  const count = (id) => (state.orders[id] || []).length;
  accountsBody.innerHTML = `
    <div class="account-list">
      ${state.accounts.map((a) => `
        <button class="account-row" data-account="${a.id}" aria-current="${a.id === state.account}">
          <span class="acc-text"><strong>${esc(a.name || 'Sin nombre')}</strong><small>${count(a.id)} ${count(a.id) === 1 ? 'publicación' : 'publicaciones'}</small></span>
          <svg aria-hidden="true"><use href="#i-check"/></svg>
        </button>`).join('')}
    </div>
    <button class="btn btn-secondary add-tag" id="btn-add-account"><svg><use href="#i-plus"/></svg>Nueva cuenta</button>

    <section class="set-group account-edit">
      <div class="field" style="margin-top:0">
        <label class="field-label" for="account-name-input">Nombre de esta cuenta</label>
        <input type="text" id="account-name-input" maxlength="40" value="${esc(cur?.name || '')}" placeholder="Por ejemplo: @micuenta">
      </div>
      ${state.accounts.length > 1 ? `<div class="foot-actions"><button class="btn btn-danger" id="btn-del-account"><svg><use href="#i-trash"/></svg>Eliminar esta cuenta</button></div>` : ''}
      <p class="note" style="margin-top:12px">Cada cuenta tiene su propia grilla. Los marcadores y el formato de la grilla son los mismos para todas.</p>
    </section>`;
}

function switchAccount(id) {
  if (id === state.account) return;
  state.account = id;
  state.order = state.orders[id] || (state.orders[id] = []);
  state.highlight = null;
  store.put('meta', id, 'account');
  renderAccountName();
  render();
  window.scrollTo({ top: 0 });
}

$('#btn-account').addEventListener('click', () => { renderAccounts(); openSheet(sheetAccounts); });

accountsBody.addEventListener('click', async (e) => {
  const t = e.target;
  const row = t.closest('[data-account]');
  if (row) {
    switchAccount(row.dataset.account);
    closeSheet(sheetAccounts);
    return;
  }
  if (t.closest('#btn-add-account')) {
    const acc = { id: uid(), name: `Cuenta ${state.accounts.length + 1}` };
    state.accounts.push(acc);
    state.orders[acc.id] = [];
    await saveAccounts(); await saveOrder();
    switchAccount(acc.id);
    renderAccounts();
    const input = $('#account-name-input', accountsBody);
    input.focus(); input.select();
    return;
  }
  const del = t.closest('#btn-del-account');
  if (del) {
    const n = state.order.length;
    if (!del.classList.contains('armed')) {
      del.classList.add('armed');
      del.lastChild.textContent = n === 1 ? 'Toca otra vez: se borra su publicación' : n ? `Toca otra vez: se borran sus ${n} publicaciones` : 'Toca otra vez para eliminar';
      setTimeout(() => { if (del.isConnected) { del.classList.remove('armed'); del.lastChild.textContent = 'Eliminar esta cuenta'; } }, 3500);
      return;
    }
    const gone = state.account;
    for (const id of [...state.order]) {
      const p = state.posts.get(id);
      state.posts.delete(id);
      await store.del('posts', id);
      await store.del('images', p.images);
      p.images.forEach((img) => { URL.revokeObjectURL(state.thumbs.get(img)); state.thumbs.delete(img); state.dims.delete(img); });
    }
    state.accounts = state.accounts.filter((a) => a.id !== gone);
    delete state.orders[gone];
    await saveAccounts();
    switchAccount(state.accounts[0].id);
    await saveOrder();
    closeSheet(sheetAccounts);
    toast('Cuenta eliminada');
  }
});

accountsBody.addEventListener('input', (e) => {
  if (e.target.id !== 'account-name-input') return;
  const acc = state.accounts.find((a) => a.id === state.account);
  acc.name = e.target.value.trim();
  saveAccounts();
  renderAccountName();
  const strong = accountsBody.querySelector(`[data-account="${acc.id}"] strong`);
  if (strong) strong.textContent = acc.name || 'Sin nombre';
});

(async function init() {
  try {
    await load();
  } catch (err) {
    console.error(err);
    toast('No se pudo abrir el almacenamiento de este navegador.', 8000);
  }
  renderAccountName();
  render();
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
