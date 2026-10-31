import { mkdir, access, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { generateEnterpriseDataset, renderPresenterGuide } from './synthetic/generator';
import { parseSimulationDataset } from '../src/domain/simulation-dataset';

async function main():Promise<void> {
  const args=process.argv.slice(2);const options=new Map<string,string>();let overwrite=false;
  for(let i=0;i<args.length;i++) {
    const key=args[i]!;
    if(key==='--overwrite') {overwrite=true;continue;}
    if(!['--seed','--start-date','--days','--out'].includes(key) || !args[i+1] || args[i+1]!.startsWith('--')) throw new Error('Usage: --seed <seed> --start-date YYYY-MM-DD [--days 7] --out <file.json> [--overwrite]');
    options.set(key,args[++i]!);
  }
  const seed=options.get('--seed');const startDate=options.get('--start-date');const out=options.get('--out');
  if(!seed || !startDate || !out) throw new Error('An explicit --seed, --start-date and --out are required.');
  const dataset=generateEnterpriseDataset({seed,startDate,days:Number(options.get('--days') ?? 7)});
  const content=JSON.stringify(dataset,null,2);const stored=parseSimulationDataset(content);
  const path=resolve(out);const guide=`${path.replace(/\.json$/i,'')}.presenter.md`;
  if(!overwrite) for(const target of [path,guide]) {
    const exists=await access(target).then(()=>true,()=>false);
    if(exists) throw new Error(`Output exists: ${target}. Choose another path or explicitly use --overwrite.`);
  }
  await mkdir(dirname(path),{recursive:true});
  await writeFile(path,content,{flag:overwrite?'w':'wx'});
  await writeFile(guide,renderPresenterGuide(dataset),{flag:overwrite?'w':'wx'});
  process.stdout.write(`Generated ${dataset.days.length} UTC days: ${path}\nPresenter guide: ${guide}\nSource SHA-256: ${stored.hash}\nNo application data was imported.\n`);
}
if(import.meta.main) await main().catch(error=>{process.stderr.write(`${error instanceof Error?error.message:String(error)}\n`);process.exitCode=1;});
