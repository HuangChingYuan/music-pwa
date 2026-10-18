import { db } from './db.js';
import { parseLRC, lineAt, baseKey } from './lrc.js';
import { readTags, guessFromName } from './tags.js';

const $ = s => document.querySelector(s);
const audio = $('#audio');
const AUDIO_EXT = /\.(mp3|m4a|aac|mp4|flac|ogg|oga|opus|wav|webm|weba|caf|aiff?)$/i;
const LRC_EXT = /\.(lrc|txt)$/i;
const STATE_KEY = 'lyricPlayer.state.v1';

const el = {
  list: $('#trackList'), empty: $('#emptyState'), count: $('#libCount'), search: $('#searchInput'), storage: $('#storageInfo'),
  art: $('#art'), title: $('#nowTitle'), artist: $('#nowArtist'),
  miniArt: $('#miniArt'), miniTitle: $('#miniTitle'), miniArtist: $('#miniArtist'),
  lyrics: $('#lyrics'), lyricsState: $('#lyricsState'), offsetCtl: $('#offsetCtl'), offsetVal: $('#offsetVal'),
  loadLrc: $('#loadLrcBtn'), clearLrc: $('#clearLrcBtn'), resync: $('#resyncBtn'),
  seek: $('#seek'), cur: $('#curTime'), dur: $('#durTime'),
  play: $('#playBtn'), prev: $('#prevBtn'), next: $('#nextBtn'), shuffle: $('#shuffleBtn'), repeat: $('#repeatBtn'), volume: $('#volume'),
  toast: $('#toast'), drop: $('#dropHint'), backdrop: document.querySelector('.backdrop-art'),
};

/* ================= 狀態 ================= */
const state = {
  tracks: [],          // 曲庫（依加入時間）
  order: [],           // 播放佇列：track id 陣列
  pos: -1,             // 目前在 order 的位置
  current: null,       // 目前曲目紀錄
  shuffle: false,
  repeat: 'off',       // off | all | one
  lyric: null,         // { synced, lines }
  lyricIdx: -2,
  userScrollUntil: 0,
  seeking: false,
};
let objectUrl = null;

/* ================= 工具 ================= */
const fmt = s => {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60), ss = Math.floor(s % 60);
  return `${m}:${String(ss).padStart(2, '0')}`;
};
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let toastTimer;
function toast(msg, ms = 2600) {
  el.toast.textContent = msg;
  el.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('show'), ms);
}
async function hashId(file) {
  const s = `${file.name}|${file.size}|${file.lastModified || 0}`;
  const d = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(s)).catch(() => null);
  if (!d) return s;
  return [...new Uint8Array(d)].slice(0, 10).map(b => b.toString(16).padStart(2, '0')).join('');
}
async function readText(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  for (const enc of ['utf-8', 'big5', 'gbk', 'utf-16']) {
    try { return new TextDecoder(enc, { fatal: true }).decode(buf); } catch { /* 下一個 */ }
  }
  return new TextDecoder().decode(buf);
}

/** 封面縮圖 + 主色 */
async function processArt(blob) {
  try {
    const bmp = await createImageBitmap(blob);
    const draw = size => {
      const c = document.createElement('canvas');
      const scale = Math.min(1, size / Math.max(bmp.width, bmp.height));
      c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      return c;
    };
    const art = draw(512).toDataURL('image/jpeg', 0.86);
    const thumb = draw(112).toDataURL('image/jpeg', 0.8);
    const small = draw(24);
    const px = small.getContext('2d').getImageData(0, 0, small.width, small.height).data;
    let r = 0, g = 0, b = 0, w = 0;
    for (let i = 0; i < px.length; i += 4) {
      const mx = Math.max(px[i], px[i + 1], px[i + 2]), mn = Math.min(px[i], px[i + 1], px[i + 2]);
      const wt = (mx - mn) / 255 + 0.05;           // 越鮮豔權重越高
      r += px[i] * wt; g += px[i + 1] * wt; b += px[i + 2] * wt; w += wt;
    }
    bmp.close?.();
    return { art, thumb, color: [r / w, g / w, b / w].map(Math.round) };
  } catch { return {}; }
}

