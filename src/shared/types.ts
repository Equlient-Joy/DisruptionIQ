export type Role = 'analyst' | 'manager' | 'warehouse' | 'procurement' | 'admin' | 'viewer';
export const roleLabels: Record<Role, string> = {
  analyst: 'Operations Analyst',
  manager: 'Supply Chain Manager',
  warehouse: 'Warehouse Operator',
  procurement: 'Procurement Approver',
  admin: 'Administrator',
  viewer: 'Partner Viewer',
};

export interface Actor {
  id: string;
  name: string;
  email: string;
  role: Role;
  orgId: string;
}

export interface Supplier {
  id: string;
  name: string;
  tier: number;
  facility: string;
  components: string[];
  approved: boolean;
  leadHours: number;
  minOrder: number;
  capacity: number;
  unitCostCents: number;
  orgId: string;
}

export interface Dependency {
  id: string;
  parentId: string;
  childId: string;
  itemId: string;
  confidence: number;
  source: string;
  verified: boolean;
}

export interface Warehouse {
  id: string;
  name: string;
  region: string;
  capacity: number;
  status: 'online' | 'outage';
}

export type LotStatus = 'available' | 'held' | 'disputed';

export interface Lot {
  id: string;
  itemId: string;
  name: string;
  warehouseId: string;
  quantity: number;
  reserved: number;
  status: LotStatus;
  version: number;
}

export interface EtaRevision {
  eta: string;
  at: string;
  source: string;
}

export interface Shipment {
  id: string;
  supplierId: string;
  warehouseId: string;
  itemId: string;
  quantity: number;
  status: 'scheduled' | 'in_transit' | 'delayed' | 'delivered';
  eta: string;
  baselineEta: string;
  etaHistory: EtaRevision[];
  lotId?: string;
}

export interface Order {
  id: string;
  customer: string;
  itemId: string;
  warehouseId: string;
  quantity: number;
  fulfilled: number;
  deadline: string;
  priority: 'critical' | 'high' | 'normal';
  penaltyCents: number;
  status: 'open' | 'recovering' | 'fulfilled';
}

export type EventType = 'supplier_delay' | 'shipment_eta' | 'stock_count' | 'warehouse_outage' | 'shipment_status';

export interface EventInput {
  id: string;
  source: string;
  type: EventType | (string & {});
  entityId: string;
  time: string;
  payload: Record<string, unknown>;
  integrationId?: string;
  correlationId?: string;
}

export interface RawEvent extends EventInput {
  receivedAt: string;
  status: 'accepted' | 'duplicate' | 'invalid' | 'conflict' | 'stale' | 'queued';
  message: string;
}

export interface Incident {
  id: string;
  type: string;
  entityId: string;
  title: string;
  description: string;
  status: 'active' | 'recovering' | 'resolved';
  createdAt: string;
  memberOrgIds: string[];
  affectedOrderIds: string[];
  alertCount: number;
}

export type RiskBand = 'low' | 'moderate' | 'high' | 'critical';
export type EvidenceConfidence = 'high' | 'medium' | 'low';

export interface FactorScore {
  name: string;
  score: number;
  maxScore: number;
  thresholdCrossed: boolean;
  detail: string;
}

export interface FactorScoreBreakdown {
  uncoveredDemand: FactorScore;
  deadlinePressure: FactorScore;
  recoveryFeasibility: FactorScore;
  cascadingExposure: FactorScore;
  businessConsequence: FactorScore;
}

export interface Impact {
  orderId: string;
  incidentIds: string[];
  shortage: number;
  score: number; // 0.0 to 10.0, one decimal
  band?: RiskBand;
  drivers?: string[]; // at most two displayed drivers
  factorScores?: FactorScoreBreakdown;
  confidence?: EvidenceConfidence;
  confidenceReasons?: string[];
  paths: string[];
  hoursRemaining: number;
  factors: string[]; // required for backward compatibility
}

export type PlanType = 'reallocate' | 'expedite' | 'alternative_supplier' | 'split_order';
export type PlanStatus = 'proposed' | 'awaiting_second_approval' | 'approved' | 'rejected' | 'stale' | 'executed';
export type PlanRisk = 'high' | 'routine';

export interface PlanApproval {
  approverId: string;
  role: Role;
  at: string;
  version: number;
}

export interface BreakGlassRecord {
  actorId: string;
  at: string;
  reason: string;
  reviewStatus: 'required' | 'completed';
  reviewedBy?: string;
  reviewedAt?: string;
}

export interface RecoveryPlan {
  id: string;
  incidentId: string;
  orderId: string;
  type: PlanType;
  quantity: number;
  sourceId: string;
  arrivesAt: string;
  costCents: number;
  feasible: boolean;
  reasons: string[];
  status: PlanStatus;
  createdBy: string;
  version: number;
  approver?: string;
  approvals?: PlanApproval[];
  riskLevel?: PlanRisk;
  breakGlass?: BreakGlassRecord;
  rationale: string;
  evidenceIds: string[];
  inventoryVersion: number;
  lastModifiedBy?: string;
}

