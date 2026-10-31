import type { CatalogRows, SimulationDataset, SimulationDay } from '../../src/shared/simulation';

const VERSION = 'enterprise-generator-1';
function randomFrom(seed: string): () => number {
  let value=2166136261;
  for(const char of seed) value=Math.imul(value^char.charCodeAt(0),16777619);
  return ()=>{value+=0x6D2B79F5;let n=value;n=Math.imul(n^(n>>>15),n|1);n^=n+Math.imul(n^(n>>>7),n|61);return ((n^(n>>>14))>>>0)/4294967296;};
}
const emptyCatalog=():CatalogRows=>({suppliers:[],dependencies:[],warehouses:[],lots:[],shipments:[],orders:[]});

export function generateEnterpriseDataset(options: {seed:string;startDate:string;days:number}): SimulationDataset {
  const {seed,startDate,days}=options;
  const start=Date.parse(`${startDate}T00:00:00Z`);
  if(!seed.trim() || seed.length>120 || !/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !Number.isFinite(start) || new Date(start).toISOString().slice(0,10)!==startDate || !Number.isInteger(days) || days<1 || days>30) throw new Error('Provide a seed (1–120 characters), valid UTC start date and 1–30 days.');
  const random=randomFrom(seed);
  const code=Math.floor(random()*0xffffffff).toString(16).padStart(8,'0');
  const id=(name:string)=>`${code}-${name}`;
  const time=(hours:number)=>new Date(start+hours*3600000).toISOString();
  const item=id('controller');const east=id('east');const west=id('west');const lotEast=id('lot-east');const lotWest=id('lot-west');
  const primaryA=id('supplier-a');const primaryB=id('supplier-b');const core=id('shared-upstream');const reserve=id('reserve');
  const shipmentA=id('shipment-a');const shipmentB=id('shipment-b');
  const source=`Synthetic enterprise ${code}`;
  const data:SimulationDataset={schemaVersion:1,datasetId:id('enterprise'),name:`Fictional electronics enterprise ${code}`,seed,startDate,generatorVersion:VERSION,days:[]};
  for(let index=0;index<days;index++) {
    const day:SimulationDay={index,date:time(index*24).slice(0,10),label:['Baseline operations','Shared supplier delay','Compound warehouse disruption','Evidence reconciliation','Held stock and duplicate claim','Carrier continuity exercise','Receipts and carried-over work'][index] ?? 'Daily replenishment and new demand',catalog:emptyCatalog(),events:[],documents:[]};
    const event=(name:string,type:SimulationDay['events'][number]['type'],entityId:string,hours:number,payload:Record<string,unknown>)=>({id:id(name),source,type,entityId,time:time(hours),payload,correlationId:id(`day-${index+1}`)});
    if(index===0) {
      day.catalog.suppliers=[
        {id:primaryA,name:`Fictional Circuit Assembly ${code}`,tier:1,facility:'Declared eastern assembly plant',components:[item],approved:true,leadHours:24,minOrder:20,capacity:300,unitCostCents:1200,orgId:'partner'},
        {id:primaryB,name:`Fictional Board Manufacturing ${code}`,tier:1,facility:'Declared western assembly plant',components:[item],approved:true,leadHours:30,minOrder:20,capacity:280,unitCostCents:1300,orgId:'partner'},
        {id:core,name:`Fictional Shared Semiconductor Plant ${code}`,tier:2,facility:'Declared upstream fabrication plant',components:[item],approved:false,leadHours:72,minOrder:100,capacity:600,unitCostCents:800,orgId:'partner'},
        {id:reserve,name:`Fictional Reserve Components ${code}`,tier:1,facility:'Independent reserve line',components:[item],approved:true,leadHours:10,minOrder:20,capacity:400,unitCostCents:1500,orgId:'focal'},
      ];
      day.catalog.dependencies=[{id:id('edge-a'),parentId:primaryA,childId:core,itemId:item,confidence:0.95,source:'Explicit synthetic supplier declaration',verified:true},{id:id('edge-b'),parentId:primaryB,childId:core,itemId:item,confidence:0.8,source:'Explicit synthetic declaration awaiting facility review',verified:false}];
      day.catalog.warehouses=[{id:east,name:`Fictional East Hub ${code}`,region:'East',capacity:500,status:'online'},{id:west,name:`Fictional West Hub ${code}`,region:'West',capacity:400,status:'online'}];
      day.catalog.lots=[{id:lotEast,itemId:item,name:'Declared eastern opening inventory',warehouseId:east,quantity:40,reserved:10,status:'available',version:1},{id:lotWest,itemId:item,name:'Declared western opening inventory',warehouseId:west,quantity:180,reserved:20,status:'available',version:1}];
      day.catalog.shipments=[{id:shipmentA,supplierId:primaryA,warehouseId:east,itemId:item,lotId:lotEast,quantity:120,status:'in_transit',eta:time(36),baselineEta:time(36),etaHistory:[{eta:time(36),at:time(0),source}]},{id:shipmentB,supplierId:primaryB,warehouseId:west,itemId:item,lotId:lotWest,quantity:90,status:'in_transit',eta:time(36),baselineEta:time(36),etaHistory:[{eta:time(36),at:time(0),source}]}];
      day.catalog.orders=[{id:id('critical-order'),customer:`Fictional Medical Equipment ${code}`,itemId:item,warehouseId:east,quantity:100,fulfilled:0,deadline:time(84),priority:'critical',penaltyCents:750000,status:'open'},{id:id('priority-order'),customer:`Fictional Transport Systems ${code}`,itemId:item,warehouseId:west,quantity:140,fulfilled:0,deadline:time(96),priority:'high',penaltyCents:420000,status:'open'}];
      day.events.push(event('baseline-eta','shipment_eta',shipmentA,12,{eta:time(36)}));
    } else if(index===1) {
      day.events.push(event('upstream-delay','supplier_delay',core,34,{delayHours:96}));
      day.events.push(event('revised-eta','shipment_eta',shipmentA,36,{eta:time(132)}));
    } else if(index===2) {
      day.catalog.lots.push({id:id('count-lot'),itemId:item,name:'Separate incoming batch for count review',warehouseId:west,quantity:60,reserved:0,status:'available',version:1});
      day.events.push(event('hub-outage','warehouse_outage',west,58,{status:'outage'}));
      day.events.push(event('volatile-eta','shipment_eta',shipmentB,60,{eta:time(156)}));
    } else if(index===3) {
      day.events.push(event('physical-count','stock_count',id('count-lot'),82,{quantity:55,meaning:'on_hand'}));
      day.events.push({...event('conflicting-count','stock_count',id('count-lot'),82,{quantity:50,meaning:'on_hand'}),source:`Independent synthetic count ${code}`});
      day.events.push(event('invalid-count','stock_count',lotEast,83,{quantity:-2,meaning:'on_hand'}));
      day.documents.push({id:id('manifest-claim'),filename:`freight-${code}.txt`,text:`Shipment: ${shipmentA}\nQuantity: 127\nDate: ${day.date}\nSource: explicit synthetic manifest`});
    } else if(index===4) {
      day.catalog.lots.push({id:id('held-lot'),itemId:item,name:'Inbound batch declared held for review',warehouseId:east,quantity:25,reserved:0,status:'held',version:1});
      day.events.push({...data.days[1]!.events[0]!});
    } else if(index===5) {
      day.events.push(event('current-carrier','shipment_eta',shipmentA,130,{eta:time(180)}));
      day.events.push(event('older-carrier','shipment_eta',shipmentA,40,{eta:time(144)}));
    } else if(index===6) {
      day.events.push(event('carrier-receipt','shipment_status',shipmentA,154,{status:'delivered',quantity:120}));
      day.catalog.orders.push({id:id('new-demand'),customer:`Fictional Service Parts ${code}`,itemId:item,warehouseId:east,quantity:40+Math.floor(random()*20),fulfilled:0,deadline:time(216),priority:'normal',penaltyCents:10000,status:'open'});
    } else {
      day.catalog.orders.push({id:id(`order-${index}`),customer:`Fictional Daily Customer ${index+1}`,itemId:item,warehouseId:east,quantity:20+Math.floor(random()*20),fulfilled:0,deadline:time(index*24+72),priority:'normal',penaltyCents:10000,status:'open'});
    }
    data.days.push(day);
  }
  return data;
}
export function renderPresenterGuide(dataset:SimulationDataset):string {
  return `# ${dataset.name}\n\nExplicit fictional source. Seed: ${dataset.seed}; generator: ${dataset.generatorVersion}; UTC start: ${dataset.startDate}.\n\nLoad this JSON from Data & Evidence, then choose Start day 1. Resolve/review work using ordinary role permissions before choosing Next day. Pause blocks further days; Resume does not deliver.\n\n${dataset.days.map(day=>`- Day ${day.index+1} (${day.date}): ${day.label}. ${day.events.length} source events, ${day.documents.length} text claims.`).join('\n')}\n\nDay 2 supplies a shared upstream delay; inspect downstream risks and generate the four recovery choices. Approve with independent roles where required, or modify/reject a proposal. Day 3 supplies a warehouse outage; existing recoveries and reservations persist. Day 4 supplies conflicting and invalid counts and a quantity mismatch. Day 5 imports a held batch; authorized disposition requires human review. Before day 6, optionally use the separate carrier integration outage control, deliver its day, then restore and preview/replay the queue. Day 7 delivers receipt evidence; actual outcomes depend on human decisions and integration health.\n\nNo recoveries are pre-approved or auto-executed. Quantities, evidence and deadlines are in the JSON. A day that arrives after a deadline can expose unresolved work.\n`;
}
