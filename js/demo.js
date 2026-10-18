// 產生一首約 34 秒的示範曲（純合成音）與對應 LRC，方便第一次測試同步歌詞與背景播放
const SR = 22050;
const BPM = 92;
const beat = 60 / BPM;

// 簡單的五聲音階旋律（MIDI note, 拍數）
const MELODY = [
  [69,1],[72,1],[74,2], [76,1],[74,1],[72,2], [69,1],[67,1],[69,2], [72,2],[0,2],
  [74,1],[76,1],[79,2], [76,1],[74,1],[72,2], [74,1],[72,1],[69,2], [69,3],[0,1],
  [72,1],[74,1],[76,2], [79,1],[81,1],[79,2], [76,1],[74,1],[72,1],[74,1], [69,4],
];
const CHORDS = [57, 53, 55, 52, 57, 53, 55, 57, 53, 55, 52, 57]; // 每小節根音

const LRC = `[ti:示範曲 · 晚風]
[ar:聲軌 Demo]
[00:00.00]（前奏）
[00:01.30]晚風吹過紡織廠的窗
[00:06.52]機台的節拍慢慢變輕
[00:11.74]把一天的線頭收進口袋
[00:16.96]月光替我們織完最後一行
[00:22.17]耳機裡的歌還在唱
[00:27.39]一句一句 跟著時間亮起來
[00:32.61]（尾聲）`;

function writeWav(samples) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, SR, true); v.setUint32(28, SR * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 0x7fff, true);
  return new Blob([buf], { type: 'audio/wav' });
}

const hz = n => 440 * 2 ** ((n - 69) / 12);

export async function makeDemo() {
  const totalBeats = MELODY.reduce((a, [, d]) => a + d, 0) + 4; // + 前奏一小節
  const dur = totalBeats * beat + 1.2;
  const ctx = new OfflineAudioContext(1, Math.ceil(dur * SR), SR);
  const master = ctx.createGain(); master.gain.value = 0.5; master.connect(ctx.destination);

  const note = (freq, t, len, type, vol) => {
    const o = ctx.createOscillator(); const g = ctx.createGain();
    o.type = type; o.frequency.value = freq;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0008, t + len);
    o.connect(g).connect(master); o.start(t); o.stop(t + len + 0.05);
  };

  // 和弦墊底
  for (let bar = 0; bar * 4 < totalBeats; bar++) {
    const root = CHORDS[bar % CHORDS.length], t = bar * 4 * beat;
    [0, 7, 12].forEach((iv, k) => note(hz(root + iv - 12), t, 4 * beat, 'triangle', 0.12 - k * 0.025));
    for (let b = 0; b < 4; b++) note(hz(root + 12 + (b % 2 ? 7 : 0)), t + b * beat, beat * 0.9, 'sine', 0.05);
  }
  // 旋律（從第 2 小節開始，約 1.3s 進入）
  let t = 2 * beat;
  for (const [n, d] of MELODY) { if (n) note(hz(n), t, d * beat * 0.95, 'sine', 0.32); t += d * beat; }

  const rendered = await ctx.startRendering();
  const blob = writeWav(rendered.getChannelData(0));
  return { blob, lrc: LRC, title: '示範曲 · 晚風', artist: '聲軌 Demo', name: '聲軌 Demo - 示範曲 · 晚風.wav' };
}
