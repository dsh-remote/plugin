# Can the DSH TUI front door display a half-block (▀▄█) QR code faithfully?

**Verdict:** The *renderer* is QR-perfect (1.0-row spacing, no wrap below terminal
width, correct EAW width for ▀▄█, zero sanitization — proven by the existing
DEEPSEEK wordmark and pixel whale). **The `{kind:'success', text}` delivery path is
unusable for a QR**: the result text is rendered as a *one-row, overflow-hidden,
horizontally-truncated, dimmed toast that auto-dismisses after 4 seconds*. Only
one line of the QR — its last line — would ever be visible.

All paths below are relative to `/Users/linbin/.dsh/profiles/tui/node_modules/dsh-cc-tui/lib/`.
`dsh-commands` paths are absolute.

---

## 1. How a command result is rendered

### 1.1 Delivery contract (`dsh-commands`)

`/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-commands/lib/types/types.d.ts:16-24`

```ts
export type CommandResult = {
    readonly kind: 'success';
    readonly text?: string;
    readonly sourceEventSeq?: number;
} | { readonly kind: 'error'; readonly text: string };
```

`…/dsh-commands/lib/types/types.d.ts:94-99` — the `command/done` session event carries
`{ commandId, kind: 'success' | 'error', text?, sourceEventSeq? }`.

**`dsh-commands` never writes to stdout.** `grep -rn "stdout\|console\.log\|write(" …/dsh-commands/lib/**/*.js`
returns **zero** hits. The result travels purely as a structured object.

### 1.2 The trace (complete)

| # | Location | Code |
|---|---|---|
| 1 | `types/channel.js:278` | `const commandService = ctx.get('commands')` |
| 2 | `types/channel.js:1277-1289` | `runExternalCommand()` → `commandService.execute(...)` → **`return execution?.result.text ?? ''`** |
| 3 | `types/screens/Chat.js:642-653` | `default:` arm of the slash-command switch: `channel.runExternalCommand(name, rawInput).then(text => { … channel.notify(text) })` |
| 4 | `types/channel.js:1056-1071` | `notify(text, options)` → `state.notifications.push({ id, text, color: options.color, timeoutMs: options.timeoutMs ?? 4000 })`, then `setTimeout(… splice …)` |
| 5 | `types/components/PromptInput.js:726` | `const lastNotification = channel.notifications[channel.notifications.length - 1]` — **only the newest toast is rendered** |
| 6 | `types/components/PromptInput.js:739` | the actual render (see below) |

`types/screens/Chat.js:645-652`:

```js
void channel.runExternalCommand(name, rawInput).then((text) => {
    if (text !== undefined && text !== '') {
        channel.notify(text);
    }
    ...
```

### 1.3 The renderer it reaches — `PromptInput.js:739`

```jsx
<Box flexDirection="column" marginTop={1} children={[
  lastNotification && (
    <Box position="absolute" marginTop={-1} height={1} width="100%"
         paddingLeft={2} paddingRight={1}
         flexDirection="column" justifyContent="flex-end" overflow="hidden">
      <Box justifyContent="flex-end">
        <Text color={lastNotification.color} dimColor={!lastNotification.color}
              wrap="truncate">{lastNotification.text}</Text>
      </Box>
    </Box>),
  …
```

**Not plain stdout — a styled, absolutely-positioned overlay box** with `height: 1`,
`overflow: hidden`, `wrap="truncate"`, `paddingLeft: 2`, `paddingRight: 1`,
`marginTop: -1`, and `dimColor` (SGR 2, via `types/ink/colorize.js:188-190`
→ `chalk.dim`).

### 1.4 There is NO transcript row for a command result

`types/channel.js`'s `renderEvent` has **no `case 'command/done'`**. The `default:`
arm (`types/channel.js:~2033-2045`) handles only `agent-preset/selected`.
`grep 'command/done'` in the TUI lib matches only comments
(`types/screens/Chat.js:639`, `types/channel.js:276`, `types/channel.d.ts:337`).

So `command/run` and `command/done` never produce a transcript row — the toast is
the **only** rendering of a command result.

### 1.5 The one transcript path that *would* work — but is unreachable from a handler

`types/channel.js:1290-1300`:

```js
pushLocal(title, lines) {
    state.rows.push({ id: nextRowId++, kind: 'local', text: title });
    for (const line of lines) {
        state.rows.push({ id: nextRowId++, kind: 'local-output',
                          text: preview(line, LOCAL_OUTPUT_LIMIT) });
    }
    state.emit();
},
```

