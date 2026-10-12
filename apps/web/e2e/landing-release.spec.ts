import {test,expect} from '@playwright/test';
if(process.env.WEB_DEPLOY_MODE !== 'landing') throw new Error('Landing release cannot test service mode');
for(const path of ['/','/features','/pricing']) {
  test(`public ${path}: reload, disabled login, contact fallback and focus return without API`,async({page})=>{
    const api:string[]=[];
    page.on('request',request=>{if(/^\/api(?:\/|$)/.test(new URL(request.url()).pathname)) api.push(request.url());});
    expect((await page.goto(path))!.status()).toBe(200);
    await expect(page.getByRole('heading',{level:1})).toBeVisible();
    expect((await page.reload())!.status()).toBe(200);
    await expect(page.getByRole('button',{name:'준비 중',exact:true})).toBeDisabled();
    const trigger=page.getByRole('button',{name:/도입 상담/}).first();
    await trigger.click();
    const dialog=page.getByRole('dialog',{name:'도입 상담'});
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('link',{name:'032-528-2953'})).toHaveAttribute('href','tel:0325282953');
    await expect(dialog.getByRole('link',{name:'kymkjh2002@dfkorealed.com'})).toHaveAttribute('href','mailto:kymkjh2002@dfkorealed.com');
    await expect(dialog.getByRole('textbox')).toHaveCount(0);
    await expect(dialog.locator('form')).toHaveCount(0);
    await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await expect(trigger).toBeFocused();
    expect(api).toEqual([]);
  });
}
test('login, all internal route families, API, archives and unknown routes are actual HTTP 404',async({page})=>{
  for(const path of ['/login','/monitoring','/control','/statistics','/statistics/reports','/settings','/settings/users','/settings/floor-plans/floor-1/edit','/operator/site-admins','/operator/security','/api','/api/auth/me','/api/landing/inquiries','/unknown','/features/','/concepts/field-day.html','/published/r1/index.html','/releases/r1/manifest.json','/assets/service/app-12345678.js']) {
    const scripts:string[]=[];const api:string[]=[];
    const listener=(request:import('@playwright/test').Request)=>{if(request.resourceType()==='script') scripts.push(request.url()); if(/^\/api(?:\/|$)/.test(new URL(request.url()).pathname)&&!request.isNavigationRequest()) api.push(request.url());};
    page.on('request',listener);
    expect((await page.goto(path))!.status()).toBe(404);
    await expect(page.getByRole('heading',{name:'페이지를 찾을 수 없습니다.'})).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
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
  await page.goto('/pricing');await page.getByRole('button',{name:'Plus 도입 상담'}).click();
  const dialog=page.getByRole('dialog',{name:'도입 상담'});
  await expect(dialog).toContainText('선택한 요금제: Plus');await expect(dialog.getByRole('button',{name:'상담 문의 보내기'})).toHaveCount(0);
});