function applyAccent(rgb) {
  const root = document.documentElement.style;
  if (!rgb) { root.removeProperty('--accent'); root.removeProperty('--accent-ink'); return; }
  // 轉 HSL，調整到在深色背景上夠亮、夠飽和
  let [r, g, b] = rgb.map(v => v / 255);
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l0 = (mx + mn) / 2, d = mx - mn;
  let h = 0, s = d === 0 ? 0 : d / (1 - Math.abs(2 * l0 - 1));
  if (d) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = Math.round(h * 60 + 360) % 360;
  s = s < 0.12 ? 0.08 : Math.min(0.85, Math.max(0.5, s));
  const l = 0.66;
  root.setProperty('--accent', `hsl(${h} ${Math.round(s * 100)}% ${l * 100}%)`);
  root.setProperty('--accent-ink', `hsl(${h} 40% 9%)`);
}

/* ================= 匯入 ================= */
async function importFiles(fileList) {
  const files = [...fileList];
  const audios = files.filter(f => AUDIO_EXT.test(f.name) || (f.type.startsWith('audio/') && !LRC_EXT.test(f.name)));
  const lrcs = new Map();
  for (const f of files.filter(f => LRC_EXT.test(f.name))) lrcs.set(baseKey(f.name), f);
  if (!audios.length && !lrcs.size) { toast('沒有可匯入的音樂或 LRC 檔'); return; }

  let added = 0, matched = 0;
  const existing = new Set(state.tracks.map(t => t.id));
  for (const [i, f] of audios.entries()) {
    if (audios.length > 3) toast(`匯入中… ${i + 1}/${audios.length}`, 60000);
    const id = await hashId(f);
    if (existing.has(id)) continue;
    const tags = await readTags(f);
    const guess = guessFromName(f.name);
    const key = baseKey(f.name);
    let lrc = null;
    if (lrcs.has(key)) { lrc = await readText(lrcs.get(key)); lrcs.delete(key); matched++; }
    else if (tags.lyrics) lrc = tags.lyrics;
    const art = tags.picture ? await processArt(tags.picture) : {};
    const rec = {
      id, key, name: f.name, blob: f, type: f.type, size: f.size,
      title: tags.title || guess.title, artist: tags.artist || guess.artist || '', album: tags.album || '',
      art: art.art || null, thumb: art.thumb || null, color: art.color || null,
      lrc, lrcOffset: 0, duration: null, addedAt: Date.now() + i,
    };
    try {
      await db.put(rec);
      state.tracks.push(rec); existing.add(id); added++;
    } catch (e) {
      console.error(e);
      toast(e?.name === 'QuotaExceededError' ? '儲存空間不足，部分檔案未匯入' : `匯入失敗：${f.name}`);
      break;
    }
  }

  // 剩下的 LRC：配對到曲庫中已存在的曲目
  for (const [key, f] of lrcs) {
    const t = state.tracks.find(t => t.key === key);
    if (!t) continue;
    t.lrc = await readText(f);
    await db.patch(t.id, { lrc: t.lrc });
    matched++;
    if (t === state.current) loadLyrics(t);
  }

  renderList();
  updateStorage();
  navigator.storage?.persist?.().catch(() => {});
  const parts = [];
  if (added) parts.push(`新增 ${added} 首`);
  if (matched) parts.push(`配對 ${matched} 份歌詞`);
  toast(parts.length ? parts.join('，') : '這些檔案已在曲庫中');
  if (added && !state.current) playId(state.tracks[state.tracks.length - added].id, false);
}

