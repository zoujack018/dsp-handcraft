// 蓝图生成器（web/dist/generator.html，tools/build-web.js 打包时在开头引入本文件）和同目录的计算器（index.html）之间的小桥：
// 1. 页面最上面加一条「← 返回计算器」：在计算器「生成蓝图」的弹层里打开时是关掉弹层（发 dsphc-close），单独打开时跳到计算器；
// 2. 在计算器的弹层里时，每排好一张（页面发 dsphc-done；无带蓝图是复制了才发，kind: 'beltless'）告诉计算器这一张做的是哪几样、每组工厂做了什么（made），那边记成已完成。
// 计算器默认是本文件同目录的 index.html（英文的生成器在 en/ 里）；公开网站上生成器在 / 和 /en/、计算器在各自的 calc/ 里，
// 引入时写 data-calc="calc/index.html"（相对生成器这一页，发布副本的 web/build.js）。
// 图标用生成器自己旁边的 icons/ 目录（app.js 的 iconMode），不用这里给。嵌进 DSQ 网站的那份另有它自己的 bridge.js（还给图标）。
(function () {
  var inFrame = window.parent !== window;
  var me = document.currentScript;
  var at = me && me.getAttribute('data-calc');
  var home = at ? new URL(at, location.href) : new URL('index.html', me && me.src ? me.src : location.href);
  if (at && home.protocol !== 'file:') home.pathname = home.pathname.replace(/\/index\.html$/, '/'); // 网站上走 /calc/，本地文件照文件名
  var lang = new URLSearchParams(location.search).get('lang');
  if (lang) home.searchParams.set('lang', lang); // 只靠地址定的语言，回去也一样
  home = home.href;
  window.addEventListener('dsphc-done', function (e) {
    var d = e.detail || {};
    if (inFrame) window.parent.postMessage({ type: 'dsphc-done', targets: d.targets || [], ok: !!d.ok, kind: d.kind || null, made: d.made || null }, '*');
  });
  document.addEventListener('DOMContentLoaded', function () {
    var bar = document.createElement('div');
    bar.style.cssText = 'display:flex;align-items:center;padding:8px 16px;font-size:13px;background:#1d3557;color:#e8eef6';
    bar.innerHTML = '<a style="color:inherit;text-decoration:none">← 返回计算器</a>';
    bar.firstChild.href = home;
    document.body.insertBefore(bar, document.body.firstChild);
    if (inFrame) {
      bar.firstChild.onclick = function (e) {
        e.preventDefault();
        window.parent.postMessage('dsphc-close', '*');
      };
    }
  });
})();
