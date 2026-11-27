'use strict';

const text = (value) => ({ type: 'text', text: value });
const node = (name, children, attrs) => ({ name, children, ...(attrs ? { attrs } : {}) });

function plain(value) {
  return value.split(/\r?\n[ \t]*\r?\n/).filter((line) => line.trim())
    .map((line) => node('p', [text(line)], { style: 'white-space:pre-wrap' }));
}

const safeTags = {
  paragraph: 'p', strong: 'strong', em: 'em', del: 'del', blockquote: 'blockquote',
  list_item: 'li', table: 'table', codespan: 'code', hr: 'hr', br: 'br',
};

function renderToken(item, depth) {
  if (depth > 16) return text(item.text || item.raw || '');
  const render = (items) => (items || []).filter((child) => child.type !== 'space')
    .map((child) => renderToken(child, depth + 1));
  if (item.type === 'heading') return node('h' + item.depth, render(item.tokens));
  if (item.type === 'list') return node(item.ordered ? 'ol' : 'ul', render(item.items));
  if (item.type === 'code') return node('pre', [node('code', [text(item.text || '')])],
    { style: 'white-space:pre-wrap;word-break:break-all' });
  if (item.type === 'table') {
    const row = (name, cells) => node('tr', cells.map((cell) => node(name, render(cell.tokens))));
    return node('table', [node('thead', [row('th', item.header)]), node('tbody', item.rows.map((cells) => row('td', cells)))]);
  }
  if (safeTags[item.type]) return node(safeTags[item.type], item.tokens ? render(item.tokens) : [text(item.text || '')]);
  if (item.tokens) return node('span', render(item.tokens));
  return text(item.text || item.raw || '');
}

function createMarkdown(load) {
  let lexer;
  try { lexer = load().lexer; } catch {}
  return (input) => {
    const value = String(input ?? '');
    if (!lexer || value.length > 100000) return plain(value);
    try { return lexer(value).filter((item) => item.type !== 'space').map((item) => renderToken(item, 0)); }
    catch { return plain(value); }
  };
}

module.exports = { createMarkdown };