/* ================= 曲庫清單 ================= */
function renderList() {
  const q = el.search.value.trim().toLowerCase();
  const list = q ? state.tracks.filter(t => `${t.title} ${t.artist} ${t.album} ${t.name}`.toLowerCase().includes(q)) : state.tracks;
  el.count.textContent = state.tracks.length ? state.tracks.length : '';
  el.empty.hidden = state.tracks.length > 0;
  el.list.hidden = state.tracks.length === 0;
  el.list.innerHTML = list.map(t => {
    const lyr = t.lrc ? (/\[\d{1,3}:\d{1,2}/.test(t.lrc) ? '<span class="badge sync">LRC</span>' : '<span class="badge">詞</span>') : '';
    const thumb = t.thumb ? `style="background-image:url('${t.thumb}')"` : '';
    return `<li class="track${state.current?.id === t.id ? ' playing' : ''}" data-id="${t.id}" tabindex="0">
      <span class="thumb" ${thumb}>${t.thumb ? '' : '<svg><use href="#i-disc"/></svg>'}</span>
      <span class="t"><div class="name">${esc(t.title)}</div><div class="sub">${lyr}<span>${esc(t.artist || '未知歌手')}${t.duration ? ' · ' + fmt(t.duration) : ''}</span></div></span>
      <button class="del" data-del="${t.id}" aria-label="從曲庫移除 ${esc(t.title)}"><svg><use href="#i-trash"/></svg></button>
    </li>`;
  }).join('') + (q && !list.length ? '<li class="track" style="cursor:default;color:var(--muted)">找不到符合的歌曲</li>' : '');
}

async function removeTrack(id) {
  const t = state.tracks.find(x => x.id === id);
  if (!t || !confirm(`從曲庫移除「${t.title}」？`)) return;
  await db.del(id);
  state.tracks = state.tracks.filter(x => x.id !== id);
  const wasCurrent = state.current?.id === id;
  const i = state.order.indexOf(id);
  if (i >= 0) { state.order.splice(i, 1); if (i < state.pos) state.pos--; }
  if (wasCurrent) {
    audio.pause(); audio.removeAttribute('src'); audio.load();
    state.current = null;
    if (state.order.length) await playIndex(Math.min(state.pos, state.order.length - 1), false);
    else showNowPlaying(null);
  }
  renderList(); updateStorage(); saveState();
}

async function updateStorage() {
  if (!navigator.storage?.estimate) return;
  const { usage = 0, quota = 0 } = await navigator.storage.estimate();
  const mb = n => (n / 1048576).toFixed(n > 1e9 ? 0 : 1);
  el.storage.textContent = state.tracks.length ? `已使用 ${mb(usage)} MB / 可用約 ${mb(quota)} MB` : '';
}

/* ================= 播放佇列 ================= */
function buildOrder(startId) {
  const ids = state.tracks.map(t => t.id);
  if (state.shuffle) {
    for (let i = ids.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [ids[i], ids[j]] = [ids[j], ids[i]]; }
    if (startId) { ids.splice(ids.indexOf(startId), 1); ids.unshift(startId); }
  }
  state.order = ids;
  state.pos = startId ? ids.indexOf(startId) : 0;
}

async function playId(id, autoplay = true) {
  if (!state.order.includes(id) || state.order.length !== state.tracks.length) buildOrder(id);
  else state.pos = state.order.indexOf(id);
  await playIndex(state.pos, autoplay);
}

async function playIndex(pos, autoplay = true, startAt = 0) {
  const id = state.order[pos];
  const t = state.tracks.find(x => x.id === id);
  if (!t) return;
  state.pos = pos;
  state.current = t;
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(t.blob);
  audio.src = objectUrl;
  if (startAt) audio.addEventListener('loadedmetadata', () => { audio.currentTime = Math.min(startAt, (audio.duration || startAt) - 1); }, { once: true });
  showNowPlaying(t);
  loadLyrics(t);
  renderList();
  saveState();
  if (autoplay) {
    try { await audio.play(); }
    catch (e) {
      if (e.name === 'NotSupportedError') { toast(`此裝置無法播放「${t.title}」的格式`); }
      else if (e.name !== 'AbortError') console.warn(e);
    }
  }
}

function next(auto = false) {
  if (!state.order.length) return;
  if (auto && state.repeat === 'one') { audio.currentTime = 0; audio.play(); return; }
  let p = state.pos + 1;
  if (p >= state.order.length) {
    if (auto && state.repeat === 'off') { audio.pause(); audio.currentTime = 0; return; }
    if (state.shuffle) buildOrder(null);
    p = 0;
  }
  playIndex(p, true);
}
function prev() {
  if (!state.order.length) return;
  if (audio.currentTime > 3) { audio.currentTime = 0; return; }
  playIndex(state.pos > 0 ? state.pos - 1 : state.order.length - 1, true);
}
function togglePlay() {
  if (!state.current) { if (state.tracks.length) playId(state.tracks[0].id); return; }
  audio.paused ? audio.play().catch(() => {}) : audio.pause();
}

/* ================= 播放中畫面 + Media Session ================= */
function showNowPlaying(t) {
  const title = t?.title || '尚未播放';
  const artist = t ? (t.artist || '未知歌手') + (t.album ? ` · ${t.album}` : '') : '選一首歌開始';
  el.title.textContent = title; el.artist.textContent = artist;
  el.miniTitle.textContent = t?.title || '—'; el.miniArtist.textContent = t?.artist || '';
  for (const img of [el.art, el.miniArt]) {
    if (t?.art) { img.src = img === el.miniArt ? (t.thumb || t.art) : t.art; img.hidden = false; }
    else { img.removeAttribute('src'); img.hidden = true; }
  }
  el.backdrop.style.setProperty('--bg-art', t?.art ? `url("${t.art}")` : 'none');
  applyAccent(t?.color);
  document.title = t ? `${t.title} — 聲軌` : '聲軌 Lyric Player';
  el.loadLrc.disabled = !t;

  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = t ? new MediaMetadata({
      title: t.title, artist: t.artist || '', album: t.album || '',
      artwork: t.art ? [{ src: t.art, sizes: '512x512', type: 'image/jpeg' }]
                     : [{ src: new URL('icons/icon-512.png', location.href).href, sizes: '512x512', type: 'image/png' }],
    }) : null;
  }
}

