// 「問いかけ」Web 版。iOS 版と同じ問いの設計で、URL を配るだけで使えるようにしたもの。
//
// 9/7 MTG の決定：配布は Web でよい。保留ゲート（歩行中・周囲の会話中は待つ）は
// Web では使わない。画面が消えるとマイクが止まる（WebKit bug 226620）ので、
// 「静かなときに勝手に聞く」設計が成立しないため。撮った直後にその場で聞く。
// そのぶん session.json の immediate_prompt を true で出す。
// 保留ゲートを通っていないので、E1（発火率・保留時間）の母数に混ぜてはいけない。

import { CARD, MISSIONS, FREE, byId, categories } from './missions.js';
import * as E from './engine.js';
import { Store, exportSession } from './store.js';
import { Meter } from './vad.js';
import { Rally, isUsableQuestion, toWavBase64 } from './rally.js';

const $ = id => document.getElementById(id);
const show = id => {
  for (const s of document.querySelectorAll('.screen')) s.classList.toggle('on', s.id === id);
  window.scrollTo(0, 0);
};

// ---- 状態 -------------------------------------------------------------------
const app = {
  session: null,
  mission: FREE,
  recommended: false,
  stream: null,
  meter: null,
  wakeLock: null,
  mime: 'audio/mp4',
  ext: 'm4a',
  // 進行中の1問を制御するフラグ（iOS 版の manualStop / dismiss / restart と同じ）
  manualStop: false, dismissed: false, restart: false,
  // もう1ターン
  followChoice: null, followSkip: false,
};

const shutterCount = () => app.session.captures.filter(c => (c.trigger || 'shutter') === 'shutter').length;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function log(type, capture, detail = '') {
  app.session.events.push({ at: E.iso(Date.now()), type, capture_id: capture || null, detail });
}
async function save() { await Store.putSession(app.session); }

// ---- 読み上げ ---------------------------------------------------------------
// 屋外の騒音と、他の学生への聞こえ方の両面から、音声と画面表示を併用する。
function speak(text) {
  return new Promise(res => {
    if (!window.speechSynthesis) return res();
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'ja-JP'; u.rate = 1.0;
      u.onend = res; u.onerror = res;
      speechSynthesis.speak(u);
      setTimeout(res, 9000);   // 読み上げが返ってこない端末でも止まらないように
    } catch (e) { res(); }
  });
}

// ---- 画面部品 ---------------------------------------------------------------
/** 最初の画面に出すラリーの行。使えないときは何も出さない（学生に選ばせるものではない）。 */
function renderRallyRow() {
  const box = $('rallyRow');
  if (!Rally.available) { box.style.display = 'none'; return; }
  box.style.display = '';
  $('rallyToggle').textContent = Rally.on ? 'ラリー：オン' : 'ラリー：オフ';
  $('rallyToggle').className = Rally.on ? 'btn' : 'btn sub';
}

function renderStatus() {
  const s = app.session;
  const shots = s ? s.captures.filter(c => !c.follow_up_of).length : 0;
  const fu = s ? s.captures.filter(c => c.follow_up_of).length : 0;
  // 3日目の磯採集は 8:00〜9:00 の60分しかない。経過が見えないとペースを配れない。
  const min = s ? Math.floor((Date.now() - new Date(s.started_at)) / 60000) : 0;
  $('statusBar').innerHTML =
    `<span class="chip">${s ? s.participant_id : '-'}</span>` +
    `<span class="chip">写真 ${shots}</span>` +
    `<span class="chip${fu ? ' hot' : ''}">もう1枚 ${fu}</span>` +
    `<span class="chip">${min}分</span>`;
}

function renderMission() {
  const m = app.mission;
  $('missionBox').innerHTML =
    `<button class="mission" id="pickMission">
       <b>お題：${m.id === FREE.id ? '自由' : m.name}</b>
       <span>${m.task}</span>
     </button>
     ${m.id === FREE.id ? '' :
      `<div style="margin-top:8px"><button class="btn sub" id="byWhom">${
        app.recommended ? '引率者のおすすめ' : '自分で選んだ'}</button></div>`}`;
  $('pickMission').onclick = openMissionPicker;
  if ($('byWhom')) $('byWhom').onclick = () => { app.recommended = !app.recommended; renderMission(); };
}

