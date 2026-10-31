import type { SimulationDataset, CatalogRows } from '../../src/shared/simulation';
import type { Supplier, Warehouse, Lot, Order, Shipment, EventInput } from '../../src/shared/types';

const emptyCatalog = (): CatalogRows => ({ suppliers: [], warehouses: [], dependencies: [], lots: [], shipments: [], orders: [] });

/** External fictional source for the selected judge presentation; never imported by application code. */
export function generateJudgesDemo(startDate = '2026-11-01'): SimulationDataset {
  const start = Date.parse(`${startDate}T00:00:00.000Z`);
  if (!Number.isFinite(start) || new Date(start).toISOString().slice(0, 10) !== startDate) throw new Error('Use a valid YYYY-MM-DD UTC start date.');
  const date = (day: number) => new Date(start + (day - 1) * 86400000).toISOString().slice(0, 10);
  const time = (day: number, hour: number, minute = 0) => new Date(start + ((day - 1) * 24 + hour) * 3600000 + minute * 60000).toISOString();
  const supplier = (id: string, name: string, components: string[], tier = 1, leadHours = 16): Supplier => ({ id, name, tier, facility: `${name} production facility`, components, approved: true, leadHours, minOrder: 10, capacity: 600, unitCostCents: 1200, orgId: 'partner' });
  const warehouse = (id: string, name: string, region: string): Warehouse => ({ id, name, region, capacity: 2000, status: 'online' });
  const lot = (id: string, name: string, itemId: string, warehouseId: string, quantity: number, reserved = 0): Lot => ({ id, name, itemId, warehouseId, quantity, reserved, status: 'available', version: 1 });
  const shipment = (id: string, supplierId: string, warehouseId: string, itemId: string, quantity: number, eta: string, lotId: string): Shipment => ({ id, supplierId, warehouseId, itemId, quantity, status: 'scheduled', eta, baselineEta: eta, etaHistory: [{ eta, at: time(1, 7), source: 'Synthetic supplier dispatch schedule' }], lotId });
  const order = (id: string, customer: string, itemId: string, warehouseId: string, quantity: number, deadline: string, priority: Order['priority'] = 'normal'): Order => ({ id, customer, itemId, warehouseId, quantity, fulfilled: 0, deadline, priority, penaltyCents: priority === 'critical' ? 100000 : 60000, status: 'open' });
  const event = (id: string, type: EventInput['type'], entityId: string, when: string, payload: Record<string, unknown>): EventInput => ({ id, type, entityId, time: when, source: 'Aster Electronics synthetic enterprise feed', payload });
  const catalog: CatalogRows = {
    suppliers: [
      supplier('SUP-FOUNDRY', 'NovaSilicon Foundry', ['MCU-100'], 2, 24),
      supplier('SUP-EAST', 'Helios Boards', ['MCU-100']),
      supplier('SUP-CENTRAL', 'Orion Circuit Assembly', ['MCU-100']),
      supplier('SUP-ALT', 'Summit Component Supply', ['MCU-100', 'DRIVE-400', 'SENSOR-500', 'LINK-600'], 1, 12),
      supplier('SUP-POWER', 'Pioneer Power Components', ['POWER-200']),
      supplier('SUP-CONNECTOR', 'Meridian Interconnects', ['CONN-300']),
      supplier('SUP-DRIVE', 'Vector Drive Systems', ['DRIVE-400']),
      supplier('SUP-SENSOR', 'Northline Sensor Modules', ['SENSOR-500']),
      supplier('SUP-WAFER', 'Quartz Wafer Materials', ['MCU-100'], 3),
      supplier('SUP-MINERAL', 'Silica Mineral Works', ['MCU-100'], 4),
      { ...supplier('SUP-CASCADE-RAW', 'Terra Rare Materials', ['LINK-600'], 4), commitments: [{ itemId: 'LINK-600', expectedQuantity: 240, confirmedQuantity: 240, dueAt: time(7, 10), status: 'ready', updatedAt: time(1, 7) }] },
      supplier('SUP-CASCADE-WAFER-A', 'Aurora Substrates', ['LINK-600'], 3),
      supplier('SUP-CASCADE-WAFER-B', 'Boreal Substrates', ['LINK-600'], 3),
      supplier('SUP-CASCADE-CHIP-A', 'Atlas Link Chips', ['LINK-600'], 2),
      supplier('SUP-CASCADE-CHIP-B', 'Beacon Link Chips', ['LINK-600'], 2),
      supplier('SUP-CASCADE-ASSEMBLY-A', 'Vertex Link Assembly', ['LINK-600']),
      supplier('SUP-CASCADE-ASSEMBLY-B', 'Polar Link Assembly', ['LINK-600']),
    ],
    warehouses: [warehouse('WH-EAST', 'East Distribution Hub', 'East'), warehouse('WH-CENTRAL', 'Central Distribution Hub', 'Central'), warehouse('WH-WEST', 'West Distribution Hub', 'West'), warehouse('WH-RESERVE', 'Reserve Logistics Hub', 'Reserve'), warehouse('WH-NORTH', 'North Distribution Hub', 'North')],
    dependencies: [
      { id: 'DEP-FOUNDRY-EAST', parentId: 'SUP-EAST', childId: 'SUP-FOUNDRY', itemId: 'MCU-100', confidence: .98, source: 'Synthetic verified bill-of-materials declaration', verified: true },
      { id: 'DEP-FOUNDRY-CENTRAL', parentId: 'SUP-CENTRAL', childId: 'SUP-FOUNDRY', itemId: 'MCU-100', confidence: .98, source: 'Synthetic verified bill-of-materials declaration', verified: true },
      ...[
        ['DEP-MINERAL-WAFER', 'SUP-WAFER', 'SUP-MINERAL', 'MCU-100'],
        ['DEP-WAFER-FOUNDRY', 'SUP-FOUNDRY', 'SUP-WAFER', 'MCU-100'],
        ['DEP-RAW-WAFER-A', 'SUP-CASCADE-WAFER-A', 'SUP-CASCADE-RAW', 'LINK-600'],
        ['DEP-RAW-WAFER-B', 'SUP-CASCADE-WAFER-B', 'SUP-CASCADE-RAW', 'LINK-600'],
        ['DEP-WAFER-CHIP-A', 'SUP-CASCADE-CHIP-A', 'SUP-CASCADE-WAFER-A', 'LINK-600'],
        ['DEP-WAFER-CHIP-B', 'SUP-CASCADE-CHIP-B', 'SUP-CASCADE-WAFER-B', 'LINK-600'],
        ['DEP-CHIP-ASSEMBLY-A', 'SUP-CASCADE-ASSEMBLY-A', 'SUP-CASCADE-CHIP-A', 'LINK-600'],
        ['DEP-CHIP-ASSEMBLY-B', 'SUP-CASCADE-ASSEMBLY-B', 'SUP-CASCADE-CHIP-B', 'LINK-600'],
      ].map(([id, parentId, childId, itemId]) => ({ id: id!, parentId: parentId!, childId: childId!, itemId: itemId!, confidence: .98, source: 'Synthetic verified multi-tier component dependency', verified: true })),
    ],
    lots: [
      lot('LOT-EAST-MCU', 'East controller receiving lot', 'MCU-100', 'WH-EAST', 0),
      lot('LOT-CENTRAL-MCU', 'Central controller receiving lot', 'MCU-100', 'WH-CENTRAL', 0),
      lot('LOT-RESERVE-MCU', 'Controller recovery reserve', 'MCU-100', 'WH-RESERVE', 600, 100),
      lot('LOT-SMALL-MCU', 'Small controller reserve', 'MCU-100', 'WH-WEST', 20, 5),
      lot('LOT-WEST-POWER', 'West power-module stock', 'POWER-200', 'WH-WEST', 200, 20),
      lot('LOT-RESERVE-POWER', 'Power-module recovery reserve', 'POWER-200', 'WH-RESERVE', 500, 100),
      lot('LOT-WEST-CONNECTOR', 'West connector stock and receipts', 'CONN-300', 'WH-WEST', 80),
      lot('LOT-EAST-CONNECTOR', 'East service connector stock', 'CONN-300', 'WH-EAST', 80),
      lot('LOT-RESERVE-CONNECTOR', 'Connector recovery reserve', 'CONN-300', 'WH-RESERVE', 200),
      lot('LOT-CENTRAL-DRIVE', 'Central drive receiving lot', 'DRIVE-400', 'WH-CENTRAL', 0),
      lot('LOT-RESERVE-DRIVE', 'Drive recovery reserve', 'DRIVE-400', 'WH-RESERVE', 500, 100),
      lot('LOT-SMALL-DRIVE', 'Small drive reserve', 'DRIVE-400', 'WH-EAST', 20, 5),
      lot('LOT-AI-SENSOR', 'North sensor stock for AI analysis', 'SENSOR-500', 'WH-NORTH', 180),
      lot('LOT-RESERVE-SENSOR', 'Sensor recovery reserve', 'SENSOR-500', 'WH-RESERVE', 400, 100),
      lot('LOT-CASCADE-EAST', 'East link-module receiving lot', 'LINK-600', 'WH-EAST', 0),
      lot('LOT-CASCADE-NORTH', 'North link-module receiving lot', 'LINK-600', 'WH-NORTH', 0),
      lot('LOT-RESERVE-LINK', 'Independent link-module reserve', 'LINK-600', 'WH-RESERVE', 500, 100),
    ],
    shipments: [
      shipment('SHP-MCU-EAST', 'SUP-EAST', 'WH-EAST', 'MCU-100', 60, time(3, 8), 'LOT-EAST-MCU'),
      shipment('SHP-MCU-CENTRAL', 'SUP-CENTRAL', 'WH-CENTRAL', 'MCU-100', 40, time(3, 12), 'LOT-CENTRAL-MCU'),
      shipment('SHP-POWER-WEST', 'SUP-POWER', 'WH-WEST', 'POWER-200', 150, time(4, 10), 'LOT-WEST-POWER'),
      shipment('SHP-CONNECTOR-WEST', 'SUP-CONNECTOR', 'WH-WEST', 'CONN-300', 60, time(3, 9), 'LOT-WEST-CONNECTOR'),
      shipment('SHP-DRIVE-CENTRAL', 'SUP-DRIVE', 'WH-CENTRAL', 'DRIVE-400', 80, time(4, 8), 'LOT-CENTRAL-DRIVE'),
      shipment('SHP-CASCADE-EAST', 'SUP-CASCADE-ASSEMBLY-A', 'WH-EAST', 'LINK-600', 90, time(7, 12), 'LOT-CASCADE-EAST'),
      shipment('SHP-CASCADE-NORTH', 'SUP-CASCADE-ASSEMBLY-B', 'WH-NORTH', 'LINK-600', 150, time(7, 14), 'LOT-CASCADE-NORTH'),
    ],
    orders: [
      order('ORD-HEALTH-MCU', 'Civic Health Devices', 'MCU-100', 'WH-EAST', 60, time(6, 12), 'critical'),
      order('ORD-AUTOMATION-MCU', 'Apex Automation', 'MCU-100', 'WH-CENTRAL', 40, time(6, 18), 'high'),
      order('ORD-TRANSIT-POWER', 'Meridian Transit Systems', 'POWER-200', 'WH-WEST', 100, time(5, 12), 'high'),
      order('ORD-WEST-CONNECTOR', 'West Field Service', 'CONN-300', 'WH-WEST', 40, time(5, 18)),
      order('ORD-EAST-CONNECTOR', 'East Service Partners', 'CONN-300', 'WH-EAST', 30, time(5, 18)),
      order('ORD-DRIVE-RECOVERY', 'Metro Robotics', 'DRIVE-400', 'WH-CENTRAL', 80, time(6, 18), 'high'),
      order('ORD-AI-SENSOR', 'Northline Instruments', 'SENSOR-500', 'WH-NORTH', 120, time(8, 12)),
      order('ORD-CASCADE-EAST', 'Vertex Fleet Systems', 'LINK-600', 'WH-EAST', 90, time(8, 12), 'high'),
      order('ORD-CASCADE-NORTH', 'Polar Logistics Devices', 'LINK-600', 'WH-NORTH', 150, time(8, 18), 'critical'),
    ],
  };
  return { schemaVersion: 1, datasetId: 'aster-judges-six-days-v3', name: 'Aster Electronics - six presentation days with multi-tier cascade', seed: 'selected-features-2026', startDate, generatorVersion: 'judges-six-days-v3', days: [
    { index: 0, date: date(1), label: 'Feature 18: audit history; healthy enterprise setup and ordinary transactions', catalog, documents: [], events: [
      event('EV-D1-MCU-EAST-DISPATCH', 'shipment_status', 'SHP-MCU-EAST', time(1, 8), { status: 'in_transit' }),
      event('EV-D1-MCU-CENTRAL-DISPATCH', 'shipment_status', 'SHP-MCU-CENTRAL', time(1, 8, 15), { status: 'in_transit' }),
      event('EV-D1-POWER-DISPATCH', 'shipment_status', 'SHP-POWER-WEST', time(1, 8, 30), { status: 'in_transit' }),
      event('EV-D1-DRIVE-DISPATCH', 'shipment_status', 'SHP-DRIVE-CENTRAL', time(1, 8, 45), { status: 'in_transit' }),
      event('EV-D1-CONNECTOR-RECEIPT', 'shipment_status', 'SHP-CONNECTOR-WEST', time(1, 11), { status: 'delivered', quantity: 20 }),
    ] },
    { index: 1, date: date(2), label: 'Feature 4: one upstream supplier-delay incident and downstream propagation', catalog: emptyCatalog(), documents: [], events: [
      event('EV-D2-CONNECTOR-RECEIPT', 'shipment_status', 'SHP-CONNECTOR-WEST', time(2, 9), { status: 'delivered', quantity: 40 }),
      event('EV-D2-FOUNDRY-DELAY', 'supplier_delay', 'SUP-FOUNDRY', time(2, 10), { delayHours: 96 }),
    ] },
    { index: 2, date: date(3), label: 'Feature 6: one warehouse-outage incident and explicit service restoration', catalog: emptyCatalog(), documents: [], events: [
      event('EV-D3-CONNECTOR-RECEIPT', 'shipment_status', 'SHP-CONNECTOR-WEST', time(3, 9), { status: 'delivered', quantity: 60 }),
      event('EV-D3-WEST-OUTAGE', 'warehouse_outage', 'WH-WEST', time(3, 10), { status: 'outage' }),
    ] },
    { index: 3, date: date(4), label: 'Feature 13: one late-shipment incident for dedicated recovery comparison and execution', catalog: emptyCatalog(), documents: [], events: [
      event('EV-D4-DRIVE-DELAY', 'shipment_eta', 'SHP-DRIVE-CENTRAL', time(4, 10), { eta: time(7, 8) }),
    ] },
    { index: 4, date: date(5), label: 'Feature 17: one sensor-stock shortage for conversational AI and hypothetical analysis', catalog: emptyCatalog(), documents: [], events: [
      event('EV-D5-SENSOR-COUNT', 'stock_count', 'LOT-AI-SENSOR', time(5, 10), { quantity: 40, meaning: 'on_hand' }),
    ] },
    { index: 5, date: date(6), label: 'One tier-4 broken supply commitment cascading through tier 3, tier 2, tier 1 and two customer orders', catalog: emptyCatalog(), documents: [], events: [
      event('EV-D6-CASCADE-COMMITMENT', 'supplier_commitment', 'SUP-CASCADE-RAW', time(6, 10), { itemId: 'LINK-600', expectedQuantity: 240, confirmedQuantity: 0, dueAt: time(7, 10), status: 'broken' }),
    ] },
  ] };
}