Call sites (`grep pushLocal types/screens/Chat.js`) are **all hard-coded built-in
commands**: lines 110, 270, 284, 309, 343, 363, 379, 504, 519, 532, 537, 559, 570,
578, 585, 592, 599, 603, 613, 620. A `dsh-commands` handler returning
`{kind:'success', text}` **cannot** reach it.

### 1.6 `!`-prefixed local bash also destroys it

`types/channel.js:1582-1586`:

```js
state.rows.push({ id: nextRowId++, kind: 'local-output',
                  text: preview(output, LOCAL_OUTPUT_LIMIT) });
```

`preview()` (`types/channel.js:34-37`) does `text.replace(/\s+/g, ' ').trim()` then
caps at 240 chars — **all newlines collapse to single spaces**, and the whole output
becomes ONE row.

---

## 2. Vertical geometry — the critical question

### 2.1 The core renderer: exactly 1.0 row per newline

`types/ink/output.js:400-417` (inside `Output.get()`):

```js
for (const line of lines) {
    const lineY = y + offsetY;
    if (lineY >= screenHeight) break;
    const contentEnd = writeLineToScreen(screen, line, x, lineY, screenWidth, …);
    …
    offsetY++;
}
```

`lines` comes from `text.split('\n')` (`types/ink/output.js:338`). **No blank-line
insertion, no line-height multiplier — Ink has no line-height concept at all.**

`types/ink/render-node-to-output.js:519-520`:

```js
text = applyPaddingToText(node, text, softWrap);
output.write(x, y, text, softWrap);
```

`types/ink/render-node-to-output.js:303-316` (`applyPaddingToText`) is the *only*
place extra newlines could be injected, and only for the first text node's offset:

```js
text = '\n'.repeat(offsetY) + indentString(text, offsetX);
```

For the transcript row this is `indentString(text, 2)` with `offsetY = 0`.

### 2.2 Per-row-kind vertical spacing in the transcript

`types/components/MessageList.js:232-283`:

| kind | vertical spacing | evidence |
|---|---|---|
| `local-output` | **1.0** — no margin, no gap | `MessageList.js:276-277` |
| `local` | `marginTop: 1` | `MessageList.js:273-275` |
| `assistant` | `marginTop: addMargin ? 1 : 0` | `MessageList.js:236` |
| `notice` | `marginTop: 1` (renders as a `Divider`, one row) | `MessageList.js:269-270` |

`addMargin` is computed at `MessageList.js:48-55` and is **only** consulted by the
`assistant`, `compact` and (via `HeaderTitle`) tool rows — never by `local-output`.

### 2.3 `<Text wrap>` behaviour

`types/ink/components/Text.js:63` — `const wrap = t5 === undefined ? "wrap" : t5;`
→ `types/ink/components/Text.js:3-9` maps `"wrap"` to `{flexDirection:'row', textWrap:'wrap'}`.

`types/ink/wrap-text.js:37-43`:

```js
if (wrapType === 'wrap') {
    return wrapAnsi(text, maxWidth, { trim: false, hard: true });
}
```

`wrap` only inserts a newline when a logical line **exceeds the available width**
(`types/ink/render-node-to-output.js:473`: `const needsWrapping = widestLine(plainText) > maxWidth`).
Within the width, `\n` in the source maps 1:1 to a terminal row.

### 2.4 Measured result (headless render through the real ink core)

A 25-line, 49-column half-block QR rendered as a `local-output` row
(`<Box paddingLeft={2}><Text wrap="wrap">{QR}</Text></Box>`) through
`createRenderer` + `Output`:

```
screen 80x25
 0|  █▀▄█▄▀█▀▄█▄▀█▀▄█▄▀█▀▄█▄▀█▀▄█▄▀█▀▄█▄▀█▀▄█▄▀█▀▄█▄▀█▀▄█▀▄█▄▀█▀▄█|
 1|  ▀▄█▄▀█▀▄█▄▀█▀▄█▄▀█▀▄█▄▀█▀▄█▄▀█▀▄█▄▀█▀▄█▄▀█▀▄█▄▀█▀▄█▄▀█▀▄█▀▄█▀▄█▀|
 2|  ▄█▄▀█▀▄█▀▄█▀▄█▀▄█▀▄█▀▄█▀▄█▀▄█▀▄█▀▄█▀▄█▀▄█▀▄█▀▄█▀▄█▀▄█▀▄█▀▄█▀▄|
 …
24|  █▀▄█▄▀█▀▄█▄▀█▀▄█▄▀█▀▄█▄▀█▀▄█▄▀█▀▄█▄▀█▀▄█▄▀█▀▄█▄▀█▀▄█▄▀█▀▄█|
```

