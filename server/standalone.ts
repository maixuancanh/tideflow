import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, stat, unlink } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { createSessionHandler, harborStore } from './harborState';
import { createFeedHandler } from './nansenPlugin';

const host=process.env.HOST??'127.0.0.1',port=Number(process.env.PORT??4318);
const secret=process.env.HARBOR_SESSION_SECRET??'';
if(secret.length<32)throw new Error('HARBOR_SESSION_SECRET must contain at least 32 characters.');
const root=resolve(process.env.HARBOR_STATIC_DIR??'dist');
const data=resolve(process.env.HARBOR_DATA_DIR??'.data');
await mkdir(data,{recursive:true});
// Only one owner may write this JSON database. Refuse a second process.
const lockPath=resolve(data,'server.lock');
const lock=await open(lockPath,'wx').catch(()=>{throw new Error('Save directory is locked. Check for a running server before removing server.lock.');});
await lock.writeFile(String(process.pid));
const release=async()=>{await lock.close();await unlink(lockPath).catch(()=>{});};
let stopping=false;
const session=createSessionHandler(harborStore,{secret,secure:process.env.HARBOR_SECURE_COOKIE==='true',origin:process.env.HARBOR_PUBLIC_ORIGIN});
const feed=createFeedHandler(process.env.NANSEN_API_KEYS??process.env.NANSEN_API_KEY??'');
const types:Record<string,string>={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp','.svg':'image/svg+xml','.glb':'model/gltf-binary','.woff2':'font/woff2'};
const server=createServer(async(req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','same-origin');
  try{
    const url=new URL(req.url??'/', 'http://localhost');
    if(url.pathname==='/healthz'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({status:stopping?'stopping':'ok'}));return;}
    if(url.pathname==='/readyz'){
      const built=await stat(resolve(root,'study.html')).then(s=>s.isFile(),()=>false);
      const ready=built&&!stopping;
      res.statusCode=ready?200:503;res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');
      res.end(JSON.stringify({ready,build:built,storage:'single-writer-json',nansenConfigured:!!(process.env.NANSEN_API_KEYS??process.env.NANSEN_API_KEY)}));return;
    }
    if(url.pathname==='/api/harbor/session'){await session(req,res);return;}
    if(url.pathname==='/api/harbor/feed'){await feed(req,res);return;}
    if(url.pathname.startsWith('/api/')){res.writeHead(404).end();return;}
    if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405,{Allow:'GET, HEAD'}).end();return;}
    const requested=decodeURIComponent(url.pathname==='/'?'/study.html':url.pathname);
    const file=resolve(root,'.'+requested);
    if(!file.startsWith(root+sep)||requested.split('/').some(part=>part.startsWith('.'))){res.writeHead(403).end();return;}
    const info=await stat(file).catch(()=>null);if(!info?.isFile()){res.writeHead(404).end();return;}
    res.setHeader('Content-Type',types[extname(file)]??'application/octet-stream');
    res.setHeader('Content-Length',info.size);res.setHeader('Cache-Control',extname(file)==='.html'?'no-cache':'public, max-age=3600');
    if(req.method==='HEAD'){res.end();return;}
    createReadStream(file).on('error',()=>res.destroy()).pipe(res);
  }catch{if(!res.headersSent)res.writeHead(500);res.end('Request unavailable');}
});
server.requestTimeout=30000;server.headersTimeout=15000;
server.on('error',async(error)=>{await release();console.error(error.message);process.exitCode=1;});
server.listen(port,host,()=>console.log(`Flow Harbor standalone: http://${host}:${port}`));
for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{
  stopping=true;server.close(async()=>{await release();process.exit(0);});server.closeIdleConnections();setTimeout(()=>process.exit(1),15000).unref();
});
