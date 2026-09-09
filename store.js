// 端末内の保存。写真・音声は Blob のまま IndexedDB に置き、session.json は同じ DB の
// 別ストアに1件だけ持つ。サーバーには送らない（白浜はネットがあるが、
// 圏外・電波が細い場所でも記録が止まらないことを優先した。回収は zip 書き出しで行う）。
//
// 書き出す zip の中身は iOS 版の SessionExporter と同じ形にしてある：
//   session.json / photos/*.jpg / audio/*.m4a
// analysis/transcribe.py がそのまま使える。

const DB_NAME = 'toikake';
const DB_VERSION = 1;

function open() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions', { keyPath: 'session_id' });
      if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs', { keyPath: 'path' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

function tx(db, names, mode, fn) {
  return new Promise((res, rej) => {
    const t = db.transaction(names, mode);
    const out = fn(t);
    t.oncomplete = () => res(out && out.result !== undefined ? out.result : out);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
}

export const Store = {
  db: null,
  async init() { this.db = await open(); return this; },

  async putSession(s) { return tx(this.db, ['sessions'], 'readwrite', t => t.objectStore('sessions').put(s)); },

  async getSession(id) {
    return new Promise((res, rej) => {
      const r = this.db.transaction('sessions').objectStore('sessions').get(id);
      r.onsuccess = () => res(r.result || null); r.onerror = () => rej(r.error);
    });
  },

  async allSessions() {
    return new Promise((res, rej) => {
      const r = this.db.transaction('sessions').objectStore('sessions').getAll();
      r.onsuccess = () => res(r.result || []); r.onerror = () => rej(r.error);
    });
  },

  async putBlob(path, blob) { return tx(this.db, ['blobs'], 'readwrite', t => t.objectStore('blobs').put({ path, blob })); },

  async getBlob(path) {
    return new Promise((res, rej) => {
      const r = this.db.transaction('blobs').objectStore('blobs').get(path);
      r.onsuccess = () => res(r.result ? r.result.blob : null); r.onerror = () => rej(r.error);
    });
  },

  async usageMB() {
    if (!navigator.storage || !navigator.storage.estimate) return null;
    const e = await navigator.storage.estimate();
    return e.usage ? (e.usage / 1048576) : null;
  },
};

// ---- zip（無圧縮・STORE のみ）------------------------------------------------
// 外部ライブラリを入れないのは、圏外でも確実に動かすため（CDN を引かない）。
// STORE なので JPEG と m4a のサイズはほぼ変わらないが、1ファイルにまとまることが目的。

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(u8) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function dosTime(d) {
  const t = ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() / 2)) & 0xFFFF;
  const dt = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF;
  return { t, dt };
}

/** entries: [{name, data:Uint8Array}] → Blob（application/zip） */
export function makeZip(entries) {
  const enc = new TextEncoder();
  const now = dosTime(new Date());
  const locals = [], centrals = [];
  let offset = 0;

  for (const e of entries) {
    const name = enc.encode(e.name);
    const crc = crc32(e.data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
    lh.setUint16(8, 0, true); lh.setUint16(10, now.t, true); lh.setUint16(12, now.dt, true);
    lh.setUint32(14, crc, true); lh.setUint32(18, e.data.length, true); lh.setUint32(22, e.data.length, true);
    lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
    locals.push(new Uint8Array(lh.buffer), name, e.data);

    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true);
    ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
    ch.setUint16(12, now.t, true); ch.setUint16(14, now.dt, true);
    ch.setUint32(16, crc, true); ch.setUint32(20, e.data.length, true); ch.setUint32(24, e.data.length, true);
    ch.setUint16(28, name.length, true); ch.setUint16(30, 0, true); ch.setUint16(32, 0, true);
    ch.setUint16(34, 0, true); ch.setUint16(36, 0, true); ch.setUint32(38, 0, true);
    ch.setUint32(42, offset, true);
    centrals.push(new Uint8Array(ch.buffer), name);
    offset += 30 + name.length + e.data.length;
  }

  const centralSize = centrals.reduce((a, b) => a + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(4, 0, true); end.setUint16(6, 0, true);
  end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true); end.setUint32(16, offset, true); end.setUint16(20, 0, true);

  return new Blob([...locals, ...centrals, new Uint8Array(end.buffer)], { type: 'application/zip' });
}

const u8 = async blob => new Uint8Array(await blob.arrayBuffer());

/** セッション1件を zip にする（session.json ＋ photos/ ＋ audio/）。 */
export async function exportSession(session) {
  const entries = [{
    name: 'session.json',
    data: new TextEncoder().encode(JSON.stringify(session, null, 1)),
  }];
  for (const c of session.captures) {
    if (c.photo) {
      const b = await Store.getBlob(c.photo);
      if (b) entries.push({ name: c.photo, data: await u8(b) });
    }
    for (const a of c.answers) {
      const b = await Store.getBlob(a.audio);
      if (b) entries.push({ name: a.audio, data: await u8(b) });
    }
  }
  // 回答として数えなかった録音も入れる（VAD の取りこぼしを事後に評価するため）。
  for (const ev of session.events) {
    const m = /audio=(\S+)/.exec(ev.detail || '');
    if (!m) continue;
    if (entries.some(e => e.name === m[1])) continue;
    const b = await Store.getBlob(m[1]);
    if (b) entries.push({ name: m[1], data: await u8(b) });
  }
  return { blob: makeZip(entries), count: entries.length };
}
