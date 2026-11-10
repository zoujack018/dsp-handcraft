// 公开网站的两个入口（发布副本放在 GitHub Pages 上）：中文在根目录、英文在 en/，打包时（tools/build-web.js、发布副本的 web/build.js）
// 给页面头上加搜索引擎和分享卡片看的标签（canonical、互相指的 hreflang、description、Open Graph），英文那份写死英文的 lang、标题、默认语言。
// 嵌进 DSQ 的那份不经过这里。
export const SITE = 'https://dspbp.com/';
const IMG = { w: 2880, h: 1800 }; // 发布副本 img/ 里的两张截图

const PAGES = {
  zh: {
    path: '',
    hreflang: 'zh-CN',
    locale: 'zh_CN',
    name: '戴森球计划蓝图生成器',
    description: '戴森球计划产线蓝图生成器：选好目标产物和每分钟产量，自动排出手搓风格的产线蓝图（每种物品走自己的带，工厂分行、行间夹传送带通道），复制后贴进游戏。在浏览器里运行，不用安装。',
    image: 'img/screenshot-zh.webp',
    imageAlt: '蓝图生成器：引力矩阵 60/分',
  },
  en: {
    path: 'en/',
    hreflang: 'en',
    locale: 'en_US',
    name: 'DSP Blueprint Generator',
    title: 'DSP Blueprint Generator · Dyson Sphere Program',
    description: 'Pick a product and a rate per minute and get a Dyson Sphere Program production-line blueprint, laid out the way players build by hand. Free, in your browser.',
    image: 'img/screenshot-en.webp',
    imageAlt: 'The generator with a Gravity Matrix 60/min line',
  },
};
const OTHER = { zh: 'en', en: 'zh' };

const attr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const must = (s, a, b) => {
  if (!s.includes(a)) throw new Error(`没找到要换的「${a}」`);
  return s.replace(a, () => b);
};
const url = (lang) => SITE + PAGES[lang].path;
const alternates = (tag) =>
  [
    ...Object.keys(PAGES).map((l) => `<${tag} rel="alternate" hreflang="${PAGES[l].hreflang}" href="${url(l)}"/>`),
    `<${tag} rel="alternate" hreflang="x-default" href="${url('en')}"/>`, // 既不是中文也不是英文的用户：给英文
  ];

/**
 * 网站上的一个入口：page 是打包好的页面（模板填好脚本），lang 'zh' | 'en'。英文那份放在 en/ 里（文件名同中文那份）：网站图标、icons/ 往上一层找。
 */
export function sitePage(page, lang) {
  const p = PAGES[lang];
  const o = PAGES[OTHER[lang]];
  const up = lang === 'en' ? '../' : '';
  let s = page;
  if (lang === 'en') {
    const zhTitle = /<title>([^<]*)<\/title>/.exec(s)[1];
    s = must(s, '<html lang="zh-CN">', `<html lang="en" data-zh-title="${attr(zhTitle)}">`);
    s = must(s, `<title>${zhTitle}</title>`, `<title>${attr(p.title)}</title>`);
    s = must(s, "/*__LANG__*/'auto'", "'en'");
    s = must(s, '<link rel="icon" href="favicon.ico">', '<link rel="icon" href="../favicon.ico">');
  }
  s = must(s, "/*__ROOT__*/''", JSON.stringify(up));
  s = must(s, '/*__ALT__*/null', JSON.stringify({ lang: OTHER[lang], href: lang === 'en' ? '../' : o.path }));
  const head = [
    `<meta name="description" content="${attr(p.description)}">`,
    `<link rel="canonical" href="${url(lang)}">`,
    ...alternates('link').map((x) => x.replace('/>', '>')),
    '<meta property="og:type" content="website">',
    `<meta property="og:site_name" content="${attr(p.name)}">`,
    `<meta property="og:title" content="${attr(p.title || p.name)}">`,
    `<meta property="og:description" content="${attr(p.description)}">`,
    `<meta property="og:url" content="${url(lang)}">`,
    `<meta property="og:image" content="${SITE}${p.image}">`,
    '<meta property="og:image:type" content="image/webp">',
    `<meta property="og:image:width" content="${IMG.w}">`,
    `<meta property="og:image:height" content="${IMG.h}">`,
    `<meta property="og:image:alt" content="${attr(p.imageAlt)}">`,
    `<meta property="og:locale" content="${p.locale}">`,
    `<meta property="og:locale:alternate" content="${o.locale}">`,
    '<meta name="twitter:card" content="summary_large_image">',
  ];
  const icon = `<link rel="icon" href="${up}favicon.ico">`;
  return must(s, icon, `${icon}\n${head.join('\n')}`);
}

/** 网站根目录的 sitemap.xml */
export const sitemap = () =>
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
    ...Object.keys(PAGES).flatMap((l) => ['  <url>', `    <loc>${url(l)}</loc>`, ...alternates('xhtml:link').map((x) => `    ${x}`), '  </url>']),
    '</urlset>',
    '',
  ].join('\n');

/** 网站根目录的 robots.txt */
export const robots = () => `User-agent: *\nAllow: /\n\nSitemap: ${SITE}sitemap.xml\n`;
