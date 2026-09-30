import { mkdir,readFile,writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { resolve,join } from 'node:path';
process.env.HARBOR_DATA_DIR=resolve(process.env.HARBOR_DATA_DIR??'.server-data');
process.env.HARBOR_FEED_DIR=resolve(process.env.HARBOR_FEED_DIR??join(process.env.HARBOR_DATA_DIR,'feed'));
await mkdir(process.env.HARBOR_DATA_DIR,{recursive:true});
if(!process.env.HARBOR_SESSION_SECRET){
 const path=join(process.env.HARBOR_DATA_DIR,'session.secret');
 try{process.env.HARBOR_SESSION_SECRET=await readFile(path,'utf8');}
 catch(error){if(error.code!=='ENOENT')throw error;const secret=randomBytes(48).toString('hex');try{await writeFile(path,secret,{flag:'wx',mode:0o600});process.env.HARBOR_SESSION_SECRET=secret;}catch(error){if(error.code!=='EEXIST')throw error;process.env.HARBOR_SESSION_SECRET=await readFile(path,'utf8');}}
}
if(process.env.HOST&&!['127.0.0.1','localhost','::1'].includes(process.env.HOST)&&(!process.env.HARBOR_PUBLIC_ORIGIN?.startsWith('https://')||process.env.HARBOR_SECURE_COOKIE!=='true'))throw new Error('Public binding requires HTTPS HARBOR_PUBLIC_ORIGIN and HARBOR_SECURE_COOKIE=true.');
await import('../server-dist/standalone.mjs');
