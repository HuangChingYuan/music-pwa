// LRC 歌詞解析
// 支援：多重時間標籤 [00:12.30][01:02.00]、[offset:+/-ms]、標頭資訊、
//       增強型逐字標籤 <00:12.30>（會被去除，只保留整行時間）、無時間標籤的純文字歌詞。

const TIME_TAG = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
const LEAD_TAGS = /^(?:\s*\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\])+/;
const WORD_TAG = /<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g;
const META = /^\s*\[(ti|ar|al|au|by|offset|length|re|ve|#):([^\]]*)\]\s*$/i;

function toSec(m, s, frac) {
  return (+m) * 60 + (+s) + (frac ? parseFloat('0.' + frac) : 0);
}

/**
 * @param {string} text
 * @returns {{synced:boolean, lines:{t:number|null,text:string}[], meta:Object}}
 */
export function parseLRC(text) {
  const meta = {};
  const timed = [];
  const plain = [];
  let offset = 0;

  for (const raw of String(text || '').replace(/^﻿/, '').split(/\r\n|\r|\n/)) {
    const mm = raw.match(META);
    if (mm) {
      const key = mm[1].toLowerCase();
      meta[key] = mm[2].trim();
      if (key === 'offset') offset = parseInt(mm[2], 10) || 0;
      continue;
    }
    const lead = raw.match(LEAD_TAGS);
    if (!lead) {
      const s = raw.trim();
      if (s && !/^\[[^\]]*\]$/.test(s)) plain.push(s);
      continue;
    }
    const body = raw.slice(lead[0].length).replace(WORD_TAG, '').trim();
    TIME_TAG.lastIndex = 0;
    let m;
    while ((m = TIME_TAG.exec(lead[0]))) {
      timed.push({ t: toSec(m[1], m[2], m[3]), text: body });
    }
  }

  if (timed.length) {
    // [offset:+500] 代表歌詞提早 0.5 秒出現
    const shift = offset / 1000;
    const lines = timed
      .map((l, i) => ({ t: Math.max(0, l.t - shift), text: l.text, i }))
      .sort((a, b) => a.t - b.t || a.i - b.i)
      .map(({ t, text }) => ({ t, text }));
    // 合併連續空白行
    const merged = lines.filter((l, i) => l.text || !(i > 0 && !lines[i - 1].text));
    return { synced: true, lines: merged, meta };
  }
  return { synced: false, lines: plain.map(text => ({ t: null, text })), meta };
}

/** 二分搜尋：回傳 t 時間點應亮起的行索引（-1 = 第一行之前） */
export function lineAt(lines, t) {
  let lo = 0, hi = lines.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].t <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

/** 從音檔檔名或路徑取出不含副檔名的配對 key */
export function baseKey(name) {
  return String(name).split('/').pop().replace(/\.[^.]+$/, '').trim().toLowerCase();
}