// お題は「こういうものが気になったら撮って」という指針。対象は指定しない（9/7 MTG）。
function openMissionPicker() {
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;inset:0;background:#fff;overflow:auto;z-index:50;padding:16px 18px';
  const list = ms => ms.map(m =>
    `<button class="mission" data-id="${m.id}" style="margin-bottom:10px">
       <b>${m.name}</b><span>${m.task}</span></button>`).join('');
  box.innerHTML =
    `<h1>お題をえらぶ</h1>
     <p class="muted small">どれを撮るかは自分で決めてください。お題は「こういうものが気になったら撮って」という目安です。</p>
     ${list(CARD)}
     <h2>もっと見る</h2>
     ${categories.map(c => `<details style="margin-bottom:8px"><summary style="font-weight:800;padding:10px 0">${c}（${MISSIONS.filter(m => m.category === c).length}）</summary>${list(MISSIONS.filter(m => m.category === c))}</details>`).join('')}
     <div style="height:20px"></div>
     <button class="btn sub" id="closePick">閉じる</button>
     <div style="height:24px"></div>`;
  document.body.appendChild(box);
  box.querySelectorAll('[data-id]').forEach(b => b.onclick = () => {
    app.mission = byId(b.dataset.id); app.recommended = false;
    renderMission(); box.remove();
  });
  $('closePick').onclick = () => box.remove();
}

const meterBars = Array.from({ length: 20 }, () => document.createElement('i'));
meterBars.forEach(b => $('meter').appendChild(b));
function paintMeter(db) {
  const n = Math.max(0, Math.min(1, (db + 60) / 60));
  meterBars.forEach((b, i) => b.classList.toggle('on', i / meterBars.length < n));
}

