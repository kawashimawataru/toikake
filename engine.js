// 問いの設計（iOS 版 SessionModels.swift / SessionEngine.swift と同じ仕様）。
// 出力 JSON のキー名は解析コード（analysis/transcribe.py）の入力なので勝手に変えない。

export const STAGE_TEXT = {
  classify:       'まず一言。生き物、もの、風景、文字の、どれ？',
  noticing:       'いま、何が目に入った？',
  describing:     'いま、何が目に入った？ 見えたままを、色や形や大きさで。',
  describing_more:'もう少しだけ。どんな色、形、大きさ？ 何と比べて？',
  understanding:  'なんで、それが気になった？',
  hidden:         null,   // ミッションの q3 が入る
  follow_up_gain: 'さっきと比べて、新しく分かったことは？',
};

export const STAGE_LABEL = {
  classify: 'まず一言', noticing: '気づき', describing: '描写',
  describing_more: 'もう少しだけ', understanding: '理由',
  hidden: 'お題の質問', follow_up_gain: 'もう1枚',
};

// 写真ごとに交互。偶数が A（既存2問・ベースライン）、奇数が B（描写→なぜ→写真外）。
export const STAGES = {
  A: ['classify', 'noticing', 'understanding'],
  B: ['classify', 'describing', 'describing_more', 'understanding', 'hidden'],
};
export const setForIndex = i => (i % 2 === 0 ? 'A' : 'B');

// 段階ごとの時間（秒）。分類だけ短い。
export const LIMITS = {
  classify:       { noSpeech:  8, max: 10 },
  _default:       { noSpeech: 20, max: 60 },
};
export const limitsFor = s => LIMITS[s] || LIMITS._default;

// もう1ターン（9/7 MTG。この研究の主軸）。
// 「なぜ気になった？」の答えの後に、追加の記録を促す問いを1つ出す。
// 型は一言チップの1タップで決める（現場で音声認識に頼らないため）。
export const FOLLOW_UP = [
  { type: 'compare', chip: '比べた',        suggestion: '他と比べて分かるように、2つ一緒に写るように撮ってみて。' },
  { type: 'shape',   chip: '形',            suggestion: '形が分かるように、横か別の向きから撮ってみて。' },
  { type: 'texture', chip: '手触り',        suggestion: '近づいて、表面が写るように撮ってみて。' },
  { type: 'size',    chip: '大きさ',        suggestion: '大きさが分かるように、手や靴と一緒に撮ってみて。' },
  { type: 'unseen',  chip: '動き・音・匂い', suggestion: 'どこから来たか分かるように、周りも入れて引いて撮ってみて。' },
];
export const STANDARD_FOLLOW_UP = {
  type: 'standard', chip: null,
  suggestion: '気になったところが分かるように、寄るか引くかして、もう1枚撮ってみて。',
};
export const followUpBy = t =>
  FOLLOW_UP.find(f => f.type === t) || STANDARD_FOLLOW_UP;

// 判定のしきい値。iOS 版 SessionEngine の定数と同じ値にしてある。
// ここがずれるとアプリ間で応答率が比較できなくなる。
export const MIN_ANSWER_SPEECH_S = 0.8;   // 「答えた」とみなすのに要る累積発話
export const ANSWER_END_SILENCE_S = 2.5;  // 話し終わってこれだけ黙ったら終了
export const DESCRIBING_SHORT_S = 5;      // 描写がこれ未満なら追い問いを出す
export const FOLLOW_UP_CHOICE_S = 20;     // チップを待つ上限
export const FOLLOW_UP_SHOT_S = 60;       // 2枚目を待つ上限（磯は対象が足元。60分しかない）

export const iso = d => new Date(d).toISOString();
export const uuid = () =>
  (crypto.randomUUID ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
      })).toUpperCase();