function updatePositionState() {
  if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
  const d = audio.duration;
  if (!isFinite(d) || d <= 0) return;
  try {
    navigator.mediaSession.setPositionState({ duration: d, playbackRate: audio.playbackRate || 1, position: Math.min(audio.currentTime, d) });
  } catch { /* 部分瀏覽器在切換時會丟錯 */ }
}

function setupMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const ms = navigator.mediaSession;
  const handlers = {
    play: () => audio.play(),
    pause: () => audio.pause(),
    stop: () => { audio.pause(); audio.currentTime = 0; },
    previoustrack: prev,
    nexttrack: () => next(),
    seekbackward: d => { audio.currentTime = Math.max(0, audio.currentTime - (d.seekOffset || 10)); updatePositionState(); },
    seekforward: d => { audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + (d.seekOffset || 10)); updatePositionState(); },
    seekto: d => {
      if (d.fastSeek && 'fastSeek' in audio) audio.fastSeek(d.seekTime);
      else audio.currentTime = d.seekTime;
      updatePositionState();
    },
  };
  for (const [action, fn] of Object.entries(handlers)) {
    try { ms.setActionHandler(action, fn); } catch { /* 不支援的 action */ }
  }
}

/* ================= 歌詞 ================= */
function loadLyrics(t) {
  state.lyricIdx = -2;
  state.lyric = t?.lrc ? parseLRC(t.lrc) : null;
  const L = state.lyric;
  el.lyrics.className = 'lyrics' + (L ? (L.synced ? ' synced blur' : ' plain') : '');
  el.offsetCtl.hidden = !L?.synced;
  el.clearLrc.hidden = !t?.lrc;
  el.offsetVal.textContent = `${(t?.lrcOffset || 0) >= 0 ? '+' : ''}${(t?.lrcOffset || 0).toFixed(1)}s`;
  el.resync.hidden = true;

  if (!t) { el.lyrics.innerHTML = ''; el.lyricsState.textContent = ''; return; }
  if (!L || !L.lines.length) {
    el.lyricsState.textContent = '沒有歌詞';
    el.lyrics.innerHTML = `<p class="note">這首歌沒有歌詞。<br>匯入同名的 .lrc 檔，或按「載入 LRC」手動指定。</p>`;
    return;
  }
  el.lyricsState.textContent = L.synced ? `同步歌詞 · ${L.lines.length} 行` : '純文字歌詞（無時間軸）';
  el.lyrics.innerHTML = L.lines.map((l, i) =>
    `<p data-i="${i}"${l.text ? '' : ' class="gap"'}>${l.text ? esc(l.text) : '•••'}</p>`).join('');
  el.lyrics.scrollTop = 0;
  syncLyrics(true);
}

