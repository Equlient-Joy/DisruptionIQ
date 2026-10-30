import type {
  IntegrationConnection,
  Lot,
  RecoveryPlan,
  State,
} from '../shared/types';

export function defaultIntegrations(now = new Date().toISOString(), legacyOutage = false): IntegrationConnection[] {
  return [
    {
      id: 'carrier-api',
      kind: 'carrier',
      name: 'Carrier Logistics API',
      status: legacyOutage ? 'offline' : 'online',
      reason: legacyOutage ? 'Carrier integration offline' : undefined,
      updatedAt: now,
      failureCount: 0,
    },
    {
      id: 'warehouse-wms',
      kind: 'warehouse',
      name: 'Warehouse WMS Interface',
      status: 'online',
      updatedAt: now,
      failureCount: 0,
    },
    {
      id: 'supplier-edi',
      kind: 'supplier',
      name: 'Supplier EDI Gateway',
      status: 'online',
      updatedAt: now,
      failureCount: 0,
    },
    {
      id: 'document-processor',
      kind: 'document',
      name: 'Freight Document Processor',
      status: 'online',
      updatedAt: now,
      failureCount: 0,
    },
    {
      id: 'ai-service',
      kind: 'ai',
      name: 'AI Advisory Service',
      status: 'online',
      updatedAt: now,
      failureCount: 0,
    },
  ];
}

export function normalizeState(raw: unknown): State {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Workspace state must be a non-null object.');
  }
  const s = raw as Record<string, unknown>;

  const version = typeof s.version === 'number' && Number.isFinite(s.version) ? s.version : 1;
  const clock = typeof s.clock === 'string' && !Number.isNaN(Date.parse(s.clock))
    ? s.clock
    : new Date().toISOString();

  // Suppliers
  const suppliers = Array.isArray(s.suppliers) ? s.suppliers.map(sup => ({ ...sup })) : [];

  // Dependencies
  const dependencies = Array.isArray(s.dependencies) ? s.dependencies.map(dep => ({ ...dep })) : [];

  // Warehouses
  const warehouses = Array.isArray(s.warehouses) ? s.warehouses.map(w => ({ ...w })) : [];

  // Lots: map 'quarantined' to 'held'
  const lots: Lot[] = Array.isArray(s.lots)
    ? s.lots.map(l => {
        const rawStatus = (l as { status?: string }).status;
        const status = rawStatus === 'quarantined' ? 'held' : rawStatus;
        const validStatus: Lot['status'] =
          status === 'available' || status === 'held' || status === 'disputed'
            ? status
            : 'held';

        return {
          ...l,
          quantity: typeof l.quantity === 'number' && Number.isFinite(l.quantity) ? l.quantity : 0,
          reserved: typeof l.reserved === 'number' && Number.isFinite(l.reserved) ? l.reserved : 0,
          status: validStatus,
          version: typeof l.version === 'number' && Number.isFinite(l.version) ? l.version : 1,
        };
      })
    : [];

  // Shipments
  const shipments = Array.isArray(s.shipments) ? s.shipments.map(sh => ({ ...sh })) : [];

  // Orders
  const orders = Array.isArray(s.orders) ? s.orders.map(o => ({ ...o })) : [];

  // Events: remove active cold-chain events
  const events = Array.isArray(s.events)
    ? s.events
        .filter(e => e && (e as { type?: string }).type !== 'condition_reading')
        .map(e => ({ ...e }))
    : [];

  // Incidents: remove condition_excursion incidents
  const incidents = Array.isArray(s.incidents)
    ? s.incidents
        .filter(i => i && (i as { type?: string }).type !== 'condition_excursion')
        .map(i => ({ ...i }))
    : [];

  const activeIncidentIds = new Set(incidents.map(i => i.id));

  // Plans: remove plans referencing dropped incidents, normalize riskLevel, approvals
  const plans: RecoveryPlan[] = Array.isArray(s.plans)
    ? s.plans
        .filter(p => p && (!p.incidentId || activeIncidentIds.has(p.incidentId)))
        .map(p => {
          const planRisk = p.riskLevel === 'high' || p.riskLevel === 'routine' ? p.riskLevel : 'routine';
          const approvals = Array.isArray(p.approvals) ? [...p.approvals] : [];

          // If plan has legacy approver but empty approvals array, synthesize an approval record
          if (p.approver && !approvals.length) {
            approvals.push({
              approverId: p.approver,
              role: 'manager',
              at: clock,
              version: typeof p.version === 'number' ? p.version : 1,
            });
          }

          // If plan version doesn't match approval version, invalidate prior approvals
          const validApprovals = approvals.filter(a => a.version === p.version);

          return {
            ...p,
            status: p.status || 'proposed',
            approvals: validApprovals,
            riskLevel: planRisk,
            reasons: Array.isArray(p.reasons) ? [...p.reasons] : [],
            evidenceIds: Array.isArray(p.evidenceIds) ? [...p.evidenceIds] : [],
          };
        })
    : [];

  // Decisions: preserve ALL historical decisions (including condition/quality decisions)
  const decisions = Array.isArray(s.decisions) ? s.decisions.map(d => ({ ...d })) : [];

  // Tasks: filter tasks referencing dropped incidents
  const tasks = Array.isArray(s.tasks)
    ? s.tasks
        .filter(t => t && (!t.incidentId || activeIncidentIds.has(t.incidentId)))
        .map(t => ({ ...t }))
    : [];

  // Documents: normalize excerpt and status
  const documents = Array.isArray(s.documents)
    ? s.documents.map(d => {
        const text = typeof d.text === 'string' ? d.text : undefined;
        const excerpt = typeof d.excerpt === 'string'
          ? d.excerpt
          : text ? text.slice(0, 300) : undefined;

        return {
          ...d,
          issues: Array.isArray(d.issues) ? [...d.issues] : [],
          fields: d.fields && typeof d.fields === 'object' ? { ...d.fields } : {},
          confidence: typeof d.confidence === 'number' ? d.confidence : 0,
          status: d.status || 'ready',
          excerpt,
        };
      })
    : [];

  // Notifications
  const notifications = Array.isArray(s.notifications) ? s.notifications.map(n => ({ ...n })) : [];

  // Integrations: translate legacy global outage flag
  const legacyOutage = s.integrationOutage === true;
  let integrations: IntegrationConnection[];
  if (Array.isArray(s.integrations) && s.integrations.length > 0) {
    integrations = s.integrations.map(conn => ({ ...conn }));
  } else {
    integrations = defaultIntegrations(clock, legacyOutage);
  }

  // AI Reports
  const aiReports = Array.isArray(s.aiReports) ? s.aiReports.map(r => ({ ...r })) : [];

  // Queue (legacy / transition buffer)
  const queue = Array.isArray(s.queue) ? s.queue.map(q => ({ ...q })) : [];

  const normalized: State = {
    version,
    clock,
    suppliers,
    dependencies,
    warehouses,
    lots,
    shipments,
    orders,
    events,
    incidents,
    plans,
    decisions,
    tasks,
    documents,
    notifications,
    integrations,
    aiReports,
    queue,
  };

  return normalized;
}
