// ラリー（掘り下げ）のサーバー側。Vercel の関数として動く。
//
// なぜサーバーを挟むのか：Gemini の鍵を端末に置かないため。
// 配布は URL を配るだけなので、鍵をアプリに埋めると誰でも取り出せる。
// 鍵は Vercel の環境変数 GEMINI_API_KEY にだけ置き、ここからしか使わない。
//
// この関数が無い環境（GitHub Pages の予備）では単に 404 になり、
// アプリ側はラリーを黙ってオフにして定型テンプレートで動き続ける。

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta';

// 文面の制約は、これまでの決定をそのまま条件にしてある。破った出力は採用しない（下の検査）。
const RULES = `あなたはフィールドワーク中の学生に、短い問いを1つだけ返す役です。日本語。
守ること:
- 撮るもの・見るものを指定しない。対象は学生が決める。
- 「なぜ」「どうして」は使わない。理由はもう聞いた後なので、重ねると答えが薄くなる。
- 生き物・もの・風景・文字のような分類名を問いに出さない。
- 比喩や気取った言い回しを使わない。ふつうの短い話し言葉にする。
- 30文字以内。1文。屋外で立ったまま聞いて分かること。`;

/** 生成された問いが決定に反していないかを検査する。反していたら使わない。 */
export function isUsableQuestion(q) {
  if (!q || typeof q !== 'string') return false;
  const s = q.trim();
  if (s.length < 4 || s.length > 40) return false;
  if (/なぜ|どうして|なんで/.test(s)) return false;          // 「なぜ」は重ねない
  if (/生き物|風景|文字ですか/.test(s)) return false;        // 分類名を問いに出さない
  if (/を撮って|を探して|を見つけて/.test(s)) return false;  // 対象を指定しない
  if (s.split(/[。？?]/).filter(Boolean).length > 1) return false;  // 1文だけ
  return true;
}

// モデル名は決め打ちにしない。名前が変わったときに黙って壊れるのを避ける。
let cachedModel = null;
async function pickModel(key) {
  if (process.env.GEMINI_MODEL) return process.env.GEMINI_MODEL;
  if (cachedModel) return cachedModel;
  const r = await fetch(`${ENDPOINT}/models?key=${encodeURIComponent(key)}`);
  if (!r.ok) throw new Error(`models ${r.status}`);
  const names = ((await r.json()).models || [])
    .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map(m => m.name.replace(/^models\//, ''))
    .filter(n => !/embedding|aqa|imagen|veo|tts/i.test(n));
  // 現場で待たせないので、軽くて速いものを優先する
  cachedModel = names.find(n => /flash-lite/.test(n)) || names.find(n => /flash/.test(n)) || names[0];
  if (!cachedModel) throw new Error('使えるモデルが無い');
  return cachedModel;
}

async function generate({ key, model, prompt, wav, timeoutMs = 8000 }) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  const parts = [{ text: prompt }];
  if (wav) parts.push({ inline_data: { mime_type: 'audio/wav', data: wav } });
  try {
    const r = await fetch(`${ENDPOINT}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`,
      { method: 'POST', signal: ctl.signal, headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts }],
          generationConfig: { temperature: 0.4, maxOutputTokens: 200, responseMimeType: 'application/json' },
        }) });
    if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 160)}`);
    const j = await r.json();
    const text = (j.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
    return JSON.parse(text);
  } finally { clearTimeout(t); }
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    // アプリ側が「ラリーが使えるか」を起動時に確かめるための口
    return res.status(200).json({ ok: true, ready: !!process.env.GEMINI_API_KEY });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(503).json({ error: 'GEMINI_API_KEY が設定されていません' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const { kind, wav, mission = '自由', stage = '理由', types = [] } = body;
    if (!wav) return res.status(400).json({ error: 'wav がありません' });
    const model = await pickModel(key);

    if (kind === 'type') {
      // もう1ターンの型を音声から決める（D30）。チップの1タップを省いて時間を稼ぐ。
      const j = await generate({ key, model, wav, prompt: `${RULES}

学生が「なんで、それが気になった？」に答えた音声です。
この後、写真をもう1枚撮ってもらいます。何を写せば、その学生が気になった点が残りますか。
次から1つ選んでください: ${types.join(', ')}
JSON で {"type":"<選んだもの>","why":"<15文字以内の理由>"} だけを返す。` });
      const ok = types.includes(j?.type);
      return res.status(200).json({ model, type: ok ? j.type : null, why: ok ? (j.why || '') : null });
    }

    if (kind === 'rally') {
      // 答えを受けて追い問いを1つ作る（D15）
      const j = await generate({ key, model, wav, prompt: `${RULES}

いまのお題は「${mission}」。学生が「${stage}」の問いに答えた音声です。
その答えの中で、まだ言われていないこと・あいまいなところを1つだけ選び、
そこを具体的に聞く問いを1つ返してください。
答えの中の言葉をそのまま使って聞くこと。一般論にしない。
JSON で {"q":"<問い>"} だけを返す。` });
      const q = typeof j?.q === 'string' ? j.q.trim() : '';
      return res.status(200).json({ model, q: isUsableQuestion(q) ? q : null, raw: q });
    }

    return res.status(400).json({ error: 'kind は type か rally' });
  } catch (e) {
    // 現場で落ちてもアプリは定型に戻って動き続ける。理由だけ返す。
    return res.status(502).json({ error: String(e.message || e) });
  }
}
