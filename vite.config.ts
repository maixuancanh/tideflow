import { harborStatePlugin } from './server/harborState';
import { defineConfig, loadEnv } from 'vite';
import { nansenFeedPlugin } from './server/nansenPlugin';
export default defineConfig(({mode})=>{
 const env=loadEnv(mode,process.cwd(),'NANSEN_');
 return {
 plugins:[harborStatePlugin(),nansenFeedPlugin(process.env.NANSEN_API_KEYS??env.NANSEN_API_KEYS??process.env.NANSEN_API_KEY??env.NANSEN_API_KEY??'')],
 build:{rollupOptions:{input:{prototype:'index.html',study:'study.html'}}},
 };
});