// ---- 1問ぶんの録音 ----------------------------------------------------------
// iOS 版 SessionEngine.ask と同じ判定：
//   ・累積 0.8 秒しゃべって、そのあと 2.5 秒黙ったら終了
//   ・一言も出ないまま所定の秒数で切り上げ（no_response）
//   ・本人が「話し終わった」を押したら、VAD が何と言っていても回答として保存する
async function ask(stage, captureID, mission, override) {
  const text = override || (stage === 'hidden' ? mission.q3 : E.STAGE_TEXT[stage]);
  const lim = E.limitsFor(stage);
  $('stageLabel').textContent =
    stage === 'hidden' ? `お題「${mission.name}」の質問` : (E.STAGE_LABEL[stage] || stage);
  $('question').textContent = text;
  show('prompt');

  $('recText').textContent = '読み上げ中…';
  $('recDot').className = 'dot off';
  $('done').disabled = true; $('again').disabled = true;
  app.dismissed = false;

  app.meter.vad.setSuppressed(true);
  await speak(text);
  app.meter.vad.setSuppressed(false);
  if (app.dismissed) return { kind: 'dismissed' };

  const path = `audio/${captureID}_${stage}.${app.ext}`;
  let result = null;

  do {
    app.restart = false; app.manualStop = false;
    app.meter.vad.reset();

    const chunks = [];
    const rec = new MediaRecorder(app.stream, { mimeType: app.mime });
    rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    const stopped = new Promise(r => { rec.onstop = r; });
    rec.start(250);

    $('recText').textContent = '声で答えてください';
    $('recDot').className = 'dot';
    $('done').disabled = false; $('again').disabled = false;

    const started = performance.now();
    let heard = false, endReason = 'timeout', last = started;

    while (true) {
      await sleep(100);
      const now = performance.now();
      const dt = (now - last) / 1000; last = now;
      const v = app.meter.tick(dt);
      paintMeter(v.levelDB);
      const elapsed = (now - started) / 1000;
      $('recNums').textContent =
        `${elapsed.toFixed(1)}秒　検出した声 ${app.meter.vad.speechSeconds.toFixed(1)}秒`;

      if (app.dismissed || app.restart) break;
      if (app.manualStop) { endReason = 'manual'; break; }
      if (app.meter.vad.speechSeconds >= E.MIN_ANSWER_SPEECH_S) heard = true;
      if (elapsed >= lim.max) { endReason = 'maxDuration'; break; }
      if (heard && v.silence >= E.ANSWER_END_SILENCE_S) { endReason = 'silence'; break; }
      if (!heard && elapsed >= lim.noSpeech) { endReason = 'timeout'; break; }
    }

    const speechSeconds = app.meter.vad.speechSeconds;
    const duration = (performance.now() - started) / 1000;
    rec.stop(); await stopped;
    const blob = new Blob(chunks, { type: app.mime });
    result = { blob, heard, endReason, speechSeconds, duration };
  } while (app.restart && !app.dismissed);

  const userSaidDone = result.endReason === 'manual';
  const hasAudio = result.blob.size > 0;

  if (hasAudio && !app.dismissed && (result.heard || userSaidDone)) {
    await Store.putBlob(path, result.blob);
    const cap = app.session.captures.find(c => c.capture_id === captureID);
    cap.answers.push({
      stage, audio: path,
      transcript: '',                     // 文字起こしは事後に Mac 側（whisper）で埋める
      duration_s: Math.round(result.duration * 10) / 10,
      ended_by: result.endReason,
      vad_speech_s: Math.round(result.speechSeconds * 100) / 100,
      transcript_source: null,
    });
    if (userSaidDone) {
      log('answer_completed', captureID,
        `stage=${stage} vad_speech_s=${result.speechSeconds.toFixed(2)}` + (result.heard ? '' : ' vad_missed=true'));
    }
    await save();
    return { kind: 'answered', speechSeconds: result.speechSeconds, blob: result.blob };
  }

  if (app.dismissed) return { kind: 'dismissed' };

  // 発話が検出されなかった録音も消さずに残す（しきい値を事後に評価する材料）。
  if (hasAudio) await Store.putBlob(path, result.blob);
  log('no_response', captureID,
    `stage=${stage} vad_speech_s=${result.speechSeconds.toFixed(2)}` + (hasAudio ? ` audio=${path}` : ''));
  await save();
  return { kind: 'noSpeech' };
}

// ---- 撮影1件の進行 ----------------------------------------------------------
async function runCapture(capture, mission) {
  const set = capture.prompt.question_set || 'A';
  let answered = false, describingAnswered = false, lastSpeech = 0;

  for (const stage of E.STAGES[set]) {
    if (app.dismissed) break;
    if (stage === 'describing_more' && (!describingAnswered || lastSpeech >= E.DESCRIBING_SHORT_S)) continue;

    const r = await ask(stage, capture.capture_id, mission);
    if (r.kind === 'dismissed') { app.dismissed = true; break; }
    if (r.kind === 'answered') {
      answered = true; lastSpeech = r.speechSeconds;
      if (stage === 'describing') describingAnswered = true;
      // ラリー：理由を聞いた直後に、その答えを受けて追い問いを1つだけ足す（D15）。
      // 1回だけにするのは、「なぜ」を重ねると具体性が落ちるため（CHI 2025 / Kocielnik 2018）。
      if (stage === 'understanding') {
        app.lastWhyBlob = r.blob;
        if (Rally.active) await runRally(capture.capture_id, mission, r.blob);
      }
    } else {
      if (stage === 'classify') continue;      // 分類は飛ばしても本題へ進む
      if (!answered) break;                    // 本題の1問目に答えなければ打ち切り
    }
  }

  const cap = app.session.captures.find(c => c.capture_id === capture.capture_id);
  cap.prompt.outcome = app.dismissed ? 'dismissed' : (answered ? 'answered' : 'dismissed');
  await save();
  return { answered, dismissed: app.dismissed };
}

// ---- ラリー（掘り下げ）------------------------------------------------------
// 9/7 MTG の「対話型AIはプラスアルファ」。主軸のもう1ターンは触らない。
// 生成に失敗しても、遅くても、問いが規則に反しても、何もせず次へ進む。

