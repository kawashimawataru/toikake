// RMS ベースの簡易 VAD。iOS 版 VoiceActivityDetector.swift の移植。
//
// 「問いは届いたが黙っていた（no_response）」の判定はここだけに依存し、
// 音声認識には一切依存しない。評価軸 E1 の土台なので、iOS 版と同じ判定にしてある。
// レベルの高さだけでは「急に強くなった風」と「話し始めた人」を区別できないため、
// 直近の dB のばらつき（音声は音節ごとに上下する／風は平坦）も見る。

const SPEECH_MARGIN_DB = 8;      // ノイズフロア + これ以上なら発話候補
const ABSOLUTE_FLOOR_DB = -48;   // これ以下は無条件で無音
const REQUIRED_SPEECH_FRAMES = 4;
const WARMUP_FRAMES = 40;
const WARMUP_RISE = 0.15;
const STEADY_RISE = 0.005;
const MODULATION_MIN_DB = 3.0;
const MODULATION_WINDOW = 12;
const HYSTERESIS_S = 0.6;

export class VAD {
  constructor() { this.reset(); }

  reset() {
    this.noiseFloorDB = -55;
    this.frames = 0;
    this.consecutive = 0;
    this.recent = [];
    this.lastSpeechAt = 0;
    this.suppressed = false;
    this.speechSeconds = 0;
    this.startedAt = performance.now() / 1000;
    this.lastAt = this.startedAt;
  }

  setSuppressed(on) {
    this.suppressed = on;
    if (on) this.lastSpeechAt = performance.now() / 1000;
  }

  resetSilence() {
    this.lastSpeechAt = performance.now() / 1000;
    this.consecutive = 0;
    this.recent = [];
  }

  static std(xs) {
    if (xs.length < 2) return 0;
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    return Math.sqrt(xs.reduce((a, b) => a + (b - m) * (b - m), 0) / xs.length);
  }

  /** 1フレーム分の dB を入れて判定を返す。dt はフレーム間隔（秒）。 */
  process(db, dt) {
    const now = performance.now() / 1000;
    this.frames += 1;

    this.recent.push(db);
    if (this.recent.length > MODULATION_WINDOW) this.recent.shift();

    // ノイズフロアの追従。下がるのは速く、上がるのは遅く（起動直後だけ速い）。
    const rise = this.frames < WARMUP_FRAMES ? WARMUP_RISE : STEADY_RISE;
    if (db < this.noiseFloorDB) this.noiseFloorDB += (db - this.noiseFloorDB) * 0.2;
    else this.noiseFloorDB += (db - this.noiseFloorDB) * rise;

    const loud = db > this.noiseFloorDB + SPEECH_MARGIN_DB && db > ABSOLUTE_FLOOR_DB;
    const modulated = VAD.std(this.recent) >= MODULATION_MIN_DB;

    if (this.suppressed) {
      this.consecutive = 0;
      this.lastSpeechAt = now;
      return { levelDB: db, voiced: false, speaking: false, silence: 0 };
    }

    if (loud && modulated) this.consecutive += 1; else this.consecutive = 0;
    const voiced = this.consecutive >= REQUIRED_SPEECH_FRAMES;
    if (voiced) { this.lastSpeechAt = now; this.speechSeconds += dt; }

    const silence = this.lastSpeechAt ? now - this.lastSpeechAt : now - this.startedAt;
    return { levelDB: db, voiced, speaking: silence < HYSTERESIS_S, silence };
  }
}

/** MediaStream から dB を取り出して VAD に流し込む。 */
export class Meter {
  constructor(stream) {
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.src = this.ctx.createMediaStreamSource(stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.2;
    this.src.connect(this.analyser);
    this.buf = new Float32Array(this.analyser.fftSize);
    this.vad = new VAD();
    this.levelDB = -80;
  }

  /** 呼ぶたびに1フレーム処理する。dt は前回からの秒数。 */
  tick(dt) {
    this.analyser.getFloatTimeDomainData(this.buf);
    let sum = 0;
    for (let i = 0; i < this.buf.length; i++) sum += this.buf[i] * this.buf[i];
    const rms = Math.sqrt(sum / this.buf.length);
    const db = 20 * Math.log10(Math.max(rms, 1e-7));
    this.levelDB = db;
    return this.vad.process(db, dt);
  }

  close() { try { this.src.disconnect(); this.ctx.close(); } catch (e) {} }
}
