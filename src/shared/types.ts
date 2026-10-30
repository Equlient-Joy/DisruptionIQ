export type Role = 'analyst' | 'manager' | 'warehouse' | 'procurement' | 'admin';
export const roleLabels: Record<Role, string> = {
  analyst: 'Operations Analyst', manager: 'Supply Chain Manager',
  warehouse: 'Warehouse Operator', procurement: 'Procurement Approver', admin: 'Administrator',
};
export interface Actor { id: string; name: string; email: string; role: Role; orgId: string }
export interface Supplier {
  id: string; name: string; tier: number; facility: string; components: string[];
  approved: boolean; leadHours: number; minOrder: number; capacity: number;
  unitCostCents: number; orgId: string;
}
export interface Dependency {
  id: string; parentId: string; childId: string; itemId: string;
  confidence: number; source: string; verified: boolean;
}
export interface Warehouse { id: string; name: string; region: string; capacity: number; status: 'online' | 'outage' }
export interface Lot {
  id: string; itemId: string; name: string; warehouseId: string; quantity: number; reserved: number;
  status: 'available' | 'quarantined' | 'disputed'; version: number;
}
export interface EtaRevision { eta: string; at: string; source: string }
export interface Shipment {
  id: string; supplierId: string; warehouseId: string; itemId: string; quantity: number;
  status: 'scheduled' | 'in_transit' | 'delayed' | 'delivered'; eta: string; baselineEta: string;
  etaHistory: EtaRevision[]; lotId?: string;
}
export interface Order {
  id: string; customer: string; itemId: string; warehouseId: string; quantity: number;
  fulfilled: number; deadline: string; priority: 'critical' | 'high' | 'normal';
  penaltyCents: number; status: 'open' | 'recovering' | 'fulfilled';
}
export type EventType = 'supplier_delay' | 'shipment_eta' | 'stock_count' | 'warehouse_outage' | 'condition_reading' | 'shipment_status';
export interface EventInput {
  id: string; source: string; type: EventType; entityId: string; time: string; payload: Record<string, unknown>;
}
export interface RawEvent extends EventInput {
  receivedAt: string; status: 'accepted' | 'duplicate' | 'invalid' | 'conflict' | 'stale' | 'queued'; message: string;
}
export interface Incident {
  id: string; type: string; entityId: string; title: string; description: string;
  status: 'active' | 'recovering' | 'resolved'; createdAt: string;
  memberOrgIds: string[]; affectedOrderIds: string[]; alertCount: number;
}
export interface Impact {
  orderId: string; incidentIds: string[]; shortage: number; score: number; factors: string[];
  paths: string[]; hoursRemaining: number;
}
export type PlanType = 'reallocate' | 'expedite' | 'alternative_supplier' | 'split_order';
export interface RecoveryPlan {
  id: string; incidentId: string; orderId: string; type: PlanType; quantity: number; sourceId: string;
  arrivesAt: string; costCents: number; feasible: boolean; reasons: string[];
  status: 'proposed' | 'approved' | 'rejected' | 'stale' | 'executed';
  createdBy: string; version: number; approver?: string; rationale: string;
  evidenceIds: string[]; inventoryVersion: number; lastModifiedBy?: string;
}
export interface Decision {
  id: string; at: string; actorId: string; action: string; entityId: string;
  detail: string; before?: unknown; after?: unknown; evidenceIds: string[];
  ruleVersion: string; model?: string;
}
export interface Task {
  id: string; incidentId: string; title: string; ownerId: string; orgId: string;
  status: 'open' | 'done'; dueAt: string;
}
export interface DocumentClaim {
  id: string; filename: string; text: string; fields: { shipmentId?: string; quantity?: number; date?: string };
  confidence: number; status: 'matched' | 'mismatch' | 'review' | 'confirmed'; issues: string[];
  source: string; confirmedBy?: string;
}
export interface Reading { id: string; lotId: string; at: string; temperature: number; threshold: number; durationMinutes: number }
export interface Notification { id: string; at: string; message: string; incidentId?: string; read: boolean; orgId: string }
export interface AiReport { id: string; at: string; incidentId: string; model: string; text: string; evidenceIds: string[]; status: 'available' | 'unavailable'; inputHash?: string }
export interface State {
  version: number; clock: string; suppliers: Supplier[]; dependencies: Dependency[];
  warehouses: Warehouse[]; lots: Lot[]; shipments: Shipment[]; orders: Order[];
  events: RawEvent[]; incidents: Incident[]; plans: RecoveryPlan[]; decisions: Decision[];
  tasks: Task[]; documents: DocumentClaim[]; readings: Reading[]; notifications: Notification[];
  queue: EventInput[]; integrationOutage: boolean; aiReports: AiReport[];
}
export interface DashboardResponse { state: State; impacts: Impact[]; actor: Actor; users: Actor[]; aiConfigured: boolean; database: string }
export interface PlanAction { action: 'approve' | 'reject' | 'modify'; confirmed?: boolean; quantity?: number }
