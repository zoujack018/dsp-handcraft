// 英文模式接到页面上：页面搭好以后把整页的字翻一遍，之后页面每改一处字跟着翻（页面自己的代码照旧只出中文）。
// 语言在模板开头那段脚本里定（window.dsphcLang）；切换语言是记下选择、重新打开页面。
import { createTranslator, CJK } from './core.js';
import names from './en-names.js';
import template from './en-template.js';
import app from './en-app.js';
import engine1 from './en-engine1.js';
import engine2 from './en-engine2.js';
import extra, { scoped } from './en-extra.js';
import { normKey } from './core.js';

// 直接显示出来的属性（data-* 那几个由样式表的 attr() 画出来）
const ATTRS = ['title', 'aria-label', 'placeholder', 'alt', 'data-note', 'data-tag', 'data-short'];
const ATTR_SEL = ATTRS.map((a) => `[${a}]`).join(',');
const SKIP = new Set(['SCRIPT', 'STYLE', 'TEXTAREA']);
const OFF = '[data-i18n="off"]';
// 一行字里夹着数字、粗体这类小标签时（「从左边第 <span>3</span> 行送入」），整行连标签一起翻：标签先换成记号，翻完照英文的语序放回去
const INLINE = new Set(['SPAN', 'B', 'STRONG', 'EM', 'I', 'CODE', 'KBD']);
const MARK_0 = 0xf700;
const MARKS = /([\uf700-\uf7ff])/;

export const dictionaries = { names, dicts: [engine2, engine1, app, template, extra] }; // 后面的盖前面的

export function startEnglish() {
  const t = createTranslator(dictionaries);
  const doneText = new WeakMap();
  const doneAttr = new WeakMap();
  const text = (n) => {
    const s = n.data;
    if (!CJK.test(s) || doneText.get(n) === s) return;
    const p = n.parentElement;
    if (!p || SKIP.has(p.nodeName) || p.closest(OFF)) return;
    const key = normKey(s);
    const rule = scoped.find(([sel, dict]) => key in dict && p.closest(sel));
    const out = rule ? s.replace(s.trim(), rule[1][key]) : t.translate(s);
    doneText.set(n, out);
    if (out !== s) n.data = out;
  };
  const attrs = (e) => {
    if (e.closest(OFF)) return;
    for (const a of ATTRS) {
      const v = e.getAttribute(a);
      if (!v || !CJK.test(v)) continue;
      const seen = doneAttr.get(e) || doneAttr.set(e, {}).get(e);
      if (seen[a] === v) continue;
      const out = t.translate(v);
      seen[a] = out;
      if (out !== v) e.setAttribute(a, out);
    }
  };
  const triedLine = new WeakSet();
  const line = (p) => {
    triedLine.add(p);
    const kids = [...p.childNodes];
    if (kids.length < 2 || kids.length > 24 || SKIP.has(p.nodeName) || p.closest(OFF)) return;
    if (!kids.every((k) => k.nodeType === 3 || (k.nodeType === 1 && INLINE.has(k.nodeName))) || !kids.some((k) => k.nodeType === 1)) return;
    if (scoped.some(([sel, dict]) => kids.some((k) => k.nodeType === 3 && normKey(k.data) in dict) && p.closest(sel))) return; // 这一块另有翻法的照那个来
    const out = t.translate(kids.map((k, i) => (k.nodeType === 1 ? String.fromCharCode(MARK_0 + i) : k.data)).join(''), true);
    const parts = out.split(MARKS).filter((x) => x !== '');
    const used = parts.filter((x) => MARKS.test(x));
    if (CJK.test(out) || used.length !== kids.filter((k) => k.nodeType === 1).length || new Set(used).size !== used.length) return; // 没翻干净、标签对不上：还是一段一段翻
    p.replaceChildren(...parts.map((x) => (MARKS.test(x) ? kids[x.charCodeAt(0) - MARK_0] : x)));
  };
  const tree = (root) => {
    if (root.nodeType === 3) {
      const p = root.parentElement;
      if (p && CJK.test(root.data) && !triedLine.has(p)) line(p);
      if (root.isConnected) text(root);
      return;
    }
    if (root.nodeType !== 1 || SKIP.has(root.nodeName)) return;
    if (root.matches(ATTR_SEL)) attrs(root);
    root.querySelectorAll(ATTR_SEL).forEach(attrs);
    const texts = [];
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) if (CJK.test(n.data)) texts.push(n);
    for (const n of texts) {
      if (!n.isConnected) continue;
      const p = n.parentElement;
      if (p && !triedLine.has(p)) line(p);
      if (n.isConnected) text(n);
    }
  };
  tree(document.body);
  document.title = t.translate(document.title);
  new MutationObserver((list) => {
    for (const m of list) {
      if (m.type === 'characterData') text(m.target);
      else if (m.type === 'attributes') attrs(m.target);
      else m.addedNodes.forEach(tree);
    }
  }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  window.dsphcTr = t.translate; // 页面搜物品时拿它对英文名
  window.dsphcMissing = t.missing; // 没翻出来的原文，开发时在控制台看
}