async function runRally(captureID, mission, blob) {
  const t0 = performance.now();
  let wav = null;
  try { wav = await toWavBase64(blob); } catch (e) {
    log('rally_skipped', captureID, 'reason=wav_failed'); return;
  }
  const res = await Rally.call({ kind: 'rally', wav, mission: mission.name, stage: '理由' });
  const ms = Math.round(performance.now() - t0);
  if (res.error || !isUsableQuestion(res.q)) {
    log('rally_skipped', captureID,
      `reason=${res.error ? res.error : 'unusable'} ms=${ms}` + (res.raw ? ` raw=${res.raw}` : ''));
    return;
  }
  log('rally_question', captureID, `ms=${ms} model=${res.model || '-'} q=${res.q}`);
  // 生成した問いはその場で聞く。段階名は rally で、A/B の段階列には入れない。
  await ask('rally', captureID, mission, res.q);
  await save();
}

// ---- もう1ターン ------------------------------------------------------------
// 「なぜ気になった？」の答えの後に、追加の記録を促す問いを1つ出す（9/7 MTG。主軸）。
async function runFollowUp(baseID, mission) {
  app.followChoice = null; app.followSkip = false;

  // 1a. ラリーが使えるときは、理由の答えの音声から型を決めてチップを飛ばす（D30）。
  //     60分しかないので、1タップぶんでも削れるなら削る。失敗したらチップに戻る。
  if (Rally.active && app.lastWhyBlob) {
    const t0 = performance.now();
    try {
      const wav = await toWavBase64(app.lastWhyBlob);
      const res = await Rally.call({ kind: 'type', wav,
        types: E.FOLLOW_UP.map(f => f.type) });
      const ms = Math.round(performance.now() - t0);
      if (!res.error && res.type) {
        app.followChoice = res.type;
        log('follow_up_auto_type', baseID, `type=${res.type} ms=${ms} why=${res.why || ''}`);
      } else {
        log('follow_up_auto_failed', baseID, `reason=${res.error || 'none'} ms=${ms}`);
      }
    } catch (e) { log('follow_up_auto_failed', baseID, 'reason=wav_failed'); }
  }

  // 1b. 決まらなければ、これまでどおり一言チップを1タップで
  if (!app.followChoice) {
    renderChips();
    show('chips');
    const t0 = performance.now();
    while (!app.followChoice && !app.followSkip) {
      await sleep(100);
      if ((performance.now() - t0) / 1000 >= E.FOLLOW_UP_CHOICE_S) break;
    }
  }
  const base = app.session.captures.find(c => c.capture_id === baseID);
  if (app.followSkip) {
    base.follow_up_declined = true;
    log('follow_up_declined', baseID, 'type=none reason=user_before_suggest');
    await save(); return;
  }

  // 選ばなくても促しは必ず出す（既定の型）。先生の指示は「1ターン足す」。
  const fu = app.followChoice ? E.followUpBy(app.followChoice) : E.STANDARD_FOLLOW_UP;
  base.follow_up_type = fu.type;
  log('follow_up_suggested', baseID, `type=${fu.type} chosen=${app.followChoice ? 'chip' : 'default'}`);
  await save();

  // 2. 促してカメラに戻し、2枚目を待つ
  app.followSkip = false;
  $('suggestText').textContent = fu.suggestion;
  // ボタンを出す前に受け皿を用意する。読み上げの途中で押されても取りこぼさない
  // （屋外では読み上げを待たずに撮りに行く。押して無反応が一番まずい）。
  const suggestedAt = performance.now();
  app.pendingFollowUp = { baseID, type: fu.type, suggestedAt, shotID: null };
  $('suggestLeft').textContent = `あと ${E.FOLLOW_UP_SHOT_S} 秒`;
  $('shutterBox').style.display = 'none';
  $('suggestBox').style.display = '';
  show('capture');
  app.meter.vad.setSuppressed(true);
  await speak(fu.suggestion);
  app.meter.vad.setSuppressed(false);

  while (!app.pendingFollowUp.shotID && !app.followSkip) {
    await sleep(200);
    const left = E.FOLLOW_UP_SHOT_S - (performance.now() - suggestedAt) / 1000;
    $('suggestLeft').textContent = `あと ${Math.max(0, Math.ceil(left))} 秒`;
    if (left <= 0) break;
  }
  $('suggestBox').style.display = 'none';
  $('shutterBox').style.display = '';

  const shotID = app.pendingFollowUp.shotID;
  app.pendingFollowUp = null;

  // 3. 撮れたら1問だけ聞く
  if (shotID) {
    app.dismissed = false;
    const r = await ask('follow_up_gain', shotID, mission);
    const cap = app.session.captures.find(c => c.capture_id === shotID);
    cap.prompt.outcome = r.kind === 'answered' ? 'answered' : 'dismissed';
  } else {
    base.follow_up_declined = true;
    log('follow_up_declined', baseID, `type=${fu.type} reason=${app.followSkip ? 'user' : 'timeout'}`);
  }
  await save();
}

