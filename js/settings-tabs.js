/* ============================================================
 * settings-tabs.js — 设置弹窗页签组件（硬切换，无动画）
 * 暴露：SettingsTabs.init(opts) / switchTo(key) / active()
 * 行为契约（与 docs/settings-tabs-spec.md 对齐）：
 *   1. 硬切换：直接 classList 切 .hidden，无 setTimeout/transition/animation
 *   2. onChange 仅在用户点击时触发，init 的 initial 不触发
 *   3. init 可重复调用（重复调用只重绑一次，不叠加监听）
 *   4. switchTo 与点击走同一路径；非法 key 静默忽略
 *   5. 仅依赖全局 .hidden 类与传入的 DOM，不读 main.js 任何变量
 *   6. 页签集合从 tabsRoot 内 .stab[data-pane] 动态推导（V0.5.1 起支持任意数量页签）
 * ============================================================ */
(function (global) {
  'use strict';

  const SettingsTabs = {
    _bound: false,         // 标记是否已绑过监听，避免重复 init 叠加
    _tabsRoot: null,
    _panes: null,
    _onChange: null,
    _current: null,        // 当前 active key
    /** 页签键集合（单一事实来源 = 按钮的 data-pane，去重保序） */
    _keys() {
      const out = [];
      if (!this._tabsRoot) return out;
      const btns = this._tabsRoot.querySelectorAll('.stab');
      btns.forEach(b => {
        const k = b.dataset.pane;
        if (k && !out.includes(k)) out.push(k);
      });
      return out;
    },
    /** 内部：执行切换（classList + 同步 .active） */
    _apply(key) {
      if (!this._panes || !this._tabsRoot) return false;
      const pane = this._panes[key];
      if (!pane) return false;
      // 所有 pane：visible 的移除 .hidden，hidden 的加 .hidden
      this._keys().forEach(k => {
        const p = this._panes[k];
        if (!p) return;
        if (k === key) p.classList.remove('hidden');
        else p.classList.add('hidden');
      });
      // 页签按钮：active 态迁移
      const btns = this._tabsRoot.querySelectorAll('.stab');
      btns.forEach(b => b.classList.toggle('active', b.dataset.pane === key));
      this._current = key;
      return true;
    },
    /** 用户点击处理：从 button.dataset.pane 读 key 后切 */
    _onClick(ev) {
      const btn = ev.target.closest('.stab');
      if (!btn) return;
      const key = btn.dataset.pane;
      if (!this._keys().includes(key)) return;
      if (this._current === key) return; // 重复点击不触发
      if (!this._apply(key)) return;
      if (typeof this._onChange === 'function') this._onChange(key);
    },
    /** 初始化。opts：{tabsRoot, panes, initial, onChange} */
    init(opts) {
      opts = opts || {};
      const tabsRoot = opts.tabsRoot;
      const panes = opts.panes || {};
      if (!tabsRoot) throw new Error('SettingsTabs.init: 缺少 tabsRoot');
      // 校验 pane 至少要有 general
      if (!panes.general) throw new Error('SettingsTabs.init: 缺少 panes.general');
      this._tabsRoot = tabsRoot;
      this._panes = panes;
      this._onChange = typeof opts.onChange === 'function' ? opts.onChange : null;
      const initial = this._keys().includes(opts.initial) ? opts.initial : 'general';
      // 第一次 init：绑监听；再次 init：清掉旧监听再绑（不叠加）
      if (this._bound) tabsRoot.removeEventListener('click', this._onClickRef);
      this._onClickRef = this._onClick.bind(this);
      tabsRoot.addEventListener('click', this._onClickRef);
      this._bound = true;
      // 应用初始页签（init 的 initial 不触发 onChange）
      this._apply(initial);
    },
    /** 程序化切换；非法 key 静默忽略 */
    switchTo(key) {
      if (!this._keys().includes(key)) return false;
      if (this._current === key) return true;
      if (!this._apply(key)) return false;
      // 程序化切换按规则只切面板，不触发 onChange（与 init 语义对齐）
      return true;
    },
    /** 当前 active key；未 init 返回 null */
    active() { return this._current; },
  };

  global.SettingsTabs = SettingsTabs;
})(typeof window !== 'undefined' ? window : globalThis);
