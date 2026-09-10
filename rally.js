// ラリー（掘り下げ）のアプリ側。
//
// 位置づけ：9/7 MTG の「まず定型テンプレートで1ターン足す。対話型AIはプラスアルファ」に従い、
// これは**上に乗せるもの**。既定はオフ。使えないときは黙って定型テンプレートに戻る。
//
// 【現場で止めないための約束】
// ・鍵はここに持たない。/api/rally（Vercel の関数）に投げるだけ。
//   GitHub Pages 側にはその関数が無いので、起動時の確認で使えないと分かり、自動でオフになる。
// ・全部にタイムアウトを付ける。磯で電波が細ってもアプリは待たない。
// ・返ってきた問いが決定（「なぜ」を重ねない・対象を指定しない等）に反していたら使わない。
//   判定はサーバー側でもやるが、こちらでも見る。

const API = './api/rally';

export const Rally = {
  available: false,   // サーバー側に鍵があるか（起動時に1回だけ確かめる）
  get on() { try { return localStorage.getItem('rally_on') === '1'; } catch (e) { return false; } },
  set on(v) { try { localStorage.setItem('rally_on', v ? '1' : '0'); } catch (e) {} },
  /** 実際にラリーを使うか。使えると分かっていて、かつオンのときだけ。 */
  get active() { return this.available && this.on; },

  async probe(timeoutMs = 3000) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetch(API, { signal: ctl.signal });
      if (!r.ok) return (this.available = false);
      const j = await r.json();
      return (this.available = !!j.ready);
    } catch (e) {
      return (this.available = false);   // 関数が無い／電波が無い → 定型で動く
    } finally { clearTimeout(t); }
  },

  async call(payload, timeoutMs = 10000) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetch(API, { method: 'POST', signal: ctl.signal,
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      if (!r.ok) return { error: `${r.status}` };
      return await r.json();
    } catch (e) {
      return { error: String(e.name === 'AbortError' ? 'timeout' : e.message || e) };
    } finally { clearTimeout(t); }
  },
};

/** 生成された問いが決定に反していないかを見る（サーバー側と同じ規則） */
export function isUsableQuestion(q) {
  if (!q || typeof q !== 'string') return false;
  const s = q.trim();
  if (s.length < 4 || s.length > 40) return false;
  if (/なぜ|どうして|なんで/.test(s)) return false;
  if (/生き物|風景|文字ですか/.test(s)) return false;
  if (/を撮って|を探して|を見つけて/.test(s)) return false;
  if (s.split(/[。？?]/).filter(Boolean).length > 1) return false;
  return true;
}

// ---- 音声を 16kHz モノラルの WAV にする -------------------------------------
// MediaRecorder の出力は端末によって audio/mp4 だったり audio/webm だったりする。
// どれが通るかを端末任せにすると当日になって片方だけ落ちる。WAV に揃えて端末差を消す。

export async function toWavBase64(blob, maxSeconds = 30) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  let buf;
  try { buf = await ctx.decodeAudioData(await blob.arrayBuffer()); }
  finally { try { ctx.close(); } catch (e) {} }
  const rate = 16000;
  const off = new OfflineAudioContext(1, Math.ceil(Math.min(buf.duration, maxSeconds) * rate), rate);
  const src = off.createBufferSource();
  src.buffer = buf; src.connect(off.destination); src.start();
  const pcm = (await off.startRendering()).getChannelData(0);

  const dv = new DataView(new ArrayBuffer(44 + pcm.length * 2));
  const str = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); dv.setUint32(4, 36 + pcm.length * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, rate, true); dv.setUint32(28, rate * 2, true);
  dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  str(36, 'data'); dv.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) {
    const v = Math.max(-1, Math.min(1, pcm[i]));
    dv.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7FFF, true);
  }
  let bin = ''; const u8 = new Uint8Array(dv.buffer);
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(bin);
}
