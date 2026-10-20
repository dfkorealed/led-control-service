import {test,expect} from '@playwright/test';
if(process.env.WEB_DEPLOY_MODE !== 'landing') throw new Error('Landing release cannot test service mode');
for(const path of ['/','/features','/pricing']) {
  test(`public ${path}: reload, disabled login, contact fallback and focus return without API`,async({page,browser})=>{
    const title = path === '/' ? '킨다 | 스마트 조명 관제 서비스' : path === '/features' ? '주요 기능 | 킨다 조명 관제' : '요금제 | 킨다 조명 관제';
    const canonical = `https://kinda.dfkorealed.com${path === '/' ? '/' : path}`;
    const errors:string[]=[];
    page.on('pageerror',error=>errors.push(error.message));
    page.on('console',message=>{if(message.type()==='error') errors.push(message.text());});
    const initial = await page.request.get(path);
    expect(initial.status()).toBe(200);
    const html = await initial.text();
    expect(html).toContain(`<title>${title}</title>`);
    expect(html).toContain(`<link rel="canonical" href="${canonical}"`);
    expect(html).toContain(`<meta property="og:url" content="${canonical}"`);
    expect(html).toContain('name="naver-site-verification" content="903a4698ea1c95337d185216a9167d810b0fbd9c"');
    expect(html).toMatch(/<main\b/);expect(html).toMatch(/<h1\b/);expect(html).toContain('(주)디에프코리아');
    expect(html).not.toMatch(/name="robots" content="noindex/);
    const staticContext=await browser.newContext({javaScriptEnabled:false,baseURL:test.info().project.use.baseURL});
    try {
      const staticPage=await staticContext.newPage();await staticPage.goto(path);
      await expect(staticPage.getByRole('heading',{level:1})).toBeVisible();
      await expect(staticPage.getByRole('main')).toHaveCount(1);
      await expect(staticPage).toHaveTitle(title);
      const description=staticPage.locator('meta[name="description"]');await expect(description).toHaveCount(1);
      expect((await description.getAttribute('content'))!.length).toBeGreaterThan(50);
      expect(await description.getAttribute('content')).toContain(path === '/' ? '도면 위 조명 위치와 상태 확인부터' : path === '/features' ? '모니터링, 조명 제어, 운영 통계와 보고서, 도면 편집까지.' : '현장 1곳당 월 99,000원으로 조명 1,000개');
      expect(await description.getAttribute('content')).not.toContain('전화 또는 이메일');
      await expect(staticPage.locator('meta[property="og:description"]')).toHaveAttribute('content',(await description.getAttribute('content'))!);
      await expect(staticPage.locator('meta[property="og:title"]')).toHaveAttribute('content',title);
      await expect(staticPage.locator('meta[property="og:image"]')).toHaveAttribute('content','https://kinda.dfkorealed.com/brand/kinda-mark-512.png');
      const data=JSON.parse((await staticPage.locator('script[type="application/ld+json"]').textContent())!);
      expect(data['@graph'].map((item:{'@type':string})=>item['@type'])).toEqual(['Organization','WebSite','WebPage']);
      expect(data['@graph'][2]).toMatchObject({url:canonical,name:title});
      await expect(staticPage.getByRole('navigation').getByRole('link',{name:'주요 기능'})).toHaveAttribute('href','/features');
      expect((await staticPage.getByRole('main').innerText()).length).toBeGreaterThan(200);
      expect(await staticPage.getByRole('heading',{level:1}).evaluate(node=>{
        let opacity=1;
        for(let current:Element|null=node;current;current=current.parentElement) opacity*=Number(getComputedStyle(current).opacity);
        return opacity;
      })).toBeGreaterThan(0);
    } finally {await staticContext.close();}
    const api:string[]=[];
    page.on('request',request=>{if(/^\/api(?:\/|$)/.test(new URL(request.url()).pathname)) api.push(request.url());});
    expect((await page.goto(path))!.status()).toBe(200);
    await expect(page.getByRole('heading',{level:1})).toBeVisible();
    await expect(page).toHaveTitle(title);
    await expect(page.getByRole('main')).toHaveCount(1);
    expect((await page.reload())!.status()).toBe(200);
    await expect(page.getByRole('button',{name:'준비 중',exact:true})).toBeDisabled();
    const trigger=page.getByRole('button',{name:/도입 상담/}).first();
    await trigger.click();
    const dialog=page.getByRole('dialog',{name:'도입 상담'});
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('a[href^="tel:"]')).toHaveCount(0);
    await expect(dialog.getByRole('link',{name:'kymkjh2002@dfkorealed.com'})).toHaveAttribute('href','mailto:kymkjh2002@dfkorealed.com');
    await expect(dialog.getByRole('textbox')).toHaveCount(0);
    await expect(dialog.locator('form')).toHaveCount(0);
    await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await expect(trigger).toBeFocused();
    expect(api).toEqual([]);
    expect(errors).toEqual([]);
  });
}
test('login, all internal route families, API, archives and unknown routes are actual HTTP 404',async({page})=>{
  const robots=await page.request.get('/robots.txt');expect(robots.status()).toBe(200);expect(robots.headers()['content-type']).toContain('text/plain');expect(await robots.text()).toBe('User-agent: *\nAllow: /\nSitemap: https://kinda.dfkorealed.com/sitemap.xml\n');
  const sitemap=await page.request.get('/sitemap.xml');expect(sitemap.status()).toBe(200);expect(sitemap.headers()['content-type']).toContain('application/xml');
  expect((await sitemap.text()).match(/<loc>[^<]+<\/loc>/g)).toEqual(['<loc>https://kinda.dfkorealed.com/</loc>','<loc>https://kinda.dfkorealed.com/features</loc>','<loc>https://kinda.dfkorealed.com/pricing</loc>']);
  for(const path of ['/login','/monitoring','/control','/statistics','/statistics/reports','/settings','/settings/users','/settings/floor-plans/floor-1/edit','/operator/site-admins','/operator/security','/api','/api/auth/me','/api/landing/inquiries','/unknown','/features/','/features.html','/pricing.html','/robots.txt/','/other.xml','/other.txt','/concepts/field-day.html','/published/r1/index.html','/releases/r1/manifest.json','/assets/service/app-12345678.js']) {
    const scripts:string[]=[];const api:string[]=[];
    const listener=(request:import('@playwright/test').Request)=>{if(request.resourceType()==='script') scripts.push(request.url()); if(/^\/api(?:\/|$)/.test(new URL(request.url()).pathname)&&!request.isNavigationRequest()) api.push(request.url());};
    page.on('request',listener);
    expect((await page.goto(path))!.status()).toBe(404);
    await expect(page.getByRole('heading',{name:'페이지를 찾을 수 없습니다.'})).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content','noindex');
    expect(scripts).toEqual([]);expect(api).toEqual([]);
    page.off('request',listener);
  }
});
test('header menus navigate to the separate public feature and pricing pages',async({page})=>{
  await page.goto('/');
  await page.getByRole('banner').getByRole('link',{name:'주요 기능'}).click();
  await expect(page).toHaveURL(/\/features$/);await expect(page.getByRole('heading',{level:1})).toBeVisible();
  await page.getByRole('banner').getByRole('link',{name:'요금제'}).click();
  await expect(page).toHaveURL(/\/pricing$/);await expect(page.getByRole('heading',{level:1})).toBeVisible();
});
test('pricing consultation preserves the selected plan in the direct-contact popup',async({page})=>{
  await page.goto('/pricing');
  const pricing=page.locator('#pricing');
  await expect(pricing.getByRole('article')).toHaveCount(1);
  await expect(pricing.getByRole('article',{name:'Basic'})).toContainText('조명 1,000개 포함');
  const option=pricing.getByRole('region',{name:'옵션 상품'});
  await expect(option.getByText('100원',{exact:true})).toBeVisible();
  await expect(option.getByText('/ 월',{exact:true})).toBeVisible();
  await expect(option.getByText('필요한 만큼 조명을 추가하여 대규모 운영을 간편하게 관리하세요')).toBeVisible();
  await expect(pricing.getByText('부가세는 별도입니다.',{exact:true})).toBeVisible();
  await expect(pricing.getByText(/Plus|기본 포함 수량 1,000개 초과분|현장 1곳당 기본 구독으로 시작/)).toHaveCount(0);
  await page.getByRole('button',{name:'Basic 도입 상담'}).click();
  const dialog=page.getByRole('dialog',{name:'도입 상담'});
  await expect(dialog).toContainText('선택한 요금제: Basic');await expect(dialog.getByRole('button',{name:'상담 문의 보내기'})).toHaveCount(0);
});