function lyricTime() { return audio.currentTime + (state.current?.lrcOffset || 0) * -1; }

function syncLyrics(force = false) {
  const L = state.lyric;
  if (!L?.synced) return;
  const t = lyricTime();
  const idx = lineAt(L.lines, t);
  const nodes = el.lyrics.children;

  if (idx !== state.lyricIdx || force) {
    nodes[state.lyricIdx]?.classList.remove('active');
    for (const n of el.lyrics.querySelectorAll('.near')) n.classList.remove('near');
    state.lyricIdx = idx;
    const cur = nodes[idx];
    if (cur) {
      cur.classList.add('active');
      // 只有單行歌詞才做逐字填色，換行的長句直接整句亮起
      const lh = parseFloat(getComputedStyle(cur).lineHeight) || 30;
      cur.classList.toggle('wipe', cur.clientHeight - 14 < lh * 1.5);
      nodes[idx + 1]?.classList.add('near');
      nodes[idx - 1]?.classList.add('near');
    }
    if (Date.now() > state.userScrollUntil) scrollToLine(force ? 'auto' : 'smooth');
  }
  // 逐行填色進度
  const cur = nodes[idx];
  if (cur) {
    const start = L.lines[idx].t;
    const end = L.lines[idx + 1]?.t ?? (audio.duration || start + 5);
    const p = Math.max(0, Math.min(1, (t - start) / Math.max(0.3, end - start)));
    cur.style.setProperty('--p', `${(p * 100).toFixed(1)}%`);
  }
}

function scrollToLine(behavior = 'smooth') {
  const n = el.lyrics.children[Math.max(0, state.lyricIdx)];
  if (!n) return;
  const top = n.offsetTop - el.lyrics.clientHeight * 0.38 + n.offsetHeight / 2;
  el.lyrics.scrollTo({ top, behavior });
  el.resync.hidden = true;
}

// rAF 迴圈：畫面可見且播放時才跑；背景時完全不動 DOM 以省電
let raf = 0;
function loop() {
  raf = 0;
  if (document.hidden || audio.paused) return;
  syncLyrics();
  updateProgress();
  raf = requestAnimationFrame(loop);
}
const startLoop = () => { if (!raf && !document.hidden && !audio.paused) raf = requestAnimationFrame(loop); };

function updateProgress() {
  if (state.seeking) return;
  const d = audio.duration, c = audio.currentTime;
  el.cur.textContent = fmt(c);
  el.dur.textContent = fmt(d);
  const ratio = isFinite(d) && d > 0 ? c / d : 0;
  el.seek.value = Math.round(ratio * 1000);
  el.seek.style.setProperty('--fill', `${(ratio * 100).toFixed(2)}%`);
}

async function setOffset(delta) {
  const t = state.current; if (!t) return;
  t.lrcOffset = Math.round(((t.lrcOffset || 0) + delta) * 10) / 10;
  el.offsetVal.textContent = `${t.lrcOffset >= 0 ? '+' : ''}${t.lrcOffset.toFixed(1)}s`;
  await db.patch(t.id, { lrcOffset: t.lrcOffset });
  syncLyrics(true);
}