export interface RecoveryCandidate {
  type: PlanType;
  sourceId: string;
  quantity: number;
}

export interface RecoveryPlanner {
  readonly name: string;
  generateCandidates(state: State, incidentId: string, orderId: string, shortage?: number): RecoveryCandidate[];
}

export interface Decision {
  id: string;
  at: string;
  actorId: string;
  action: string;
  entityId: string;
  detail: string;
  before?: unknown;
  after?: unknown;
  evidenceIds: string[];
  ruleVersion: string;
  model?: string;
}

export interface Task {
  id: string;
  incidentId: string;
  title: string;
  ownerId: string;
  orgId: string;
  status: 'open' | 'done';
  dueAt: string;
}

export type DocumentStatus = 'uploading' | 'processing' | 'ready' | 'matched' | 'mismatch' | 'review' | 'confirmed' | 'failed';

export interface DocumentClaim {
  id: string;
  filename: string;
  fileSizeBytes?: number;
  pageCount?: number;
  excerpt?: string;
  text?: string; // Optional during pipeline migration
  fields: { shipmentId?: string; quantity?: number; date?: string };
  confidence: number;
  status: DocumentStatus;
  issues: string[];
  source: string;
  confirmedBy?: string;
  uploadedAt?: string;
  processedAt?: string;
  error?: string;
}

export interface Notification {
  id: string;
  at: string;
  message: string;
  incidentId?: string;
  read: boolean;
  orgId: string;
}

export interface AiReport {
  id: string;
  at: string;
  incidentId: string;
  model: string;
  text: string;
  evidenceIds: string[];
  status: 'available' | 'unavailable';
  inputHash?: string;
}

export type IntegrationKind = 'carrier' | 'warehouse' | 'supplier' | 'document' | 'ai';
export type IntegrationHealth = 'online' | 'degraded' | 'offline' | 'recovering';

export interface IntegrationConnection {
  id: string;
  kind: IntegrationKind;
  name: string;
  status: IntegrationHealth;
  reason?: string;
  updatedAt: string;
  lastSuccessAt?: string;
  failureCount: number;
  circuitOpenUntil?: string;
  backlogCount?: number;
  deadLetterCount?: number;
}

export type InboxItemStatus = 'pending' | 'processing' | 'processed' | 'failed' | 'dead_letter';

export interface IntegrationInboxItem {
  id: string;
  workspaceId: string;
  integrationId: string;
  sourceEventId: string;
  schemaVersion: number;
  sourceSequence?: number;
  correlationId?: string;
  payload: Record<string, unknown>;
  eventTime: string;
  receivedAt: string;
  status: InboxItemStatus;
  attemptCount: number;
  nextAttemptAt?: string;
  lastError?: string;
  replayLineage?: string[];
}

export interface State {
  version: number;
  clock: string;
  suppliers: Supplier[];
  dependencies: Dependency[];
  warehouses: Warehouse[];
  lots: Lot[];
  shipments: Shipment[];
  orders: Order[];
  events: RawEvent[];
  incidents: Incident[];
  plans: RecoveryPlan[];
  decisions: Decision[];
  tasks: Task[];
  documents: DocumentClaim[];
  notifications: Notification[];
  integrations: IntegrationConnection[];
  aiReports: AiReport[];
  queue: EventInput[];
  integrationOutage?: boolean;
}

export interface DashboardResponse {
  state: State;
  impacts: Impact[];
  actor: Actor;
  users: Actor[];
  aiConfigured: boolean;
  database: string;
}

export interface PlanAction {
  action: 'approve' | 'reject' | 'modify';
  confirmed?: boolean;
  quantity?: number;
  breakGlass?: boolean;
  breakGlassReason?: string;
}

export type AgentType = 'triage' | 'advisor' | 'reconciler' | 'copilot';
export type AgentFeature = 'incidents' | 'plans' | 'documents' | 'chat';

export interface AgentExecutionLog {
  id: string;
  timestamp: string;
  agent: AgentType;
  feature: AgentFeature;
  action: string;
  accessedEntities: string[];
  actorId?: string;
  summary: string;
  status: 'success' | 'fallback' | 'error';
  latencyMs: number;
  model: string;
}

export interface ActionCard {
  id: string;
  cardType: 'plan_action_prompt' | 'lot_hold_prompt' | 'filter_prompt';
  title: string;
  detail: string;
  risk?: 'routine' | 'high';
  cost?: number;
  planId?: string;
  incidentId?: string;
  lotId?: string;
  targetStatus?: string;
  buttonLabel: string;
}

export interface SimulationDiff {
  entityType: 'shipment' | 'supplier' | 'warehouse' | 'lot';
  entityId: string;
  scenarioDescription: string;
  baselineExposedOrders: number;
  simulatedExposedOrders: number;
  deltaExposedOrders: number;
  baselineTotalShortage: number;
  simulatedTotalShortage: number;
  deltaShortage: number;
  newlyBreachedOrders: { orderId: string; customer: string; hoursToDeadline: number }[];
  feasibleRecoveryCount: number;
  recommendedPlanType?: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  actionCards?: ActionCard[];
  simulationResult?: SimulationDiff;
}
