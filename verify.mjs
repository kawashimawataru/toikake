// Web 版の通し検証。実機がなくても回せる。仕様を変えたら必ず通すこと。
//   1. ページが読める（import と DOM の配線）
//   2. 撮影 → A/B の問い → もう1ターン（チップ→促し→2枚目→1問）まで通る
//   3. 2枚目の A/B の偶奇がずれない
//   4. 書き出した zip が session.json ＋ photos/ ＋ audio/ の形になっている
//
//   node verify.mjs
//
// playwright はグローバル導入（npm i -g playwright）でよい。
// ESM は NODE_PATH を見ないので、無ければ `npm root -g` から拾う。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const { chromium } = await import('playwright').catch(async () => {
  const root = execSync('npm root -g').toString().trim();
  return import(path.join(root, 'playwright', 'index.mjs'));
});

const DIR = path.dirname(new URL(import.meta.url).pathname);
const PHOTO = path.join(DIR, '..', '富士宮FW', 'IMG_4132.JPG');
let fails = 0;
const ok = m => console.log('  OK   ' + m);
const bad = m => { console.log('  FAIL ' + m); fails++; };

const missing = [];
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  const f = path.join(DIR, req.url === '/' ? 'index.html' : req.url.split('?')[0]);
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) {
    missing.push(req.url); res.writeHead(404); return res.end();
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise(r => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}/`;

// マイクの許可ダイアログを出さず、偽のマイクを挿して起動する。
// playwright 同梱の Chromium が無い環境が多いので、入っている Google Chrome を使う。
const LAUNCH = { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] };
const browser = await chromium.launch({ ...LAUNCH, channel: 'chrome' })
  .catch(() => chromium.launch(LAUNCH));
const ctx = await browser.newContext({ permissions: ['microphone'], acceptDownloads: true });
await ctx.grantPermissions(['microphone'], { origin: base.slice(0, -1) });
// 読み上げは headless に声が無く返ってこないので、待たずに進める
await ctx.addInitScript(() => {
  window.speechSynthesis = { speak: u => setTimeout(() => u.onend && u.onend(), 10), cancel: () => {} };
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('requestfailed', r => errors.push('requestfailed ' + r.url()));
page.on('response', r => { if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`); });

console.log('########## 1. ページが読める ##########');
await page.goto(base);
await page.waitForSelector('#start');
await page.waitForTimeout(400);
if (missing.length) bad('404 になったファイル: ' + missing.join(', '));
if (errors.length) bad('読み込みでエラー:\n       ' + errors.join('\n       ')); else ok('index.html を読み込んでエラーなし');

console.log('\n########## 2. 撮影 → 問い → もう1ターン ##########');
{ // 3日目（磯採集）のカードになっているか
  const m = await page.evaluate(() => import('./missions.js').then(x => ({
    card: x.CARD.map(c => c.id), n: x.MISSIONS.length,
    ichiban: JSON.stringify(x.MISSIONS).includes('一番'),
  })));
  const want = ['M0','S43','S42','S41','S44','M54','M7','M4','M53','M52'];
  if (JSON.stringify(m.card) === JSON.stringify(want)) ok(`カードは3日目の磯むけ10本（${m.card.join(' ')}）`);
  else bad('カードが違う：' + m.card.join(' '));
  if (!m.ichiban) ok('お題に「一番〜」が無い'); else bad('お題に「一番〜」が残っている');
  const fu = await page.evaluate(() => import('./engine.js').then(x => x.FOLLOW_UP_SHOT_S));
  if (fu === 60) ok('2枚目の待ちは60秒（60分枠に合わせた）'); else bad('2枚目の待ちが60秒でない：' + fu);
}
await page.click('#start');
await page.waitForSelector('#capture.on', { timeout: 5000 });
ok('マイクを取って撮影画面に入った');

/** 1問ぶん：問いが「前と違う文面」に変わるのを待って「話し終わった」を押す。
    切り替わりを待たずに読むと、前の問いの文字を読んでしまう。 */
let lastQ = '';
async function answerOne() {
  await page.waitForSelector('#prompt.on', { timeout: 20000 });
  await page.waitForFunction(prev => {
    const el = document.getElementById('question');
    return el && el.textContent && el.textContent !== prev;
  }, lastQ, { timeout: 20000 });
  const q = await page.textContent('#question');
  lastQ = q;
  await page.waitForSelector('#done:not([disabled])', { timeout: 20000 });
  await page.waitForTimeout(400);           // 実際に録音が回っている時間を作る
  await page.click('#done');
  return q;
}

async function shoot(sel) {
  const chooser = page.waitForEvent('filechooser');
  await page.click(sel);
  (await chooser).setFiles(PHOTO);
}

// 1枚目（通し番号 0 → セット A：分類・気づき・理由）
await shoot('#shutter');
const qs = [];
for (let i = 0; i < 3; i++) qs.push(await answerOne());
if (qs[0].includes('まず一言') && qs[1].includes('目に入った') && qs[2].includes('なんで'))
  ok('A の3問が順に出た：分類 → 気づき → 理由');
else bad('A の問いの並びが違う：' + JSON.stringify(qs));