/* ================= 狀態保存 ================= */
let saveTimer;
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(STATE_KEY, JSON.stringify({
        order: state.order, pos: state.pos, time: audio.currentTime || 0,
        shuffle: state.shuffle, repeat: state.repeat, volume: audio.volume,
      }));
    } catch { /* 私密模式 */ }
  }, 300);
}
function loadSaved() {
  try { return JSON.parse(localStorage.getItem(STATE_KEY)) || {}; } catch { return {}; }
}

function setShuffle(on) {
  state.shuffle = on;
  el.shuffle.setAttribute('aria-pressed', String(on));
  if (state.tracks.length) buildOrder(state.current?.id || null);
}
function setRepeat(mode) {
  state.repeat = mode;
  el.repeat.dataset.mode = mode;
  el.repeat.setAttribute('aria-label', `重複：${{ off: '關閉', all: '全部', one: '單曲' }[mode]}`);
}
function setTab(tab) {
  document.body.dataset.tab = tab;
  for (const b of document.querySelectorAll('.tabs button')) {
    if (b.dataset.tab === tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  }
  if (tab === 'now') requestAnimationFrame(() => { syncLyrics(true); scrollToLine('auto'); });
}

/* ================= 事件 ================= */
function bindEvents() {
  const fileInput = $('#fileInput'), folderInput = $('#folderInput'), lrcInput = $('#lrcInput');
  const pickFiles = () => fileInput.click();
  $('#addFilesBtn').onclick = pickFiles;
  document.querySelector('[data-action="add-files"]').onclick = pickFiles;
  $('#addFolderBtn').onclick = () => folderInput.click();
  fileInput.onchange = () => { importFiles(fileInput.files); fileInput.value = ''; };
  folderInput.onchange = () => { importFiles(folderInput.files); folderInput.value = ''; };

  $('#demoBtn').onclick = async e => {
    const btn = e.currentTarget;
    btn.disabled = true;
    toast('正在合成示範曲…');
    const { makeDemo } = await import('./demo.js');
    const d = await makeDemo();
    const file = new File([d.blob], d.name, { type: 'audio/wav', lastModified: 1 });
    const lrc = new File([d.lrc], d.name.replace(/\.wav$/, '.lrc'), { type: 'text/plain' });
    await importFiles([file, lrc]);
    btn.disabled = false;
  };

  el.loadLrc.onclick = () => lrcInput.click();
  lrcInput.onchange = async () => {
    const f = lrcInput.files[0]; lrcInput.value = '';
    if (!f || !state.current) return;
    state.current.lrc = await readText(f);
    await db.patch(state.current.id, { lrc: state.current.lrc });
    loadLyrics(state.current); renderList();
    toast(state.lyric?.synced ? '已載入同步歌詞' : '已載入歌詞（沒有時間標籤）');
  };
  el.clearLrc.onclick = async () => {
    if (!state.current || !confirm('移除這首歌的歌詞？')) return;
    state.current.lrc = null;
    await db.patch(state.current.id, { lrc: null });
    loadLyrics(state.current); renderList();
  };
  el.offsetCtl.onclick = e => { const b = e.target.closest('[data-offset]'); if (b) setOffset(+b.dataset.offset); };

  // 清單
  el.list.addEventListener('click', e => {
    const del = e.target.closest('[data-del]');
    if (del) { e.stopPropagation(); removeTrack(del.dataset.del); return; }
    const li = e.target.closest('.track[data-id]');
    if (!li) return;
    if (state.current?.id === li.dataset.id) togglePlay(); else playId(li.dataset.id);
  });
  el.list.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.matches('.track[data-id]')) playId(e.target.dataset.id);
  });
  el.search.addEventListener('input', renderList);

  // 歌詞：點擊跳轉、手動捲動時暫停自動捲動
  el.lyrics.addEventListener('click', e => {
    const p = e.target.closest('p[data-i]');
    if (!p || !state.lyric?.synced) return;
    const line = state.lyric.lines[+p.dataset.i];
    audio.currentTime = Math.max(0, line.t + (state.current?.lrcOffset || 0) + 0.01);
    if (audio.paused) audio.play().catch(() => {});
    state.userScrollUntil = 0;
    syncLyrics(true); updatePositionState();
  });
  const userScrolled = () => {
    if (!state.lyric?.synced) return;
    state.userScrollUntil = Date.now() + 3500;
    el.resync.hidden = false;
  };
  el.lyrics.addEventListener('wheel', userScrolled, { passive: true });
  el.lyrics.addEventListener('touchmove', userScrolled, { passive: true });
  el.resync.onclick = () => { state.userScrollUntil = 0; scrollToLine(); };
  setInterval(() => {
    if (!el.resync.hidden && Date.now() > state.userScrollUntil && !audio.paused && !document.hidden) scrollToLine();
  }, 1000);

  // 播放控制
  el.play.onclick = togglePlay;
  el.next.onclick = () => next();
  el.prev.onclick = prev;
  el.shuffle.onclick = () => { setShuffle(!state.shuffle); saveState(); };
  el.repeat.onclick = () => { setRepeat({ off: 'all', all: 'one', one: 'off' }[state.repeat]); saveState(); };
  $('#miniInfo').onclick = () => { if (matchMedia('(max-width: 859px)').matches) setTab('now'); };
  for (const b of document.querySelectorAll('.tabs button')) b.onclick = () => setTab(b.dataset.tab);

  el.volume.addEventListener('input', () => {
    audio.volume = +el.volume.value;
    el.volume.style.setProperty('--fill', `${el.volume.value * 100}%`);
    saveState();
  });

  // 進度條
  el.seek.addEventListener('input', () => {
    state.seeking = true;
    const t = (el.seek.value / 1000) * (audio.duration || 0);
    el.cur.textContent = fmt(t);
    el.seek.style.setProperty('--fill', `${el.seek.value / 10}%`);
  });
  el.seek.addEventListener('change', () => {
    if (isFinite(audio.duration)) audio.currentTime = (el.seek.value / 1000) * audio.duration;
    state.seeking = false;
    state.userScrollUntil = 0;
    syncLyrics(true); updatePositionState(); saveState();
  });

  // audio 事件
  audio.addEventListener('play', () => {
    el.play.innerHTML = '<svg><use href="#i-pause"/></svg>'; el.play.setAttribute('aria-label', '暫停');
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
    updatePositionState(); startLoop();
  });
  audio.addEventListener('pause', () => {
    el.play.innerHTML = '<svg><use href="#i-play"/></svg>'; el.play.setAttribute('aria-label', '播放');
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
    updatePositionState(); saveState();
  });
  audio.addEventListener('ended', () => next(true));
  audio.addEventListener('loadedmetadata', async () => {
    updateProgress(); updatePositionState();
    const t = state.current;
    if (t && !t.duration && isFinite(audio.duration)) {
      t.duration = audio.duration;
      db.patch(t.id, { duration: t.duration }).catch(() => {});
      renderList();
    }
  });
  audio.addEventListener('seeked', () => { syncLyrics(true); updateProgress(); });
  audio.addEventListener('ratechange', updatePositionState);
  // 背景時 rAF 不跑，timeupdate 仍會觸發：只存進度，不碰 DOM
  let lastSave = 0;
  audio.addEventListener('timeupdate', () => {
    if (document.hidden) { if (Date.now() - lastSave > 5000) { lastSave = Date.now(); saveState(); } return; }
    if (audio.paused) { syncLyrics(); updateProgress(); }
  });
  audio.addEventListener('error', () => {
    if (state.current && audio.error) toast(`無法播放「${state.current.title}」（格式不支援或檔案損毀）`);
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { syncLyrics(true); updateProgress(); startLoop(); }
    else saveState();
  });
  window.addEventListener('pagehide', saveState);

  // 鍵盤
  document.addEventListener('keydown', e => {
    if (e.target.matches('input, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.code === 'Space' && !e.target.matches('button, li')) { e.preventDefault(); togglePlay(); }
    else if (e.key === 'ArrowRight') { audio.currentTime += e.shiftKey ? 30 : 5; }
    else if (e.key === 'ArrowLeft') { audio.currentTime -= e.shiftKey ? 30 : 5; }
    else if (e.key.toLowerCase() === 'n') next();
    else if (e.key.toLowerCase() === 'p') prev();
  });

  // 拖放匯入
  let dragDepth = 0;
  window.addEventListener('dragenter', e => { if (e.dataTransfer?.types.includes('Files')) { dragDepth++; el.drop.hidden = false; } });
  window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; el.drop.hidden = true; } });
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => {
    e.preventDefault(); dragDepth = 0; el.drop.hidden = true;
    if (e.dataTransfer?.files.length) importFiles(e.dataTransfer.files);
  });

  // 安裝提示
  let deferred;
  const installBtn = $('#installBtn');
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferred = e; installBtn.hidden = false; });
  installBtn.onclick = async () => { if (!deferred) return; deferred.prompt(); await deferred.userChoice; deferred = null; installBtn.hidden = true; };
  window.addEventListener('appinstalled', () => { installBtn.hidden = true; toast('已安裝到裝置'); });

  // 桌面版：作業系統「用聲軌開啟」音檔（manifest file_handlers）
  if ('launchQueue' in window) {
    window.launchQueue.setConsumer(async params => {
      if (!params.files?.length) return;
      const files = await Promise.all(params.files.map(h => h.getFile()));
      await importFiles(files);
    });
  }
}