**25 rows in, 25 rows out, no blank rows. Vertical spacing = 1.0 exactly.**
Indent = 2 columns; each QR line occupies exactly 49 columns (cols 2–50).

### 2.5 What the toast actually produces (headless render, `PromptInput.js:739` verbatim)

```
toast box yoga: top=-1  h=1   innerTop=-24  innerH=25  textH=25
screen 80x4
r0: "  █▀▄█▄▀█▀▄█▄▀█▀▄█▄▀█▀▄█▄▀█▀▄█▄▀█▀▄█▄▀█▀▄█▄▀█▀▄█▄▀█▀▄█▄▀█▀▄█▀▄█"
r1: "────────────────────────────────────────────────────────────────────────────────"
r2: "> hello"
r3: "────────────────────────────────────────────────────────────────────────────────"
```

**Exactly ONE row painted, and it is the QR's LAST line** (bottom-aligned by
`justifyContent: "flex-end"`; rows −24..−1 clipped by `overflow: hidden"`), truncated
to `cols − paddingLeft(2) − paddingRight(1)` = 77 columns, and dimmed (SGR 2).
Plus `channel.js:1061` removes it after `timeoutMs ?? 4000` ms.

---

## 3. Horizontal geometry

### 3.1 Indent

- transcript `local-output`: **2 columns** — `types/components/MessageList.js:277`
  `<Box paddingLeft={2} …><Text dimColor>{text}</Text></Box>`
- toast: **2 columns left, 1 column right** — `PromptInput.js:739`
- assistant rows: 2-column `●` gutter — `types/components/messages/AssistantTextMessage.js:14`
  (`<NoSelect fromLeftEdge minWidth={2}>●`)

Indentation is uniform and constant, so it does **not** affect QR geometry
(consistent left offset preserves the square).

### 3.2 Where lines get wrapped — the exact column

`types/ink/render-node-to-output.js:462-473`:

```js
const maxWidth = Math.min(getMaxWidth(yogaNode), output.width - x);
const textWrap = node.style.textWrap ?? 'wrap';
const needsWrapping = widestLine(plainText) > maxWidth;
```

`output.width` is the root width = **the terminal's own column count**
(`types/ink/ink.js:215-216`: `setWidth(this.terminalColumns)`).

**There is no hard-coded 60- or 80-column wrap anywhere.** The wrap column is
`terminalColumns − x`. For a `local-output` row at an 80-column terminal that is
`80 − 2 = 78` columns — a 49-column QR passes untouched.

Measured:

```
wrap@40 lines=2 preserved=false      wrap@60 lines=1 preserved=true
wrap@47 lines=2 preserved=false      wrap@80 lines=1 preserved=true
wrap@50 lines=2 preserved=false      wrap@200 lines=1 preserved=true
```

(49/50 col lines wrap because the test line was 52 columns wide; the threshold is
exactly the available width.)

The toast, by contrast, truncates at `terminalColumns − 3`.

### 3.3 Horizontal cell writes

`types/ink/output.js:654-660`:

```js
setCellAt(screen, offsetX, y, {
    char: character.value, styleId, hyperlink,
    width: isWideCharacter ? 1 /* Wide */ : 0 /* Narrow */,
});
offsetX += isWideCharacter ? 2 : 1;
```

`stringWidth('█▀▄█…')` === character count → every block glyph is one `Narrow` cell.

---

## 4. Character support (East Asian Width / ambiguous width)

### 4.1 The measurement library is explicit and correct

`types/ink/stringWidth.js:2` — `import { eastAsianWidth } from 'get-east-asian-width'`
(also declared in `package.json` dependencies).

`types/ink/stringWidth.js:14-16` (docstring):

> The implementation uses eastAsianWidth directly with `ambiguousAsWide: false`,
> which correctly treats ambiguous-width characters as narrow (width 1) as
> recommended by the Unicode standard for Western contexts.

`types/ink/stringWidth.js:56` and `:75`:

```js
width += eastAsianWidth(codePoint, { ambiguousAsWide: false });
```

