import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { getCookie,setCookie,deleteCookie } from 'hono/cookie';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { Actor,State,DashboardResponse,AgentFeature } from '../shared/types';
import type { Repository } from './repository';
import { newToken } from './auth';
import { createEmptyState } from '../domain/seed';
import { DomainError,getImpact,generatePlans,ingestEvent,decidePlan,replayQueue,resolveDocument,setLotDisposition,setTaskStatus } from '../domain/engine';
import { eventSchema, importRows } from './imports';
import { DOCUMENT_MAX_BYTES } from './documents';
import { aiConfigured, aiEnabled, summarizeIncident } from './ai';
import { appendDecision, verifyAuditChain } from '../domain/audit';
import { computeBaselineComparison } from '../domain/baseline';
import { runTriageAgent } from './agents/triage';
import { runRecoveryAdvisorAgent } from './agents/recovery';
import { runDocumentReconcilerAgent } from './agents/document';
import { handleCopilotChat } from './agents/copilot';
import { registerSimulationRoutes } from './simulation';
import { requireSimulationStarted } from '../domain/simulation';

type Env={Variables:{actor:Actor}};
const focal=(actor:Actor)=>{if(actor.orgId!=='focal') throw new DomainError('Your organization has read-only incident access.',403);};
const permit=(actor:Actor,roles:Actor['role'][])=>{focal(actor);if(!roles.includes(actor.role)) throw new DomainError('This role cannot perform that action.',403);};
function redact(state:State,actor:Actor):State {
  const filteredNotifications = state.notifications.filter(n =>
    n.orgId === actor.orgId &&
    (!n.targetRoles || n.targetRoles.length === 0 || n.targetRoles.includes(actor.role))
  );
  if(actor.orgId==='focal') return { ...state, notifications: filteredNotifications };
  const visible=state.incidents.filter(i=>i.memberOrgIds.includes(actor.orgId)); const ids=new Set(visible.map(i=>i.id));
  const supplierIds=new Set(state.suppliers.filter(s=>s.orgId===actor.orgId).map(s=>s.id));
  return {...state,suppliers:state.suppliers.filter(s=>supplierIds.has(s.id)),dependencies:[],warehouses:[],lots:[],
    shipments:state.shipments.filter(s=>supplierIds.has(s.supplierId)),orders:[],events:[],plans:[],decisions:[],documents:[],integrations:[],queue:[],aiReports:[],
    incidents:visible.map(i=>({...i,affectedOrderIds:[],description:'Shared incident: coordinate the tasks assigned to your organization.'})),
    tasks:state.tasks.filter(t=>ids.has(t.incidentId)&&t.orgId===actor.orgId),
    notifications:filteredNotifications,
  };
}
export function createApp(repo:Repository) {
  const app=new Hono<Env>();
  const agentBus = repo.agentBus;
  const failures=new Map<string,{attempts:number;until:number}>();

  // Wire Agent Event Listeners
  agentBus.clear();
  agentBus.subscribe('disruption:ingested', data => runTriageAgent({ ...data, repo }));
  agentBus.subscribe('plans:generated', data => runRecoveryAdvisorAgent({ ...data, repo }));
  agentBus.subscribe('document:extracted', data => runDocumentReconcilerAgent({ ...data, repo }));
  app.use('/api/documents', bodyLimit({
    maxSize: DOCUMENT_MAX_BYTES,
    onError: c => c.json({ error: 'Request exceeds 25 MB document limit.' }, 413),
  }));
  app.use('/api/*', (c, next) => {
    if (c.req.path === '/api/documents') return next();
    return bodyLimit({
      maxSize: 8 * 1024 * 1024,
      onError: c => c.json({ error: 'Request exceeds 8 MB.' }, 413),
    })(c, next);
  });
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
    return c.json(await repo.mutate(s=>{requireSimulationStarted(s);return ingestEvent(s,{...event,source:'simulated-carrier'},actor);}));
  });
  app.use('/api/*',async(c,next)=>{
    const token=getCookie(c,'diq_session');const actor=token?await repo.actorForSession(token):null;
    if(!actor) return c.json({error:'Sign in to access the workspace.'},401);
    c.set('actor',actor); await next();
  });
  app.post('/api/logout',async c=>{const token=getCookie(c,'diq_session');if(token)await repo.deleteSession(token);deleteCookie(c,'diq_session',{path:'/'});return c.json({ok:true});});
  registerSimulationRoutes(app, repo);
  app.get('/api/me',c=>c.json({actor:c.get('actor')}));
  app.get('/api/dashboard',async c=>{
    const actor=c.get('actor'); const [raw,users]=await Promise.all([repo.read(),repo.users()]);const state=redact(raw,actor);
    state.documents = state.documents.map(({ text: _, ...d }) => ({ ...d, excerpt: d.excerpt || (_ ? _.slice(0, 500) : undefined) }));
    delete state.simulationDataset;
    if (actor.orgId !== 'focal') delete state.simulation;
    return c.json({state,impacts:actor.orgId==='focal'?getImpact(raw):[],actor,users:users.filter(u=>u.orgId===actor.orgId),aiConfigured:actor.orgId==='focal'&&aiConfigured(),database:repo.mode} satisfies DashboardResponse);
  });
  app.post('/api/events', async c => {
    const actor = c.get('actor');
    permit(actor, ['analyst', 'manager', 'warehouse', 'admin']);
    const input = eventSchema.parse(await c.req.json());
    const rawEvent = await repo.mutate(s => { requireSimulationStarted(s); return ingestEvent(s, input, actor); });
    if (rawEvent.status === 'accepted') {
      const disruptionTypes = ['supplier_delay', 'supplier_commitment', 'warehouse_outage', 'shipment_eta', 'stock_count'];
      if (disruptionTypes.includes(rawEvent.type)) {
        const state = await repo.read();
        const incident =
          state.incidents.find(i => i.entityId === rawEvent.entityId && i.status !== 'resolved') ||
          state.incidents.find(i => i.entityId === rawEvent.entityId);
        agentBus.publish('disruption:ingested', { event: rawEvent, incident, state });
      }
    }
    return c.json(rawEvent);
  });
  app.post('/api/import',async c=>{
    const actor=c.get('actor');permit(actor,['analyst','manager','admin']);
    const input=z.object({format:z.enum(['csv','json']),entity:z.enum(['suppliers','dependencies','warehouses','lots','shipments','orders','events']),content:z.string().max(2*1024*1024)}).parse(await c.req.json());
    return c.json(await repo.mutate(s=>{requireSimulationStarted(s);return importRows(s,actor,input.entity,input.format,input.content);}));
  });
  app.post('/api/plans/generate', async c => {
    const actor = c.get('actor');
    permit(actor, ['analyst', 'manager', 'procurement', 'admin']);
    const { incidentId } = z.object({ incidentId: z.string().min(1) }).parse(await c.req.json());
    const plans = await repo.mutate(s => generatePlans(s, incidentId, actor));
    const state = await repo.read();
    agentBus.publish('plans:generated', { incidentId, plans, state });
    return c.json({ plans });
  });
  app.post('/api/plans/:id',async c=>{
    const actor=c.get('actor');focal(actor);
    const action=z.object({action:z.enum(['approve','reject','modify']),confirmed:z.boolean().optional(),quantity:z.number().int().positive().optional(),breakGlass:z.boolean().optional(),breakGlassReason:z.string().optional()}).parse(await c.req.json());
    const result=await repo.mutate(s=>{
      try{return {plan:decidePlan(s,c.req.param('id'),action,actor)};}
      catch(error){
        if(error instanceof DomainError && error.status===403) {
          appendDecision(s, {
            id: `decision-${s.version}-${s.decisions.length + 1}-${s.events.length + 1}`,
            at: s.clock,
            actorId: actor.id,
            action: 'permission_denied',
            entityId: c.req.param('id'),
            detail: `Permission denied (403): ${error.message}`,
            evidenceIds: [c.req.param('id')],
            ruleVersion: 'rbac-v1',
          });
          return {denied:true,error:error.message};
        }
        // Only a failed constraint revalidation intentionally commits its stale
        // proposal and audit evidence. Other failures roll back the transaction.
        if(error instanceof DomainError && error.status===409 && s.plans.find(p=>p.id===c.req.param('id'))?.status==='stale')return {error:error.message};
        throw error;
      }
    });
    if('denied' in result) return c.json({error:result.error},403);
    return 'error' in result?c.json({error:result.error},409):c.json(result.plan);
  });
  app.post('/api/outage',async c=>{
    const actor=c.get('actor');permit(actor,['manager','admin']);
    const {enabled,integrationId}=z.object({enabled:z.boolean(),integrationId:z.string().optional()}).parse(await c.req.json());
    await repo.mutate(s=>{
      const targetId = integrationId || 'carrier';
      const conn = (s.integrations || []).find(x => x.id === targetId || x.kind === targetId);
      if (!conn) throw new DomainError(`Integration ${targetId} not found`, 404);
      conn.status = enabled ? 'offline' : 'online';
      conn.updatedAt = s.clock;
      if (enabled) conn.failureCount = (conn.failureCount || 0) + 1;
      if (conn.kind === 'carrier') s.integrationOutage = enabled;
      appendDecision(s, {
        id: crypto.randomUUID(),
        at: s.clock,
        actorId: actor.id,
        action: enabled ? 'integration_paused' : 'integration_restored',
        entityId: targetId,
        detail: enabled ? `Incoming events for ${conn?.name || targetId} are durably queued.` : `Integration ${conn?.name || targetId} restored; replay requires review.`,
        evidenceIds: [],
        ruleVersion: 'continuity-v1',
      });
    });
    return c.json({ok:true});
  });
  app.post('/api/replay',async c=>{
    const actor=c.get('actor');permit(actor,['manager','admin']);
    const body=await c.req.json().catch(()=>({}));
    const {integrationId,preview}=z.object({integrationId:z.string().optional(),preview:z.boolean().optional()}).parse(body);
    if(preview) {
      const state=await repo.read();
      return c.json(replayQueue(state,actor,{integrationId,preview:true}));
    }
    const result=await repo.mutate(s=>replayQueue(s,actor,{integrationId}));
    return c.json(result);
  });
  app.post('/api/integrations/:id/health',async c=>{
    const actor=c.get('actor');permit(actor,['manager','admin']);
    const id=c.req.param('id');
    const {status,reason}=z.object({status:z.enum(['online','degraded','offline','recovering']),reason:z.string().optional()}).parse(await c.req.json());
    await repo.mutate(s=>{
      const conn=(s.integrations||[]).find(x=>x.id===id||x.kind===id);
      if(!conn) throw new DomainError(`Integration ${id} not found`,404);
      conn.status=status; conn.reason=reason; conn.updatedAt=s.clock;
      if(status==='offline') conn.failureCount=(conn.failureCount||0)+1;
      if(conn.kind==='carrier') s.integrationOutage=status==='offline';
      appendDecision(s, {
        id: crypto.randomUUID(),
        at: s.clock,
        actorId: actor.id,
        action: `integration_health_${status}`,
        entityId: conn.id,
        detail: `${conn.name} status updated to ${status}${reason?`: ${reason}`:''}`,
        evidenceIds: [],
        ruleVersion: 'continuity-v1',
      });
    });
    return c.json({ok:true});
  });
  app.post('/api/integrations/:id/replay',async c=>{
    const actor=c.get('actor');permit(actor,['manager','admin']);
    const id=c.req.param('id');
    const body=await c.req.json().catch(()=>({}));
    const {preview}=z.object({preview:z.boolean().optional()}).parse(body);
    if(preview) {
      const state=await repo.read();
      return c.json(replayQueue(state,actor,{integrationId:id,preview:true}));
    }
    const result=await repo.mutate(s=>replayQueue(s,actor,{integrationId:id}));
    return c.json(result);
  });
  app.post('/api/documents',async c=>{
    const actor=c.get('actor');permit(actor,['analyst','manager','warehouse','procurement','admin']);
    const initialState = await repo.read();
    requireSimulationStarted(initialState);
    const expectedGeneration = initialState.workspaceGeneration ?? 1;
    let filename: string;
    let bytes: Uint8Array;
    let mimeType: string;
    let source: string;

    if(c.req.header('content-type')?.includes('multipart/form-data')) {
      const form=await c.req.formData(); const file=form.get('file');
      if(!(file instanceof File)) throw new DomainError('Choose a document file.',400);
      if(file.size > DOCUMENT_MAX_BYTES) throw new DomainError('Documents must be smaller than 25 MB.', 413);
      filename = file.name;
      bytes = new Uint8Array(await file.arrayBuffer());
      mimeType = file.type || 'application/octet-stream';
      source = 'Uploaded freight document';
    } else {
      const parsed=z.object({filename:z.string().min(1).max(200),text:z.string().max(26_214_400)}).parse(await c.req.json());
      filename = parsed.filename;
      bytes = new TextEncoder().encode(parsed.text);
      mimeType = 'text/plain';
      source = 'Provided text';
    }

    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const docId = `doc-${crypto.randomUUID()}`;
    const jobId = `job-${crypto.randomUUID()}`;

    await repo.insertDocumentRecord({
      id: docId,
      filename,
      fileSizeBytes: bytes.byteLength,
      mimeType,
      source,
      status: 'processing',
    });
    await repo.documentStorage.saveFile(docId, bytes, sha256);
    await repo.createDocumentJob(jobId, docId);

    await repo.mutate(s => {
      requireSimulationStarted(s);
      if ((s.workspaceGeneration ?? 1) !== expectedGeneration) throw new DomainError('Workspace was reset during upload. Upload the document again.', 409);
      s.documents.push({
        id: docId,
        filename,
        fileSizeBytes: bytes.byteLength,
        status: 'processing',
        confidence: 0,
        issues: [],
        fields: {},
        source,
        uploadedAt: s.clock,
      });
      appendDecision(s, {
        id: crypto.randomUUID(),
        at: s.clock,
        actorId: actor.id,
        action: 'document_uploaded',
        entityId: docId,
        detail: `Uploaded freight document ${filename} (${bytes.byteLength} bytes) for asynchronous ingestion.`,
        evidenceIds: [docId],
        ruleVersion: 'doc-pipeline-v1',
      });
    });

    const sync = c.req.query('sync') === 'true' || c.req.header('x-sync') === 'true';
    if (sync) {
      await repo.processDocument(docId, jobId, expectedGeneration);
    } else {
      void repo.processDocument(docId, jobId, expectedGeneration);
    }

    c.status(202);
    return c.json({
      id: docId,
      jobId,
      filename,
      status: 'processing',
      message: 'Document accepted for asynchronous processing.',
    });
  });
  app.get('/api/documents/:id',async c=>{
    const actor=c.get('actor');permit(actor,['analyst','manager','warehouse','procurement','admin']);
    const doc = await repo.getDocument(c.req.param('id'));
    if (!doc) {
      const s = await repo.read();
      const claim = s.documents.find(d => d.id === c.req.param('id'));
      if (!claim) throw new DomainError('Document not found.', 404);
      return c.json(claim);
    }
    return c.json(doc);
  });
  app.get('/api/documents/:id/chunks',async c=>{
    const actor=c.get('actor');permit(actor,['analyst','manager','warehouse','procurement','admin']);
    const cursor = c.req.query('cursor') ? Number(c.req.query('cursor')) : undefined;
    const limit = c.req.query('limit') ? Number(c.req.query('limit')) : undefined;
    return c.json(await repo.getDocumentChunks(c.req.param('id'), { cursor, limit }));
  });
  app.post('/api/documents/:id/confirm', async c => {
    const actor = c.get('actor');
    permit(actor, ['manager', 'warehouse', 'procurement', 'admin']);
    const docId = c.req.param('id');
    const result = await repo.mutate(s => resolveDocument(s, docId, actor));
    const chunksRes = await repo.getDocumentChunks(docId, { limit: 50 });
    const state = await repo.read();
    agentBus.publish('document:extracted', {
      documentId: docId,
      chunks: chunksRes.items,
      state,
    });
    return c.json(result);
  });
  app.get('/api/agent-logs', async c => {
    const actor = c.get('actor');
    focal(actor);
    const feature = c.req.query('feature') as AgentFeature | undefined;
    const limit = c.req.query('limit') ? Number(c.req.query('limit')) : undefined;
    return c.json(await repo.getAgentLogs({ feature, limit }));
  });
  app.post('/api/lots/:id/disposition',async c=>{
    const actor=c.get('actor');permit(actor,['warehouse','admin']);
    const {status}=z.object({status:z.enum(['available','held','quarantined'])}).transform(x=>({status:x.status==='quarantined'?'held':x.status})).parse(await c.req.json());
    await repo.mutate(s=>setLotDisposition(s,c.req.param('id'),status as 'available'|'held',actor));return c.json({ok:true});
  });
  app.post('/api/tasks/:id',async c=>{
    const {status}=z.object({status:z.enum(['open','done'])}).parse(await c.req.json());
    await repo.mutate(s=>setTaskStatus(s,c.req.param('id'),status,c.get('actor')));return c.json({ok:true});
  });
  app.post('/api/ai/chat', async c => {
    const actor = c.get('actor');
    const input = z.object({
      message: z.string().min(1).max(10000),
      history: z.array(z.object({
        id: z.string(),
        role: z.enum(['user', 'assistant', 'system']),
        content: z.string(),
        timestamp: z.string(),
        actionCards: z.array(z.any()).optional(),
        simulationResult: z.any().optional(),
      })).optional(),
      currentContext: z.object({
        page: z.string().optional(),
        entityId: z.string().optional(),
      }).optional(),
    }).parse(await c.req.json());
    const reply = await handleCopilotChat(actor, input, repo);
    return c.json(reply);
  });
  app.post('/api/ai/:id',async c=>{
    if(!aiEnabled()) throw new DomainError('AI features are disabled.',404);
    const actor=c.get('actor');focal(actor);const state=await repo.read();
    let report;try{report=await summarizeIncident(state,c.req.param('id'));}catch(e){throw new DomainError(e instanceof Error?e.message:'AI provider unavailable.',502);}
    const generated=await repo.mutate(s=>{
      if(!s.incidents.some(i=>i.id===report.incidentId))throw new DomainError('Incident changed while AI was generating. Please retry.',409);
      s.aiReports.push(report);
      appendDecision(s, {
        id: crypto.randomUUID(),
        at: s.clock,
        actorId: actor.id,
        action: 'ai_summary',
        entityId: report.incidentId,
        detail: `${report.status}: ${report.model}; factual input hash ${report.inputHash}`,
        after: report,
        evidenceIds: report.evidenceIds,
        ruleVersion: 'ai-grounding-v1',
        model: report.model,
      });
      return report;
    });return c.json(generated);
  });
  app.get('/api/audit/verify', async c => {
    const actor = c.get('actor'); focal(actor);
    const state = await repo.read();
    return c.json(verifyAuditChain(state.decisions));
  });
  app.get('/api/baseline-comparison', async c => {
    const actor = c.get('actor'); focal(actor);
    const state = await repo.read();
    return c.json(computeBaselineComparison(state));
  });
  app.post('/api/reset',async c=>{
    const actor=c.get('actor');permit(actor,['admin']);if(process.env.DEMO_MODE!=='true')throw new DomainError('Reset is available only in demo mode.',403);
    await repo.mutate(s=>{
      const priorDecisions = s.decisions;
      const priorIntegrations = s.integrations;
      const priorVersion = s.version;
      const priorClock = s.clock;
      const priorSimulation = s.simulation;
      const generation = (s.workspaceGeneration ?? 1) + 1;
      Object.assign(s, createEmptyState(new Date(priorClock)));
      s.workspaceGeneration = generation;
      s.integrations = priorIntegrations;
      s.version = priorVersion;
      s.decisions = priorDecisions;
      appendDecision(s, {
        id: crypto.randomUUID(),
        at: s.clock,
        actorId: actor.id,
        action: 'demo_reset',
        entityId: 'workspace',
        detail: `Fictional scenario workspace reset by administrator. Prior version ${priorVersion} at ${priorClock}; ${priorDecisions.length} prior audit records preserved.`,
        before: { version: priorVersion, clock: priorClock, decisionCount: priorDecisions.length, simulation: priorSimulation },
        after: { version: s.version, clock: s.clock },
        evidenceIds: [],
        ruleVersion: 'demo-v1',
      });
    });
    return c.json({ok:true});
  });
  return app;
}