function renderChips() {
  $('chipList').innerHTML = E.FOLLOW_UP.map((f, i) =>
    `<button data-t="${f.type}"${i === E.FOLLOW_UP.length - 1 ? ' class="wide"' : ''}>${f.chip}</button>`).join('');
  $('chipList').querySelectorAll('[data-t]').forEach(b =>
    b.onclick = () => { app.followChoice = b.dataset.t; });
}

// ---- 撮影 -------------------------------------------------------------------
function pickPhoto() {
  return new Promise(res => {
    const input = $('file');
    input.value = '';
    input.onchange = () => res(input.files && input.files[0] ? input.files[0] : null);
    input.click();
  });
}

async function onShutter() {
  $('shutter').disabled = true;
  // 前の写真で「今はやめる」を押していても、次の写真では必ず問いを出す。
  // ここで戻さないと、一度やめた学生はその日ずっと問いが出なくなる。
  app.dismissed = false;
  app.followSkip = false;
  try {
    const file = await pickPhoto();
    if (!file) return;
    const captureID = E.uuid();
    const at = Date.now();
    const path = `photos/${captureID}.jpg`;
    await Store.putBlob(path, file);

    const set = E.setForIndex(shutterCount());
    const capture = {
      capture_id: captureID, captured_at: E.iso(at), photo: path, trigger: 'shutter',
      location: null,
      context_at_capture: { motion_state: 'unknown', ambient_speech: false },
      prompt: { fired: true, fired_at: E.iso(Date.now()), defer_ms: 0, defer_reason: [],
                outcome: null, question_set: set },
      answers: [], post_note: '',
      mission: { id: app.mission.id, name: app.mission.name,
                 chosen_by: app.recommended ? 'recommended' : 'self' },
      follow_up_of: null, follow_up_type: null, follow_up_delay_s: null, follow_up_declined: null,
    };
    app.session.captures.push(capture);
    log('capture_meta', captureID,
      `question_set=${set} mission=${app.mission.id} chosen_by=${capture.mission.chosen_by}`);
    log('prompt_fired', captureID, 'defer_ms=0');
    await save();
    renderStatus();

    const mission = app.mission;
    const r = await runCapture(capture, mission);

    // もう1ターン。「なぜ」まで答えた写真だけ。拒否された撮影には重ねない。
    const answeredWhy = capture.answers.some(a => a.stage === 'understanding');
    if (!r.dismissed && answeredWhy) await runFollowUp(captureID, mission);

    show('capture'); renderStatus(); renderMission();
  } finally {
    $('shutter').disabled = false;
  }
}

