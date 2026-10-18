// 輕量 ID3v2.3 / v2.4 標籤讀取（MP3）：歌名、歌手、專輯、封面、內嵌歌詞 (USLT)
// 其他格式（M4A/FLAC…）會回傳空物件，改用檔名推測。

const synchsafe = (b, o) => (b[o] << 21) | (b[o + 1] << 14) | (b[o + 2] << 7) | b[o + 3];
const u32 = (b, o) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];

function unsync(data) {
  const out = [];
  for (let i = 0; i < data.length; i++) {
    out.push(data[i]);
    if (data[i] === 0xff && data[i + 1] === 0x00) i++;
  }
  return Uint8Array.from(out);
}

function decodeLegacy(bytes) {
  // 編碼 0 理論上是 Latin-1，但台灣/中國的檔案常直接塞 Big5 / GBK
  if (bytes.every(b => b < 0x80)) return new TextDecoder('latin1').decode(bytes);
  for (const enc of ['utf-8', 'big5', 'gbk']) {
    try { return new TextDecoder(enc, { fatal: true }).decode(bytes); } catch { /* 下一個 */ }
  }
  return new TextDecoder('latin1').decode(bytes);
}

function decode(bytes, enc) {
  let s;
  if (enc === 1) s = new TextDecoder('utf-16').decode(bytes);          // 帶 BOM
  else if (enc === 2) s = new TextDecoder('utf-16be').decode(bytes);
  else if (enc === 3) s = new TextDecoder('utf-8').decode(bytes);
  else s = decodeLegacy(bytes);
  return s.replace(/\u0000+$/g, '').replace(/\u0000/g, ' / ').trim();
}

/** 找出字串結尾（UTF-16 需對齊 2 bytes 的 00 00） */
function termEnd(data, start, enc) {
  if (enc === 1 || enc === 2) {
    for (let i = start; i + 1 < data.length; i += 2) if (data[i] === 0 && data[i + 1] === 0) return [i, i + 2];
  } else {
    for (let i = start; i < data.length; i++) if (data[i] === 0) return [i, i + 1];
  }
  return [data.length, data.length];
}

export async function readTags(file) {
  try {
    const head = new Uint8Array(await file.slice(0, 10).arrayBuffer());
    if (head[0] !== 0x49 || head[1] !== 0x44 || head[2] !== 0x33) return {};
    const ver = head[3];
    if (ver < 3 || ver > 4) return {};
    const flags = head[5];
    const size = synchsafe(head, 6);
    let buf = new Uint8Array(await file.slice(10, 10 + size).arrayBuffer());
    if (ver === 3 && (flags & 0x80)) buf = unsync(buf);

    let p = 0;
    if (flags & 0x40) p = ver === 4 ? synchsafe(buf, 0) : u32(buf, 0) + 4;

    const out = {};
    while (p + 10 <= buf.length) {
      const id = String.fromCharCode(buf[p], buf[p + 1], buf[p + 2], buf[p + 3]);
      if (!/^[A-Z0-9]{4}$/.test(id)) break;
      const fsz = ver === 4 ? synchsafe(buf, p + 4) : u32(buf, p + 4);
      const fflags = buf[p + 9];
      if (fsz <= 0 || p + 10 + fsz > buf.length) break;
      let data = buf.subarray(p + 10, p + 10 + fsz);
      p += 10 + fsz;
      if (ver === 4) {
        if (fflags & 0x01) data = data.subarray(4);   // data length indicator
        if (fflags & 0x02) data = unsync(data);
      }
      if (fflags & (ver === 4 ? 0x0c : 0xc0)) continue; // 壓縮/加密：略過

      const enc = data[0];
      switch (id) {
        case 'TIT2': out.title = decode(data.subarray(1), enc); break;
        case 'TPE1': out.artist = decode(data.subarray(1), enc); break;
        case 'TALB': out.album = decode(data.subarray(1), enc); break;
        case 'USLT': {
          const [, descEnd] = termEnd(data, 4, enc); // enc(1) + lang(3) + desc
          const txt = decode(data.subarray(descEnd), enc);
          if (txt && !out.lyrics) out.lyrics = txt;
          break;
        }
        case 'APIC': {
          if (out.picture && out.pictureType === 3) break;   // 已有封面（type 3）
          const [mimeEnd, mimeNext] = termEnd(data, 1, 0);
          let mime = new TextDecoder('latin1').decode(data.subarray(1, mimeEnd)).toLowerCase();
          if (!mime.includes('/')) mime = mime === 'png' ? 'image/png' : 'image/jpeg';
          const ptype = data[mimeNext];
          const [, descNext] = termEnd(data, mimeNext + 1, enc);
          out.picture = new Blob([data.slice(descNext)], { type: mime });
          out.pictureType = ptype;
          break;
        }
      }
    }
    return out;
  } catch (e) {
    console.warn('ID3 讀取失敗', e);
    return {};
  }
}

/** 從檔名推測「歌手 - 歌名」 */
export function guessFromName(name) {
  const base = String(name).split('/').pop().replace(/\.[^.]+$/, '').replace(/^\d{1,3}[\s._-]+/, '').trim();
  const m = base.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  return m ? { artist: m[1].trim(), title: m[2].trim() } : { title: base };
}
