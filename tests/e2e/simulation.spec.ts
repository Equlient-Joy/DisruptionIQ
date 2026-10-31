import {test,expect,type Page} from '@playwright/test';
import {generateEnterpriseDataset} from '../../scripts/synthetic/generator';

async function login(page:Page,role='Supply Chain Manager') {
  await page.goto('/');await page.locator('.login-card, .app-shell').waitFor();
  if(await page.locator('.app-shell').isVisible()) await page.getByRole('button',{name:'Sign out',exact:true}).click();
  await page.locator('.demo-account-card').filter({hasText:role}).click();
  await expect(page.locator('.app-shell')).toBeVisible();
}
async function evidence(page:Page) {await page.getByRole('button',{name:/Data & Evidence/i}).click();}
async function load(page:Page,days=7) {
  const data=generateEnterpriseDataset({seed:'browser-judges',startDate:'2026-11-01',days});
  await page.getByLabel('Simulation dataset file').setInputFiles({name:'enterprise.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(data))});
  await expect(page.locator('.simulation-feed')).toContainText(data.name);
  await page.getByRole('button',{name:'Load simulation dataset',exact:true}).click();
  await expect(page.getByRole('button',{name:'Start day 1',exact:true})).toBeVisible();
  return data;
}
test.beforeEach(async({request})=>{
  expect((await request.post('/api/login',{data:{email:'admin@disruptioniq.demo',password:'disruption-demo'}})).ok()).toBe(true);
  expect((await request.post('/api/reset',{data:{}})).ok()).toBe(true);
});
test('simulation loads explicitly, pauses between days and survives refresh',async({page,request})=>{
  await login(page);await evidence(page);await load(page,2);
  expect((await (await request.get('/api/dashboard')).json()).state.lots).toHaveLength(0);
  await page.getByRole('button',{name:'Start day 1',exact:true}).click();
  await expect(page.locator('.simulation-feed')).toContainText('1 / 2 days delivered');
  await page.locator('.simulation-feed').getByRole('button',{name:'Pause',exact:true}).click();
  await expect(page.locator('.simulation-feed').getByRole('button',{name:'Next day',exact:true})).toBeDisabled();
  const first=(await (await request.get('/api/dashboard')).json()).state;
  await page.reload();await evidence(page);
  await expect(page.locator('.simulation-feed')).toContainText('1 / 2 days delivered');
  await page.locator('.simulation-feed').getByRole('button',{name:'Resume',exact:true}).click();
  expect((await (await request.get('/api/dashboard')).json()).state.clock).toBe(first.clock);
  await page.getByRole('button',{name:'Next day',exact:true}).click();
  await expect(page.locator('.simulation-feed')).toContainText('Simulation complete');
  await expect(page.getByRole('button',{name:'Next day',exact:true})).toHaveCount(0);
});
test('simulation reconciles a lost delivery response without injecting another day',async({page,request})=>{
  await login(page);await evidence(page);await load(page);
  await page.route('**/api/simulation/advance',async route=>{await route.fetch();await route.abort('failed');});
  await page.getByRole('button',{name:'Start day 1',exact:true}).click();
  await expect(page.locator('.simulation-feed')).toContainText('1 / 7 days delivered');
  await expect(page.locator('.simulation-feed')).toContainText('Delivery confirmed from saved receipt');
  expect((await (await request.get('/api/simulation')).json()).simulation.completedDays).toBe(1);
  await page.unroute('**/api/simulation/advance');
  await page.reload();await evidence(page);
  await expect(page.locator('.simulation-feed')).toContainText('1 / 7 days delivered');
});
test('simulation preserves human recovery across day progression and restricts control roles',async({page,request})=>{
  await login(page);await evidence(page);await load(page);
  await page.getByRole('button',{name:'Start day 1',exact:true}).click();
  await expect(page.locator('.simulation-feed')).toContainText('1 / 7 days delivered');
  await page.getByRole('button',{name:'Next day',exact:true}).click();
  await expect(page.locator('.simulation-feed')).toContainText('2 / 7 days delivered');
  await login(page,'Operations Analyst');await evidence(page);
  await expect(page.locator('.simulation-feed').getByRole('button',{name:'Next day',exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:/Incidents & Recovery/i}).click();
  await page.getByRole('button',{name:'Generate recovery options'}).first().click();
  const card=page.locator('.plan-card').filter({has:page.getByRole('heading',{name:'Reallocate inventory'})}).first();
  await expect(card).toContainText('Passes current constraints');
  await login(page);await page.getByRole('button',{name:/Incidents & Recovery/i}).click();
  await card.getByRole('button',{name:'Record 1st approval'}).click();
  await page.locator('.modal input[type=checkbox]').check();
  await page.locator('.modal').getByRole('button',{name:'Record 1st approval'}).click();
  await expect(card).toContainText('awaiting second approval');
  await login(page,'Administrator');await page.getByRole('button',{name:/Incidents & Recovery/i}).click();
  await card.getByRole('button',{name:'Confirm 2nd approval & execute'}).click();
  await page.locator('.modal input[type=checkbox]').check();
  await page.getByRole('button',{name:'Confirm & simulate execution'}).click();
  await expect(card).toContainText('executed');
  const recovered=(await (await request.get('/api/dashboard')).json()).state;
  await evidence(page);await page.getByRole('button',{name:'Next day',exact:true}).click();
  await expect(page.locator('.simulation-feed')).toContainText('3 / 7 days delivered');
  const after=(await (await request.get('/api/dashboard')).json()).state;
  for(const lot of recovered.lots) expect(after.lots.find((candidate:{id:string})=>candidate.id===lot.id)).toEqual(lot);
  expect(after.plans).toEqual(recovered.plans);
  await expect(page.locator('.simulation-feed')).toContainText('1 confirmed recoveries');
});