`types/ink/stringWidth.js:197` + `:207-209` (Bun fast path, unused under Node):

```js
const BUN_STRING_WIDTH_OPTS = { ambiguousIsNarrow: true };
```

**Measured:**

```
U+2580 ▀  ambiguousAsWide:false => 1   (true => 2)
U+2584 ▄  ambiguousAsWide:false => 1   (true => 2)
U+2588 █  ambiguousAsWide:false => 1   (true => 2)
```

So ▀▄█ (EAW **Ambiguous**) are measured as **narrow (1 cell)** — correct for macOS
Terminal / iTerm2 / Ghostty defaults.

### 4.2 The fast path is taken for block elements

`types/ink/stringWidth.js:82-99` (`needsSegmentation`) returns **false** for U+2580/84/88
(they are below the `0x2600–0x27bf` emoji range), so the simple per-code-point
`eastAsianWidth` path at `:51-60` is used.

`types/ink/stringWidth.js:119-185` (`isZeroWidth`) returns **false** for U+2580/84/88
— they are not combining marks, variation selectors, or format characters.

### 4.3 The ANSI tokenizer agrees

```
tokenize('█▀▄█') →
  [{"type":"char","value":"█","fullWidth":false},
   {"type":"char","value":"▀","fullWidth":false},
   {"type":"char","value":"▄","fullWidth":false},
   {"type":"char","value":"█","fullWidth":false}]
```

Consistent with `types/utils/sliceAnsi.js:35` (`token.fullWidth ? 2 : stringWidth(…)`)
and `types/ink/output.js:506` (`width: stringWidth(grapheme)`).

**No mis-measurement. Alignment is correct.**

### 4.4 Sanitization / transformation of command output text

**None.** Verified:

- `types/ink/squash-text-nodes.js` — `out.push({ text: childNode.nodeValue, … })`, verbatim.
- `types/utils/sliceAnsi.js:70` — `result += token.type === 'control' ? token.code : token.value`, verbatim.
- `types/ink/output.js:526` — `styledCharsFromTokens(tokenize(line))`, verbatim.
- `types/ink/screen.js:668` — `cells[ci] = internCharString(screen, cell.char)`, verbatim.

The **only** characters dropped in the render path (`types/ink/output.js:536-628`,
`:634-636`) are:

1. C0 controls (`codePoint <= 0x1f`) — CR, LF, BS, BEL, VT, FF; plus incomplete
   ESC/OSC/CSI sequences.
2. Zero-width codepoints (`character.width === 0`) — combining marks, ZWJ, VS16,
   BOM, tag characters.

Neither applies to U+2580 / U+2584 / U+2588.

There is **no** `.replace(/[^\x00-\x7F]/…)`, no `safeText`, no ASCII folding.
`grep -rn "sanitiz\|safeText\|non-ASCII\|asciiOnly\|stripNonAscii"` over `lib/**/*.js`
returns only two incidental comment hits
(`types/ink/stringWidth.js:26`, `types/ink/selection.js:265`).

---

## 5. Inline mode (`fullscreen: false`) and a 25+ line block

### 5.1 Config resolution

- `/Users/linbin/.dsh/profiles/tui/cordis.patch.yml:23-25`
  ```yaml
  # 全屏 alternate-screen 模式。默认关闭（inline 模式终端原生选区/复制）。
  fullscreen: false
  ```
- `types/index.js:16` — `fullscreen: Schema.boolean().default(false)`
- `types/plugin.js:138` —
  `const tree = React.createElement(ThemeProvider, null, config.fullscreen ? React.createElement(AlternateScreen, null, chat) : chat);`

### 5.2 Inline mode renders at full content height — no truncation

`types/ink/ink.js:213-216` — the root yoga node is given **width only**:

```js
this.rootNode.yogaNode.setWidth(this.terminalColumns);
this.rootNode.yogaNode.calculateLayout(this.terminalColumns);
```

`types/ink/renderer.js:63`:

```js
const height = options.altScreen ? terminalRows : yogaHeight;
```

So in inline mode `screen.height === yogaHeight` (the full content height).
`types/ink/renderer.js:108-119` sets `viewport.height = terminalRows`; rows above the
viewport are written into the terminal's **native scrollback**
(`types/ink/log-update.js:226-237`, `:238-244`, `:328-329`
`if (growing) renderFrameSlice(screen, next, prev.screen.height, next.screen.height)`).