export function warehouseRestoreEvent(dataset: SimulationDataset): EventInput {
  return { id: 'EV-PRESENTER-WEST-RESTORED', source: 'Presenter-confirmed synthetic warehouse restoration', type: 'warehouse_outage', entityId: 'WH-WEST', time: `${dataset.days[2]!.date}T18:00:00.000Z`, payload: { status: 'online' } };
}

export function judgesPresenterGuide(dataset: SimulationDataset): string {
  const [day1, day2, day3] = dataset.days;
  return `# Aster Electronics: selected-feature demonstration\n\nThis is an explicit fictional source, loaded only by the presenter. It contains three UTC days and five customer orders. All required catalogs arrive on day 1: 6 suppliers, their partner affiliation, 2 upstream dependencies, 4 warehouses, 9 lots and 4 shipments. Customers are recorded on orders, and partner participation uses the existing partner organization; no independent customer or partner tables are invented. Accounts, incident tasks, plans and audit records are managed by the application.\n\n## Features covered\n\nDay 1: Enterprise supply network and interactive dashboard. Day 2 and day 3: #4 upstream propagation, #6 warehouse outage, #13 recovery feasibility/execution, #17 conversational AI/what-if, and #18 history/audit export. AI and audit are available throughout; they do not require extra incident days.\n\n## Load and roles\n\nSign in as Supply Chain Manager or Administrator. In Data & Evidence, choose judges-selected-features.json, Load simulation dataset, then Start day 1. The simulation requires an empty operational workspace; this export does not clear or import anything automatically. Use Operations Analyst to generate recovery proposals and Supply Chain Manager to review them. If the application marks a chosen proposal high risk, use Administrator as the second independent reviewer; do not generate that proposal as its intended approver.\n\n## Day 1: ${day1!.date} - healthy opening\n\nFour ordinary dispatch/receipt events arrive. Expected result: zero incident records, zero exposed orders, and no shortage. The connector shipment has received 20 of 60 units; its linked lot rises from 80 to 100. Show named nodes, zoom/pan, click supplier/customer/warehouse details, and inspect the verified shared upstream relationship. Sourcing approval and operational health are different; an alternate supplier without transit evidence may correctly display Unknown.\n\nOptional AI prompt: "Show current shipments and their latest ETAs." A useful preview before advancing: "What if SHP-MCU-EAST is delayed by 48 hours?" This should expose Civic Health Devices without changing the workspace.\n\n## Day 2: ${day2!.date} - one supplier-delay incident\n\nThe connector receipt increases cumulatively to 40; only 20 additional units are added. NovaSilicon Foundry announces a 48-hour delay, affecting Helios Boards and Orion Circuit Assembly. Exactly one new incident is created: supplier_delay. Both controller orders miss their original supply window: 60 + 40 = 100 uncovered units. No separate shipment_eta events create additional late-shipment incidents.\n\n1. Show the root supplier, downstream entities and affected orders in the graph.\n2. Open the incident and ask AI for its cause, affected orders and recovery options.\n3. As Operations Analyst, generate recovery proposals. All four recovery strategies have feasible candidates; the small reserve also supplies examples blocked by insufficient unreserved stock. Summit is independent of the disrupted foundry.\n4. Recommended execution: for ORD-HEALTH-MCU choose reallocate from LOT-RESERVE-MCU, quantity 60; then for ORD-AUTOMATION-MCU choose reallocate from the same reserve, quantity 40. Review the actual risk badge and required approvals.\n5. With both full reallocations executed, the reserve falls from 600 to 500 physical units, its 100 reserved units remain, orders become fulfilled and the supplier incident resolves. No outcomes are pre-approved in the dataset.\n6. Open History: inspect proposal, approval and execution records with evidence and before/after snapshots. Export the complete operational audit as JSON or a printable HTML report.\n\n## Day 3: ${day3!.date} - one warehouse-outage incident\n\nThe connector receipt increases cumulatively to 60, adding only the final 20 units; its stock reaches 140. Then West Distribution Hub goes offline. Exactly one new incident is created: warehouse_outage. Its power-module and connector orders expose 140 units because receiving and stock access are blocked. Day 2 recoveries, physical stock changes, reservations and audit history remain intact. If day 2 was left unresolved, that prior incident remains; it is not a newly created day 3 incident.\n\n1. Show the warehouse health and its two affected customers. Generate proposals to show that destination outage blocks all recovery paths. The current engine requires an online receiving warehouse; it cannot silently reroute an order to another destination.\n2. Ask AI: "What if WH-WEST is restored online?" Its what-if should reduce outage-related shortage by 140 units without changing actual warehouse status.\n3. To resolve the actual outage, import judges-selected-features.restore-warehouse.json through Data & Evidence -> Import CSV / JSON -> Events -> JSON. This companion is one explicit presenter action, not an automatically delivered restoration. Alternatively, Capture event with type warehouse_outage, entity WH-WEST, time ${day3!.date}T18:00:00.000Z and payload {"status":"online"}.\n4. With the warehouse restored, its existing stock covers both orders and the outage incident resolves. This does not mark those customer orders fulfilled or fabricate a recovery execution; distinguish restored coverage from actual fulfillment.\n5. Show the resulting History timeline and export the complete audit. Separate AI execution logs are excluded from this export, as requested.\n\n## AI and boundaries\n\nEntity queries and what-if calculations use existing deterministic tools. Generated model summaries require a configured AI provider. Hypothetical results never authorize or execute a recovery. Recovery actions remain human-triggered and are revalidated against current resources.\n\nPause prevents further day delivery; Resume enables the controls without delivering automatically. Source rows are not reloaded or reset daily. No stock-count, document-mismatch, quality-hold or integration-outage scenarios are included in this selected presentation.\n`;
}
