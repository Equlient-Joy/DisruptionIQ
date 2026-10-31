import { configuredRepository } from './repository';
import { createApp } from './app';
const repository=configuredRepository();
await repository.init();
const app=createApp(repository);
const port=Number(process.env.PORT||3000);
const hostname=process.env.HOST||'0.0.0.0';
const server=Bun.serve({port,hostname,fetch:async(request)=>{
  const url=new URL(request.url);
  if(url.pathname.startsWith('/api/'))return app.fetch(request);
  const relative=url.pathname==='/'?'index.html':decodeURIComponent(url.pathname).slice(1);
  if(relative.includes('..')||relative.includes('\\'))return new Response('Invalid path',{status:400});
  const file=Bun.file(`dist/${relative}`);
  if(await file.exists())return new Response(file);
  const index=Bun.file('dist/index.html');
  if(await index.exists())return new Response(index);
  return new Response('Frontend build is missing. Run bun run build, or start bun run dev:web for development.',{status:503});
}});
console.log(`DisruptionIQ API: http://${server.hostname}:${server.port} · ${repository.mode}`);
async function shutdown(){server.stop();await repository.close();process.exit(0);}
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