// もう1ターン：チップ → 促し → 2枚目 → 1問
await page.waitForSelector('#chips.on', { timeout: 10000 });
ok('「なぜ」の後にチップが出た');
await page.click('[data-t="compare"]');
await page.waitForSelector('#suggestBox:visible', { timeout: 10000 });
const sug = await page.textContent('#suggestText');
if (sug.includes('2つ一緒')) ok('選んだ型の促しが出た：' + sug); else bad('促しが型と合っていない：' + sug);
await shoot('#shutter2');
const g = await answerOne();
if (g.includes('新しく分かった')) ok('2枚目の後に1問だけ聞いた：' + g); else bad('2枚目の問いが違う：' + g);

// 2枚目（通し番号 1 → セット B）。もう1ターンで A/B の偶奇がずれていないこと。
await page.waitForSelector('#capture.on', { timeout: 10000 });
await shoot('#shutter');
const qs2 = [];
for (let i = 0; i < 2; i++) qs2.push(await answerOne());
if (qs2[1] && qs2[1].includes('見えたまま')) ok('次の撮影は B（描写から）。もう1ターンで偶奇がずれていない');
else bad('A/B の偶奇がずれた：' + JSON.stringify(qs2));
await page.click('#skip');                   // 残りは「今はやめる」で切り上げ
await page.waitForSelector('#capture.on', { timeout: 15000 });

// 「今はやめる」の後でも、次の写真ではちゃんと問いが出ること
await shoot('#shutter');
lastQ = '';
const after = await answerOne();
if (after.includes('まず一言')) ok('「今はやめる」の後でも、次の写真で問いが出る');
else bad('やめた後に問いが出ない：' + after);
await page.click('#skip');

console.log('\n########## 3. 記録の中身 ##########');
await page.waitForSelector('#capture.on', { timeout: 15000 });
await page.click('#endSession');
await page.waitForSelector('#review.on', { timeout: 10000 });
const s = await page.evaluate(async () => {
  const db = await new Promise(r => { const q = indexedDB.open('toikake'); q.onsuccess = () => r(q.result); });
  return new Promise(r => { const q = db.transaction('sessions').objectStore('sessions').getAll(); q.onsuccess = () => r(q.result[0]); });
});
const first = s.captures[0], second = s.captures[1], third = s.captures[2];
if (s.immediate_prompt === true) ok('immediate_prompt=true（保留ゲートを通していないことが JSON に出る）');
else bad('immediate_prompt が true でない');
if (first.prompt.question_set === 'A' && third.prompt.question_set === 'B') ok('A → B の交互割当');
else bad('A/B の割当が違う: ' + [first, second, third].map(c => c.prompt.question_set).join(','));
if (second.follow_up_of === first.capture_id && second.follow_up_type === 'compare'
    && second.trigger === 'follow_up' && typeof second.follow_up_delay_s === 'number'
    && second.prompt.question_set === null) {
  ok(`2枚目に follow_up_of / type / delay_s（${second.follow_up_delay_s}秒）が入り、A/B は付かない`);
} else bad('2枚目の記録が仕様どおりでない: ' + JSON.stringify(second).slice(0, 300));
if (second.answers.length === 1 && second.answers[0].stage === 'follow_up_gain') ok('2枚目の答えは1問だけ');
else bad('2枚目の答えの数が違う: ' + second.answers.length);
const types = s.events.map(e => e.type);
for (const t of ['session_start', 'capture_meta', 'follow_up_suggested', 'follow_up_shot', 'session_end'])
  if (!types.includes(t)) bad(`イベント ${t} が出ていない`);
if (types.includes('follow_up_suggested') && types.includes('follow_up_shot')) ok('もう1ターンのイベントが時系列に残る');

// 10:30 の「自分の取ったデータを参照して比較・発表」で本人が聞き返せること
const players = await page.$$eval('#reviewList audio', els => els.length);
if (players > 0) ok(`振り返りで録音を再生できる（${players}件）`); else bad('振り返りに再生が無い');
const chips = await page.$eval('#statusBar', el => el.textContent);
if (/\d+分/.test(chips)) ok('経過時間が出る（60分枠のペース配分用）'); else bad('経過時間が出ていない：' + chips);

console.log('\n########## 4. 書き出した zip ##########');
const dl = page.waitForEvent('download');
await page.click('#export');
const d = await dl;
const file = await d.path();
if (process.env.KEEP_ZIP) { await d.saveAs(process.env.KEEP_ZIP); console.log('       zip を保存: ' + process.env.KEEP_ZIP); }
const buf = fs.readFileSync(file);
const names = [];
for (let i = 0; i < buf.length - 4; i++) {
  if (buf.readUInt32LE(i) === 0x04034b50) {
    const n = buf.readUInt16LE(i + 26);
    names.push(buf.slice(i + 30, i + 30 + n).toString('utf8'));
  }
}
if (names.includes('session.json')) ok('session.json が入っている');else bad('session.json が無い');
if (names.some(n => n.startsWith('photos/'))) ok('photos/ が入っている（' + names.filter(n => n.startsWith('photos/')).length + '枚）'); else bad('photos/ が無い');
if (names.some(n => n.startsWith('audio/'))) ok('audio/ が入っている（' + names.filter(n => n.startsWith('audio/')).length + '本）'); else bad('audio/ が無い');

if (errors.length) bad('実行中に JS エラー:\n       ' + errors.join('\n       '));
else ok('通しでJSエラーなし');

await browser.close(); server.close();
console.log('\n' + (fails ? `失敗 ${fails} 件` : 'すべて通過'));
process.exit(fails ? 1 : 0);