async function onFollowUpShutter() {
  if (!app.pendingFollowUp) return;
  $('shutter2').disabled = true;
  try {
    const file = await pickPhoto();
    if (!file) return;
    const captureID = E.uuid();
    const at = Date.now();
    const path = `photos/${captureID}.jpg`;
    await Store.putBlob(path, file);
    const p = app.pendingFollowUp;
    const delay = Math.round((performance.now() - p.suggestedAt) / 100) / 10;

    app.session.captures.push({
      capture_id: captureID, captured_at: E.iso(at), photo: path, trigger: 'follow_up',
      location: null,
      context_at_capture: { motion_state: 'unknown', ambient_speech: false },
      prompt: { fired: true, fired_at: E.iso(at), defer_ms: 0, defer_reason: [],
                outcome: null, question_set: null },
      answers: [], post_note: '',
      mission: { id: app.mission.id, name: app.mission.name,
                 chosen_by: app.recommended ? 'recommended' : 'self' },
      follow_up_of: p.baseID, follow_up_type: p.type, follow_up_delay_s: delay,
      follow_up_declined: null,
    });
    log('follow_up_shot', captureID, `follow_up_of=${p.baseID} type=${p.type} delay_s=${delay}`);
    await save();
    p.shotID = captureID;
    renderStatus();
  } finally {
    $('shutter2').disabled = false;
  }
}

// ---- 振り返りと書き出し -----------------------------------------------------
async function renderReview() {
  const sessions = await Store.allSessions();
  sessions.sort((a, b) => (a.started_at < b.started_at ? 1 : -1));
  const s = app.session || sessions[0];
  if (!s) { $('reviewSummary').innerHTML = '<p class="muted">まだ記録がありません。</p>'; $('reviewList').innerHTML = ''; show('review'); return; }
  app.reviewing = s;

  const shots = s.captures.filter(c => !c.follow_up_of);
  const fus = s.captures.filter(c => c.follow_up_of);
  const suggested = s.events.filter(e => e.type === 'follow_up_suggested').length;
  const answers = s.captures.reduce((n, c) => n + c.answers.length, 0);
  const mb = await Store.usageMB();

  $('reviewSummary').innerHTML =
    `<table>
      <tr><td>参加者</td><td>${s.participant_id}</td></tr>
      <tr><td>写真（1枚目）</td><td>${shots.length}</td></tr>
      <tr><td>もう1枚（2枚目）</td><td>${fus.length} / 促し ${suggested}</td></tr>
      <tr><td>録音した答え</td><td>${answers}</td></tr>
      ${mb ? `<tr><td>端末内の使用量</td><td>${mb.toFixed(1)} MB</td></tr>` : ''}
     </table>`;

  const parts = [];
  for (const c of s.captures) {
    const b = c.photo ? await Store.getBlob(c.photo) : null;
    const url = b ? URL.createObjectURL(b) : null;
    const tags =
      (c.follow_up_of ? `<span class="tag fu">もう1枚・${c.follow_up_type}</span>` : `<span class="tag">${c.prompt.question_set || 'A'}</span>`) +
      `<span class="tag">${(c.mission && c.mission.name) || '自由'}</span>` +
      (c.follow_up_declined ? '<span class="tag">2枚目なし</span>' : '');
    // 録音はその場で聞き返せるようにする。10:30 の「自分の取ったデータを参照して
    // 干潟と磯を比較・発表」で本人が使うため（文字起こしは事後なので、ここでは音で返す）。
    let ans = '<p class="ans muted">答えの録音なし</p>';
    if (c.answers.length) {
      const rows = [];
      for (const a of c.answers) {
        const ab = await Store.getBlob(a.audio);
        const au = ab ? URL.createObjectURL(ab) : null;
        rows.push(`<p class="ans"><b>${E.STAGE_LABEL[a.stage] || a.stage}</b>　${a.duration_s}秒</p>` +
          (au ? `<audio controls preload="none" src="${au}"></audio>` : ''));
      }
      ans = rows.join('');
    }
    parts.push(`<div class="card">${url ? `<img src="${url}" alt="">` : ''}${tags}${ans}</div>`);
  }
  $('reviewList').innerHTML = parts.join('');
  show('review');
}

