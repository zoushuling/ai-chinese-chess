/* ============================================================
 * sound.js — 落子/吃子音效（Web Audio 实时合成，无外部文件）
 * 对外接口：
 *   GameSound.setEnabled(bool)   开关（设置弹窗）
 *   GameSound.unlock()           首次用户手势时解锁 AudioContext
 *   GameSound.playMove()         落子：清脆木头声
 *   GameSound.playCapture()      吃子：更重更响
 * ============================================================ */
(function (global) {
  'use strict';

  let enabled = true;
  let ctx = null;

  function ensureCtx() {
    if (!ctx) {
      const AC = global.AudioContext || global.webkitAudioContext;
      if (!AC) return null;
      try { ctx = new AC(); } catch (e) { ctx = null; return null; }
    }
    if (ctx.state === 'suspended') { try { ctx.resume(); } catch (e) { /* ignore */ } }
    return ctx;
  }

  /** 短促共振音：模拟棋子敲击木质棋盘 */
  function tone(freq, duration, volume, type, when) {
    const ac = ensureCtx();
    if (!ac) return;
    const t0 = ac.currentTime + (when || 0);
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = type || 'sine';
    osc.frequency.setValueAtTime(freq, t0);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, freq * 0.5), t0 + duration);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(volume, t0 + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    osc.connect(gain);
    gain.connect(ac.destination);
    osc.start(t0);
    osc.stop(t0 + duration + 0.03);
  }

  /** 短噪声 click：模拟木块敲击的瞬态 */
  function click(duration, volume, cutoff) {
    const ac = ensureCtx();
    if (!ac) return;
    const len = Math.max(1, Math.ceil(ac.sampleRate * duration));
    const buffer = ac.createBuffer(1, len, ac.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < len; i++) {
      const env = Math.pow(1 - i / len, 2.5);
      data[i] = (Math.random() * 2 - 1) * env;
    }
    const src = ac.createBufferSource();
    src.buffer = buffer;
    const filter = ac.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = cutoff;
    const gain = ac.createGain();
    gain.gain.value = volume;
    src.connect(filter);
    filter.connect(gain);
    gain.connect(ac.destination);
    src.start(ac.currentTime);
  }

  const GameSound = {
    setEnabled(v) { enabled = !!v; },
    isEnabled() { return enabled; },
    unlock() { ensureCtx(); },
    playMove() {
      if (!enabled) return;
      click(0.035, 0.25, 3200);
      tone(330, 0.08, 0.18, 'triangle', 0.005);
    },
    playCapture() {
      if (!enabled) return;
      click(0.07, 0.55, 1600);
      tone(170, 0.13, 0.35, 'sine', 0.004);
      tone(115, 0.1, 0.22, 'triangle', 0.012);
    },
  };

  global.GameSound = GameSound;
})(typeof window !== 'undefined' ? window : globalThis);