### 5.3 Verified: a Chat-shaped tree with a 25-line QR

Reproducing `types/screens/Chat.js:1221-1232` (root `<Box flexDirection="column"
flexGrow={1} width="100%">` → `<ScrollBox flexGrow={1} flexShrink={1} stickyScroll>` →
content wrapper → rows → fixed bottom), with 20 filler rows before the QR and
`terminalRows = 24`:

```
screen 80x46  viewportH=24  scrollboxH=45  contentH=45  scrollHeight=45  innerHeight=45
rows containing block glyphs: 25  →  20,21,22,…,44
r20: "  █▀▄█▄▀█▀▄█▄▀█▀▄█▄▀█▀▄█▄▀█▀▄█▄▀█▀▄█▄▀█▀▄█▄▀█▀▄█▄▀█▀▄█▄▀█▀▄█"
r21: "  ▀▄█▄▀█▀▄█▄▀█▀▄█▄▀█▀▄█▄▀█▀▄█▄▀█▀▄█▄▀█▀▄█▄▀█▀▄█▄▀█▀▄█▄▀█▀▄█▀▄█▀▄█▀"
r44: "  █▀▄█▄▀█▀▄█▄▀█▀▄█▄▀█▀▄█▄▀█▀▄█▄▀█▀▄█▄▀█▀▄█▄▀█▀▄█▄▀█▀▄█▄▀█▀▄█"
```

`scrollHeight == innerHeight` → the ScrollBox does **not** clip; all 25 QR rows are
present. Rows 20–23 are inside the terminal viewport, 24–44 land in scrollback.

### 5.4 Maximum output height

**No height cap in inline mode.** Caps that do exist are row-count based and do not
affect a `local-output` row:

- `types/components/MessageList.js:26` — `const MAX_RENDERED_ROWS = 300;` older rows
  fold behind a `Divider` (Ctrl+E restores).
- `types/channel.js:33` — `const MAX_ROWS = 600;` with `foldRows`
  (`types/channel.js:48-76`); **`types/channel.js:56-57` explicitly skips**
  `local-output` (`if (row.kind !== 'user' && … && row.kind !== 'tool') continue;`).
- `types/channel.js:24, 34-37` — `preview()` cap of 240 chars. A 49-char half-block
  QR line passes through `preview()` unchanged (`\s+` collapsing is a no-op because
  there is no whitespace), **but** `pushLocal` flattens each *line* separately so the
  newlines survive; the `!`-command path (`:1585`) does **not** split lines and
  therefore destroys them.

### 5.5 But the toast is height-pinned regardless

The toast's `height={1}` is a hard cap in **both** modes — inline and alt-screen
alike. `types/ink/render-node-to-output.js:564-572` pushes a clip region for
`overflow: 'hidden'`, so only 1 row can ever be painted.

---

## 6. Arbitrary Unicode / emoji / box-drawing support

**Fully supported. No sanitizing filter, no "safe text" helper, no `?` or U+FFFD
fallback.** `grep -rn "'?'\|\"?\""` over `lib/**/*.js` returns only CSI/CSI-private-
mode constants (`types/ink/termio/parser.js:180`, `types/ink/terminal-querier.js:91`)
and a keyboard key comparison (`types/components/PromptInput.js:673`).

### 6.1 The strongest possible evidence: the TUI *already* renders half-block pixel art

**DEEPSEEK / HARNESS wordmark** — `types/components/bigfont.js:1-12`:

```js
/** Glyph rows are 5 columns wide; `·` is a transparent cell. */
const GLYPHS = {
    D: ['█▀▀▀▄', '█···█', '█···█', '█···█', '█▄▄▄▀'],
    E: ['█▀▀▀▀', '█····', '█▀▀▀·', '█····', '█▄▄▄▄'],
    …
```

`renderBigText()` returns **5 strings** (`types/components/bigfont.js:42-48`,
`for (let row = 0; row < 5; row++)`), and `types/components/LogoV2.js:92-94` renders
**each row as its own `<Text>` inside a gapless column Box**:

```jsx
bigDeepSeek.map((row, index) => <Text wrap="truncate-end">{row}</Text>)
```

→ exactly one terminal row per row, one cell per glyph, no gap, no margin.

**Pixel whale** — `types/components/whaleFrames.js` (25×40 sprite, palette letters
`D`/`B`/`L`/`W`) rendered to 13 half-block rows by `types/components/Whale.js:18-61`:

```js
if (up !== undefined && lo !== undefined) { seq = fg(up) + bg(lo); ch = '▀'; }
else if (up !== undefined)                  { seq = fg(up);            ch = '▀'; }
else if (lo !== undefined)                  { seq = fg(lo);            ch = '▄'; }
```

and `types/components/Whale.js:58`:

```jsx
<Box flexDirection="column" flexShrink={0} width={width}>
  {rows.map((row, index) => <Text wrap="truncate-end">{row}</Text>)}
</Box>
```

A 25×40-pixel animated sprite is displayed on this TUI at startup. That is a
strictly harder rendering task than a 25×49 QR, and it works.

### 6.2 Broad glyph coverage already exercised

`types/cc/figures.js` ships `⏺ ❯ ✓ ∙ ✻ ↯ ○ ◐ ● ◉ ▶ ⏸ ↻ ← → …` — several of these
are EAW-ambiguous or wide (◐ ◉ ⏸), so the width machinery is continuously exercised.
`package.json` declares `emoji-regex: ^10.0.0`, consumed at
`types/ink/stringWidth.js:1, 5, 62-79` and `:100-118` (`getEmojiWidth`).

---

## Bottom line

| Property | Value | Evidence |
|---|---|---|
| Rows per newline | **1.0** (no blank rows, no line-height) | `output.js:400-417`; headless render |
| Blank-line / margin insertion | none for `local-output` | `MessageList.js:276-277` |
| Indent | **2 columns**, constant | `MessageList.js:277` |
| Wrap column | `terminalColumns − x` (no fixed 60/80) | `render-node-to-output.js:470`; `ink.js:215-216` |
| `stringWidth(▀▄█)` | **1** each (EAW Ambiguous → narrow) | `stringWidth.js:56, 75, 197`; measured |
| Text sanitization | **none** | `squash-text-nodes.js`, `sliceAnsi.js:70`, `screen.js:668` |
| Inline-mode height cap | **none** | `renderer.js:63`; `ink.js:215-216`; headless render |
| **`{kind:'success', text}` display** | **1 row, overflow-clipped, truncated, dimmed, 4 s timeout** | `PromptInput.js:726, 739`; `channel.js:1056-1071` |

### Practical options, ranked

1. **Patch `Chat.js:645-652`** to call `channel.pushLocal('/', <qr lines>)` instead of
   `channel.notify(text)`. `local-output` rows give exact 1.0-row spacing, 2-column
   indent, no truncation (headless-verified). Watch out for `preview()`
   (`channel.js:34-37`) — safe for half-block QRs (no whitespace, ≤240 chars/line),
   but it would break a **space-based** QR (`██  ██`), which must be flattened by
   the caller first.
2. **Have the model emit the QR** as a fenced code block in its reply → `assistant`
   row → `AssistantTextMessage.js:14` (2-column `●` gutter) → `Markdown.js:105`
   `<Box flexDirection="column" gap={1}>` — the `gap: 1` applies only *between*
   markdown block elements, and a single fenced code block is one element, so its
   internal lines stay 1.0 apart. `cc/markdown.js:92-106` routes code through
   `highlight.highlight(text, {language:'plaintext'})`; **measured** — highlight.js
   `plaintext` passes `█▀▄█▀▄█` through byte-identical. Also `Markdown.js:89`
   `.trim()`s the chunk, which strips leading/trailing blank rows only.
3. **Use `dsh web`** (the GUI front door at `http://127.0.0.1:19387`) instead of the
   TUI — a `<pre>`/`<img>` rendering has none of these constraints.
4. Do **not** use `!`-mode bash (`channel.js:1585` flattens newlines) and do **not**
   rely on the notification toast (`PromptInput.js:739`).

### NOT DETERMINABLE from the compiled source

- Whether a *specific* terminal emulator renders EAW-Ambiguous block glyphs at width 1
  — that is a terminal-side setting. If the user enables "treat ambiguous-width
  characters as double-width" (some CJK-oriented terminal configs), ▀▄█ would render
  2 cells wide in the terminal while the TUI assumes 1, and the QR would be distorted.
  This cannot be resolved from `dsh-cc-tui`; it must be checked on the user's terminal.
- `dsh-commands`' own handler implementations (e.g. a `/qr` command that would produce
  the block glyphs) are not present in this installation — `dsh-commands` ships only
  types plus host/remote-client plumbing. A `/qr` command must be written.
