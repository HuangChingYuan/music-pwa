// IndexedDB 曲庫：音檔以 Blob 存放，離線也能播放
const DB_NAME = 'lyric-player';
const STORE = 'tracks';
let dbp;

function open() {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const s = req.result.createObjectStore(STORE, { keyPath: 'id' });
      s.createIndex('addedAt', 'addedAt');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const s = t.objectStore(STORE);
    let result;
    Promise.resolve(fn(s)).then(r => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('transaction aborted'));
  });
}

const wrap = req => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

export const db = {
  all: () => tx('readonly', s => wrap(s.getAll())),
  get: id => tx('readonly', s => wrap(s.get(id))),
  put: rec => tx('readwrite', s => wrap(s.put(rec))),
  del: id => tx('readwrite', s => wrap(s.delete(id))),
  async patch(id, changes) {
    return tx('readwrite', async s => {
      const rec = await wrap(s.get(id));
      if (!rec) return null;
      Object.assign(rec, changes);
      await wrap(s.put(rec));
      return rec;
    });
  },
};
