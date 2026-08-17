# 贡献指南 Contributing

欢迎任何形式的贡献：提 Issue、修 Bug、加功能、写文档、做测试，都可以！

## 快速开始

```bash
# 1. 本地运行（零依赖，只需 Node.js）
node serve.js            # 打开 http://localhost:8800

# 2. 跑测试
node tests/test_engine.js   # 规则引擎单元测试
node tests/smoke_dom.js     # DOM 桩冒烟测试

# 3. 修改源码后重新生成单文件版
node build-single-file.js
```

## 提 PR 之前

- **保持零依赖**：本项目刻意不引入 npm 包（应用与测试都只用 Node.js 内置模块），新代码请延续这一约定。
- **架构约束**：所有 JS 模块通过 `globalThis`/`window` 挂载（如 `ChessEngine`、`AISearch`、`Game`、`Chat`），不要引入 ES Module `import/export`，除非整体迁移。
- 新增功能尽量附带测试（`tests/` 下是纯 Node 桩测试，不需要浏览器）。
- 修改 `index.html` / `css/` / `js/` 后，运行 `node build-single-file.js` 并提交重新生成的 `ai-chinese-chess.html`。
- 提交信息建议用中文或英文均可，说明清楚改了什么、为什么。

## 代码规范

- 使用 2 空格缩进，分号结尾，与现有文件保持一致。
- 关键逻辑加注释（本项目注释为中文）。
- 保持向后兼容：用户浏览器 localStorage 里可能已有配置，改动存储结构时要做迁移兼容。

## Issue 模板要点

描述 Bug 时请附上：浏览器与版本、运行方式（双击 index.html / 启动游戏.bat / 在线版）、复现步骤、控制台报错截图。
