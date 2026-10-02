# 贡献指南

感谢你愿意花时间贡献。本文覆盖本仓遵循的约定；参与即表示你同意遵守
[行为准则](./CODE_OF_CONDUCT.md)。

## 本仓的基本规则

1. **凭据不进仓库、不进日志。** 配对二维码里的 payload 含一次性 PSK，截图、日志、issue
   里贴出的都必须是 `fake-…`。本仓不存任何长期凭据。
2. **`miniprogram_npm/` 是第三方预构建产物**，不要手动改它；升级走"重新裁剪"流程
   （见 [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)）。
3. **`miniprogram/theme/*.wxss` 是生成物**，不要手改。它们由开发仓里的生成脚本产出，
   手改会在下次生成时被覆盖。
4. **按需注入的前提不许破坏**：`app.json` 不放全局 `usingComponents`，每页只声明这一页用到的组件。
   `npm run check` 会拦。
5. **界面失败要如实。** "读不到 / 解密失败 / 环境缺能力"必须是独立的可见状态，
   不能折成"没有数据"。

## 上手

```sh
git clone https://github.com/providcc/dsh-remote-mp.git
cd dsh-remote-mp
npm run check        # 静态自检，不需要开发者工具
```

然后用微信开发者工具导入**本仓根目录**（`project.config.json` 所在处），详见
[README](./README.md#用微信开发者工具打开)。

## 开发流程

- 从 `main` **开分支**；提交保持聚焦，message 写清楚。
- **推送前跑 `npm run check`。**
- **修改界面必须自己在开发者工具里看一眼。** 编译器不报错不等于界面对——本仓有若干"静默失效"
  的坑（主题没切干净、`wx:elif` 落进 `else`、`scroll-into-view` 找不到节点），
  它们全都不会让 CI 变红。
- **不要为通过自检而放宽某条不变量。** 如果某条断言看起来不对，提出来。

## 风格

- 原生小程序语法（CommonJS 模块），`core/` 与 `pages/` 里的 JS 保持无分号、单引号风格。
- 注释解释**为什么**，不是**做了什么**——尤其当某个决定偏离了显而易见的做法。

## 提交与 PR

- 提交标题用清晰的祈使句（`fix: keep the scroll anchor on two static ids`）。
- PR 描述里写清：问题是什么、怎么做的、在开发者工具里怎么验的。
- CI 必须全绿（`npm run check`）。

## 报 bug 与提需求

用 issue 模板。任何与安全相关的，按 [SECURITY.md](./SECURITY.md) 走，不要开公开 issue。

## 许可

贡献即表示你同意你的贡献按 [MIT 许可](./LICENSE) 授权。