/* ================= 啟動 ================= */
async function init() {
  bindEvents();
  setupMediaSession();
  try {
    state.tracks = (await db.all()).sort((a, b) => a.addedAt - b.addedAt);
  } catch (e) {
    console.error(e);
    toast('無法開啟本機資料庫（私密瀏覽模式可能不支援）', 5000);
  }
  const saved = loadSaved();
  setRepeat(saved.repeat || 'off');
  state.shuffle = !!saved.shuffle;
  el.shuffle.setAttribute('aria-pressed', String(state.shuffle));
  if (typeof saved.volume === 'number') { audio.volume = saved.volume; el.volume.value = saved.volume; }
  el.volume.style.setProperty('--fill', `${audio.volume * 100}%`);

  renderList();
  updateStorage();
  if (state.tracks.length) {
    const ids = new Set(state.tracks.map(t => t.id));
    const order = (saved.order || []).filter(id => ids.has(id));
    if (order.length === state.tracks.length) {
      state.order = order;
      const id = saved.order?.[saved.pos];
      const pos = Math.max(0, order.indexOf(id));
      await playIndex(pos, false, saved.time || 0);
    } else {
      buildOrder(state.tracks[0].id);
      await playIndex(0, false);
    }
    if (!matchMedia('(min-width: 860px)').matches && saved.time) setTab('now');
  } else {
    showNowPlaying(null);
  }

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').then(reg => {
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        w?.addEventListener('statechange', () => {
          if (w.state === 'installed' && navigator.serviceWorker.controller) toast('有新版本，重新開啟 App 即可更新', 5000);
        });
      });
    }).catch(e => console.warn('SW 註冊失敗', e));
  }

  // iOS Safari 沒有安裝提示：第一次用瀏覽器開啟時提醒一次
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  if (isIOS && !standalone && !localStorage.getItem('lyricPlayer.iosHint')) {
    setTimeout(() => toast('在 Safari 按「分享 → 加入主畫面」即可安裝，背景播放更穩定', 6000), 1500);
    try { localStorage.setItem('lyricPlayer.iosHint', '1'); } catch { /* ignore */ }
  }
}

init();
