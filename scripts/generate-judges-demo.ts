import { access, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { generateJudgesDemo, judgesPresenterGuide, warehouseRestoreEvent } from './synthetic/judges-demo';
import { parseSimulationDataset } from '../src/domain/simulation-dataset';

const args = process.argv.slice(2);
let startDate = '2026-11-01';
let out = 'datasets/judges-selected-features.json';
let overwrite = false;
for (let i = 0; i < args.length; i++) {
  const key = args[i];
  if (key === '--overwrite') { overwrite = true; continue; }
  const value = args[++i];
  if (!value || !['--start-date', '--out'].includes(key!)) throw new Error('Usage: bun scripts/generate-judges-demo.ts [--start-date YYYY-MM-DD] [--out file.json] [--overwrite]');
  if (key === '--start-date') startDate = value; else out = value;
}
const dataset = generateJudgesDemo(startDate);
const content = JSON.stringify(dataset, null, 2) + '\n';
const stored = parseSimulationDataset(content);
const target = resolve(out);
const stem = target.replace(/\.json$/i, '');
const outputs = [[target, content], [`${stem}.presenter.md`, judgesPresenterGuide(dataset)], [`${stem}.restore-warehouse.json`, JSON.stringify([warehouseRestoreEvent(dataset)], null, 2) + '\n']] as const;
if (!overwrite) for (const [path] of outputs) if (await access(path).then(() => true, () => false)) throw new Error(`Output already exists: ${path}. Choose another --out path or explicitly use --overwrite.`);
await mkdir(dirname(target), { recursive: true });
for (const [path, text] of outputs) await writeFile(path, text, { flag: overwrite ? 'w' : 'wx' });
console.log(`Created 5-day source: ${target}\nSHA-256: ${stored.hash}\nExpected new incidents by day: 0, 1 supplier_delay, 1 warehouse_outage, 1 late_shipment, 1 stock_shortage\nNo operational data was imported or cleared.`);
