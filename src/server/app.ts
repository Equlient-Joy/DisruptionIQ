import { Hono } from 'hono';
import { getCookie,setCookie,deleteCookie } from 'hono/cookie';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { Actor,State,DashboardResponse } from '../shared/types';
import type { Repository } from './repository';
import { newToken } from './auth';
import { createSeedState } from '../domain/seed';
import { DomainError,getImpact,generatePlans,ingestEvent,decidePlan,runScenario,replayQueue,inspectDocument,resolveDocument,setLotDisposition,setTaskStatus } from '../domain/engine';
import { eventSchema, importRows } from './imports';
import { extractDocument } from './documents';
import { aiConfigured,summarizeIncident } from './ai';

type Env={Variables:{actor:Actor}};
const focal=(actor:Actor)=>{if(actor.orgId!=='focal') throw new DomainError('Your organization has read-only incident access.',403);};
const permit=(actor:Actor,roles:Actor['role'][])=>{focal(actor);if(!roles.includes(actor.role)) throw new DomainError('This role cannot perform that action.',403);};
function redact(state:State,actor:Actor):State {
  if(actor.orgId==='focal') return state;
  const visible=state.incidents.filter(i=>i.memberOrgIds.includes(actor.orgId)); const ids=new Set(visible.map(i=>i.id));
  const supplierIds=new Set(state.suppliers.filter(s=>s.orgId===actor.orgId).map(s=>s.id));
  return {...state,suppliers:state.suppliers.filter(s=>supplierIds.has(s.id)),dependencies:[],warehouses:[],lots:[],
    shipments:state.shipments.filter(s=>supplierIds.has(s.supplierId)),orders:[],events:[],plans:[],decisions:[],documents:[],readings:[],queue:[],aiReports:[],
    incidents:visible.map(i=>({...i,affectedOrderIds:[],description:'Shared incident: coordinate the tasks assigned to your organization.'})),
    tasks:state.tasks.filter(t=>ids.has(t.incidentId)&&t.orgId===actor.orgId),
    notifications:state.notifications.filter(n=>n.orgId===actor.orgId),
  };
}
export function createApp(repo:Repository) {
  const app=new Hono<Env>();
  const failures=new Map<string,{attempts:number;until:number}>();
  app.use('/api/*',bodyLimit({maxSize:8*1024*1024,onError:c=>c.json({error:'Request exceeds 8 MB.'},413)}));
  app.use('/api/*',async(c,next)=>{
    c.header('X-Content-Type-Options','nosniff'); c.header('Cache-Control','no-store');
    const origin=c.req.header('origin');
    if(origin && c.req.method!=='GET' && c.req.path!=='/api/webhooks/carrier') {
      const url=new URL(c.req.url); const allowed=process.env.APP_ORIGIN||url.origin;
      const local=process.env.DEMO_MODE==='true' && /^http:\/\/(localhost|127\.0\.0\.1):(3000|5173)$/.test(origin);
      if(origin!==allowed && !local) return c.json({error:'Cross-origin state changes are not allowed.'},403);
    }
    await next();
  });
  app.onError((error,c)=>{
    if(error instanceof DomainError) return c.json({error:error.message},error.status as 400);
    if(error instanceof z.ZodError) return c.json({error:error.issues.map(i=>`${i.path.join('.')}: ${i.message}`).join('; ')},400);
    if(error instanceof SyntaxError) return c.json({error:'Invalid JSON or CSV field encoding.'},400);
    console.error('Request failed:',error.message);
    return c.json({error:'The request could not be completed. Operational state was not committed.'},500);
  });
  app.get('/api/health',c=>c.json({status:'ok',database:repo.mode}));
  app.get('/api/demo-users',async c=>{
    if(process.env.DEMO_MODE!=='true') return c.json({error:'Demo login is disabled.'},404);
    return c.json({users:await repo.users(),demoPassword:process.env.DEMO_PASSWORD||'disruption-demo'});
  });
  app.post('/api/login',async c=>{
    const input=z.object({email:z.string().email().max(200),password:z.string().min(1).max(256)}).parse(await c.req.json());
    const key=input.email.toLowerCase(); const now=Date.now();
    for(const [k,v] of failures) if(v.until<now) failures.delete(k);
    const attempts=failures.get(key);
    if(attempts&&attempts.until>now&&attempts.attempts>=10) return c.json({error:'Too many attempts. Try again in five minutes.'},429);
    const actor=await repo.authenticate(input.email,input.password);
    if(!actor) {if(failures.size>10000) failures.clear();failures.set(key,{attempts:(attempts?.attempts||0)+1,until:now+300000});return c.json({error:'Email or password is incorrect.'},401);}
    failures.delete(key); const token=newToken(); await repo.createSession(token,actor.id);
    setCookie(c,'diq_session',token,{httpOnly:true,sameSite:'Strict',secure:new URL(c.req.url).protocol==='https:',path:'/',maxAge:8*3600});
    return c.json({actor});
  });
  app.post('/api/webhooks/carrier',async c=>{
    const secret=process.env.WEBHOOK_SECRET||(process.env.DEMO_MODE==='true'?'local-carrier-demo':undefined);
    if(!secret) return c.json({error:'Carrier webhook is not configured.'},503);
    if(c.req.header('x-webhook-secret')!==secret) return c.json({error:'Carrier webhook secret required.'},401);
    const event=eventSchema.parse(await c.req.json());
    const actor:Actor={id:'carrier-webhook',name:'Simulated carrier',email:'carrier@local',role:'analyst',orgId:'focal'};
    return c.json(await repo.mutate(s=>ingestEvent(s,{...event,source:'simulated-carrier'},actor)));
  });
  app.use('/api/*',async(c,next)=>{
    const token=getCookie(c,'diq_session');const actor=token?await repo.actorForSession(token):null;
    if(!actor) return c.json({error:'Sign in to access the workspace.'},401);
    c.set('actor',actor); await next();
  });
  app.post('/api/logout',async c=>{const token=getCookie(c,'diq_session');if(token)await repo.deleteSession(token);deleteCookie(c,'diq_session',{path:'/'});return c.json({ok:true});});
  app.get('/api/me',c=>c.json({actor:c.get('actor')}));
  app.get('/api/dashboard',async c=>{
    const actor=c.get('actor'); const [raw,users]=await Promise.all([repo.read(),repo.users()]);const state=redact(raw,actor);
    return c.json({state,impacts:actor.orgId==='focal'?getImpact(raw):[],actor,users:users.filter(u=>u.orgId===actor.orgId),aiConfigured:actor.orgId==='focal'&&aiConfigured(),database:repo.mode} satisfies DashboardResponse);
  });
  app.post('/api/scenarios',async c=>{
    const actor=c.get('actor');permit(actor,['analyst','manager','admin']);
    const {scenario}=z.object({scenario:z.enum(['A','B'])}).parse(await c.req.json());
    await repo.mutate(s=>runScenario(s,scenario,actor));return c.json({ok:true});
  });
  app.post('/api/events',async c=>{
    const actor=c.get('actor');permit(actor,['analyst','manager','warehouse','admin']);
    const event=eventSchema.parse(await c.req.json());return c.json(await repo.mutate(s=>ingestEvent(s,event,actor)));
  });
  app.post('/api/import',async c=>{
    const actor=c.get('actor');permit(actor,['analyst','manager','admin']);
    const input=z.object({format:z.enum(['csv','json']),entity:z.enum(['suppliers','warehouses','lots','shipments','orders','events']),content:z.string().max(2*1024*1024)}).parse(await c.req.json());
    return c.json(await repo.mutate(s=>importRows(s,actor,input.entity,input.format,input.content)));
  });
  app.post('/api/plans/generate',async c=>{
    const actor=c.get('actor');permit(actor,['analyst','manager','procurement','admin']);
    const {incidentId}=z.object({incidentId:z.string().min(1)}).parse(await c.req.json());
    return c.json({plans:await repo.mutate(s=>generatePlans(s,incidentId,actor))});
  });
  app.post('/api/plans/:id',async c=>{
    const actor=c.get('actor');focal(actor);
    const action=z.object({action:z.enum(['approve','reject','modify']),confirmed:z.boolean().optional(),quantity:z.number().int().positive().optional()}).parse(await c.req.json());
    const result=await repo.mutate(s=>{
      try{return {plan:decidePlan(s,c.req.param('id'),action,actor)};}
      catch(error){
        // Only a failed constraint revalidation intentionally commits its stale
        // proposal and audit evidence. Other failures roll back the transaction.
        if(error instanceof DomainError && error.status===409 && s.plans.find(p=>p.id===c.req.param('id'))?.status==='stale')return {error:error.message};
        throw error;
      }
    });
    return 'error' in result?c.json({error:result.error},409):c.json(result.plan);
  });
  app.post('/api/outage',async c=>{
    const actor=c.get('actor');permit(actor,['manager','admin']);
    const {enabled}=z.object({enabled:z.boolean()}).parse(await c.req.json());
    await repo.mutate(s=>{s.integrationOutage=enabled;s.decisions.push({id:crypto.randomUUID(),at:s.clock,actorId:actor.id,action:enabled?'integration_paused':'integration_restored',entityId:'integration',detail:enabled?'Incoming events are durably queued.':'Integration restored; replay requires review.',evidenceIds:[],ruleVersion:'continuity-v1'});});return c.json({ok:true});
  });
  app.post('/api/replay',async c=>{const actor=c.get('actor');permit(actor,['manager','admin']);await repo.mutate(s=>replayQueue(s,actor));return c.json({ok:true});});
  app.post('/api/documents',async c=>{
    const actor=c.get('actor');permit(actor,['analyst','manager','warehouse','procurement','admin']);
    let document:{filename:string;text:string;source:string};
    if(c.req.header('content-type')?.includes('multipart/form-data')) {
      const form=await c.req.formData(); const file=form.get('file');
      if(!(file instanceof File)) throw new DomainError('Choose a document file.',400);
      try{document=await extractDocument(file);}catch(e){throw new DomainError(e instanceof Error?e.message:'Document extraction failed.',400);}
    } else {
      const parsed=z.object({filename:z.string().min(1).max(200),text:z.string().max(1_000_000)}).parse(await c.req.json());document={...parsed,source:'Provided text'};
    }
    return c.json(await repo.mutate(s=>{const claim=inspectDocument(s,document.filename,document.text,actor);claim.source=document.source;return claim;}));
  });
  app.post('/api/documents/:id/confirm',async c=>{const actor=c.get('actor');permit(actor,['manager','warehouse','procurement','admin']);return c.json(await repo.mutate(s=>resolveDocument(s,c.req.param('id'),actor)));});
  app.post('/api/lots/:id/disposition',async c=>{
    const actor=c.get('actor');permit(actor,['warehouse','admin']);
    const {status}=z.object({status:z.enum(['available','quarantined'])}).parse(await c.req.json());
    await repo.mutate(s=>setLotDisposition(s,c.req.param('id'),status,actor));return c.json({ok:true});
  });
  app.post('/api/tasks/:id',async c=>{
    const {status}=z.object({status:z.enum(['open','done'])}).parse(await c.req.json());
    await repo.mutate(s=>setTaskStatus(s,c.req.param('id'),status,c.get('actor')));return c.json({ok:true});
  });
  app.post('/api/ai/:id',async c=>{
    const actor=c.get('actor');focal(actor);const state=await repo.read();
    let report;try{report=await summarizeIncident(state,c.req.param('id'));}catch(e){throw new DomainError(e instanceof Error?e.message:'AI provider unavailable.',502);}
    const generated=await repo.mutate(s=>{
      if(!s.incidents.some(i=>i.id===report.incidentId))throw new DomainError('Incident changed while AI was generating. Please retry.',409);
      s.aiReports.push(report);s.decisions.push({id:crypto.randomUUID(),at:s.clock,actorId:actor.id,action:'ai_summary',entityId:report.incidentId,detail:`${report.status}: ${report.model}; factual input hash ${report.inputHash}`,after:report,evidenceIds:report.evidenceIds,ruleVersion:'ai-grounding-v1',model:report.model});return report;
    });return c.json(generated);
  });
  app.post('/api/reset',async c=>{
    const actor=c.get('actor');permit(actor,['admin']);if(process.env.DEMO_MODE!=='true')throw new DomainError('Reset is available only in demo mode.',403);
    await repo.mutate(s=>{
      const priorDecisions = s.decisions;
      const priorVersion = s.version;
      const priorClock = s.clock;
      Object.assign(s, createSeedState());
      s.version = priorVersion;
      s.decisions = [
        ...priorDecisions,
        {
          id: crypto.randomUUID(),
          at: s.clock,
          actorId: actor.id,
          action: 'demo_reset',
          entityId: 'workspace',
          detail: `Fictional scenario workspace reset by administrator. Prior version ${priorVersion} at ${priorClock}; ${priorDecisions.length} prior audit records preserved.`,
          before: { version: priorVersion, clock: priorClock, decisionCount: priorDecisions.length },
          after: { version: s.version, clock: s.clock },
          evidenceIds: [],
          ruleVersion: 'demo-v1',
        },
      ];
    });
    return c.json({ok:true});
  });
  return app;
}
