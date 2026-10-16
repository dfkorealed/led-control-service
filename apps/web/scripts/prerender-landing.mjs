import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { assertLandingModules, landingPageFiles, landingSeoFiles } from './static-landing-contract.mjs';

const escape = value => value.replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;').replaceAll('>','&gt;');

function pageHead({origin, pathname, title, description}) {
  const canonical = origin + pathname;
  const organization = { '@type':'Organization', '@id':'https://dfkorealed.com/#organization', name:'(주)디에프코리아', url:'https://dfkorealed.com' };
  const data = { '@context':'https://schema.org', '@graph':[
    organization,
    { '@type':'WebSite', '@id':`${origin}/#website`, url:origin+'/', name:'킨다', inLanguage:'ko-KR', publisher:{'@id':organization['@id']} },
    { '@type':'WebPage', '@id':canonical+'#webpage', url:canonical, name:title, description, inLanguage:'ko-KR', isPartOf:{'@id':`${origin}/#website`}, publisher:{'@id':organization['@id']} }
  ] };
  return `<title>${escape(title)}</title>
    <meta name="description" content="${escape(description)}" />
    <link rel="canonical" href="${canonical}" />
    <meta property="og:type" content="website" />
    <meta property="og:locale" content="ko_KR" />
    <meta property="og:site_name" content="킨다" />
    <meta property="og:title" content="${escape(title)}" />
    <meta property="og:description" content="${escape(description)}" />
    <meta property="og:url" content="${canonical}" />
    <meta property="og:image" content="${origin}/brand/kinda-mark-512.png" />
    <meta property="og:image:width" content="512" />
    <meta property="og:image:height" content="512" />
    <meta property="og:image:alt" content="킨다" />
    <meta name="naver-site-verification" content="903a4698ea1c95337d185216a9167d810b0fbd9c" />
    <script type="application/ld+json">${JSON.stringify(data).replaceAll('<','\\u003c')}</script>`;
}

/** Build-time rendering uses the real page tree, never an effect-mutated browser snapshot. */
export async function prerenderLanding(root, html, define) {
  let modules = [];
  const result = await build({
    configFile:false, root, publicDir:false, envDir:false, envPrefix:'PUBLIC_UNUSED_', define:{...define, 'process.env.NODE_ENV':JSON.stringify('production')},
    logLevel:'warn', plugins:[react(), {
      name:'landing-renderer-boundary',
      generateBundle() {
        modules = [...this.getModuleIds()];
        assertLandingModules(modules, root, 'src/features/landing/render-public.tsx');
      }
    }],
    // All dependencies are bundled so provenance includes the renderer's React
    // packages and no runtime import can resolve outside the audited checkout.
    ssr:{noExternal:true},
    build:{ssr:resolve(root,'src/features/landing/render-public.tsx'),write:false,minify:true,sourcemap:false,target:'es2022',rollupOptions:{output:{format:'cjs',entryFileNames:'renderer.cjs',inlineDynamicImports:true}}}
  });
  if (Array.isArray(result) || !('output' in result) || result.output.length !== 1 || result.output[0].type !== 'chunk' || result.output[0].imports.length || result.output[0].dynamicImports.length) throw Error('Renderer must be one self-contained build-only chunk');
  const chunk = result.output[0];
  await mkdir(resolve(root,'.local'),{recursive:true});
  const temporary = await mkdtemp(resolve(root,'.local/landing-ssr-'));
  let rendered;
  try {
    const file = resolve(temporary,'renderer.cjs');
    await writeFile(file, chunk.code);
    const renderer = await import(pathToFileURL(file).href);
    rendered = renderer.renderPublicPages();
  } finally { await rm(temporary,{recursive:true,force:true}); }
  const {origin,pages} = rendered;
  if (origin !== 'https://kinda.dfkorealed.com' || JSON.stringify(pages.map(page=>page.pathname)) !== JSON.stringify(Object.keys(landingPageFiles))) throw Error('Unexpected public SEO origin or routes');
  if (!html.includes('<div id="root"></div>')) throw Error('Missing empty landing HTML root');
  const assets = {};
  for (const page of pages) {
    if (!page.body.includes('<main') || !page.body.includes('<h1')) throw Error('Missing semantic public page');
    // Remove the source template's fallback metadata before adding each route's
    // complete head. Keep icons, stylesheet and Vite's processed script intact.
    const base = html.replace(/<title>[^<]*<\/title>\s*/g,'').replace(/<meta\s+(?:name="description"|property="og:[^"]+")[^>]*>\s*/g,'');
    assets[landingPageFiles[page.pathname]] = base.replace('</head>',`    ${pageHead({origin,...page})}\n  </head>`).replace('<div id="root"></div>',`<div id="root">${page.body}</div>`);
  }
  assets[landingSeoFiles[0]] = `User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`;
  assets[landingSeoFiles[1]] = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${pages.map(page=>`  <url><loc>${origin}${page.pathname}</loc></url>`).join('\n')}\n</urlset>\n`;
  return {assets, modules, prerender:{modules:Object.keys(chunk.modules),sha256:createHash('sha256').update(chunk.code).digest('hex')}};
}