async function doExport() {
  const s = app.reviewing || app.session;
  if (!s) return;
  $('export').disabled = true; $('export').textContent = '書き出し中…';
  try {
    const { blob, count } = await exportSession(s);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${s.participant_id}_${s.session_id.slice(0, 8)}.zip`;
    document.body.appendChild(a); a.click(); a.remove();
    $('export').textContent = `書き出した（${count}ファイル）`;
  } catch (e) {
    $('export').textContent = '書き出しに失敗：' + e.message;
  } finally {
    $('export').disabled = false;
  }
}

// ---- 起動 -------------------------------------------------------------------
async function begin() {
  $('setupErr').textContent = '';
  try {
    // マイクは最初の1回だけ許可を取り、記録の間はつないだままにする。
    // 写真を撮って戻ってくるたびに取り直すと、iOS Safari では
    // 「操作からの流れ」が切れて許可が下りないことがある。
    app.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    $('setupErr').textContent = 'マイクが使えません。Safari の設定でマイクを許可してください。';
    return;
  }
  for (const m of ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm']) {
    if (MediaRecorder.isTypeSupported(m)) { app.mime = m; app.ext = m.startsWith('audio/mp4') ? 'm4a' : 'webm'; break; }
  }
  app.meter = new Meter(app.stream);
  try { await app.meter.ctx.resume(); } catch (e) {}
  speak('');                                   // iOS の読み上げをこの操作で解錠する
  try { app.wakeLock = await navigator.wakeLock.request('screen'); } catch (e) {}

  app.session = {
    session_id: E.uuid(),
    participant_id: $('pid').value,
    started_at: E.iso(Date.now()),
    ended_at: null,
    device: { model: navigator.platform || 'web', os: navigator.userAgent },
    // Web 版は保留ゲートを通さない（画面が消えるとマイクが止まるため）。
    // E1 の母数から機械的に外せるように、必ず true で出す。
    immediate_prompt: true,
    on_device_transcription: false,
    // ラリー（Gemini で追い問いを生成／もう1ターンの型を自動判定）を使った区間か。
    // 使った写真は問いの出方が定型と違うので、解析では必ず分けること。
    rally_enabled: Rally.active,
    captures: [], events: [],
  };
  log('session_start', null, `app=web mime=${app.mime} rally=${Rally.active ? 'on' : 'off'}`);
  await save();
  renderStatus(); renderMission();
  clearInterval(app.clock);
  app.clock = setInterval(() => { if ($('capture').classList.contains('on')) renderStatus(); }, 30000);
  show('capture');
}

async function endSession() {
  if (!app.session) return;
  app.session.ended_at = E.iso(Date.now());
  log('session_end', null, `captures=${app.session.captures.length}`);
  clearInterval(app.clock);
  await save();
  try { if (app.wakeLock) await app.wakeLock.release(); } catch (e) {}
  await renderReview();
}

(async function main() {
  await Store.init();
  $('pid').innerHTML = ['P01', 'P02', 'P03', 'P04', 'P05', 'P06']
    .map(p => `<option>${p}</option>`).join('');
  const saved = localStorage.getItem('participant_id');
  if (saved) $('pid').value = saved;
  $('pid').onchange = () => localStorage.setItem('participant_id', $('pid').value);

  $('rallyToggle').onclick = () => { Rally.on = !Rally.on; renderRallyRow(); };
  $('start').onclick = begin;
  $('shutter').onclick = onShutter;
  $('shutter2').onclick = onFollowUpShutter;
  $('skipShot').onclick = () => { app.followSkip = true; };
  $('skipChip').onclick = () => { app.followSkip = true; };
  $('done').onclick = () => { app.manualStop = true; };
  $('again').onclick = () => { app.restart = true; };
  $('skip').onclick = () => {
    app.dismissed = true;
    if (window.speechSynthesis) speechSynthesis.cancel();
    const id = app.session && app.session.captures.length
      ? app.session.captures[app.session.captures.length - 1].capture_id : null;
    log('dismiss', id, 'source=user'); save();
  };
  $('endSession').onclick = endSession;
  $('toReview').onclick = renderReview;
  $('backHome').onclick = () => show(app.session ? 'capture' : 'setup');
  $('export').onclick = doExport;

  // ラリーが使えるかを1回だけ確かめる。関数が無い（GitHub Pages 側）／電波が無いなら自動でオフ。
  await Rally.probe();
  renderRallyRow();

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
