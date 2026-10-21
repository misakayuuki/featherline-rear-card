import {readFile,writeFile,mkdir,readdir,unlink,rmdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {compileScript} from '../upstream/rear-card-bridge/tools/card-build/src/compile.js';
import {collectModuleEntries} from '../upstream/rear-card-bridge/tools/card-build/src/build.js';
import {zipSync} from '../upstream/rear-card-bridge/tools/card-build/node_modules/fflate/esm/index.mjs';
const root=path.dirname(fileURLToPath(import.meta.url));
const assets=path.join(root,'Featherline/app/src/main/assets/rearcard');
const manifest=JSON.parse(await readFile(path.join(root,'module/module.json'),'utf8'));
if(!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(manifest.version)) throw new Error('Invalid module version');
// Use the official module-entry rules and compiler for both deliverables. The
// bridge injects bridge-shim.js; bundling a copy would override the host API.
const entries=collectModuleEntries(path.join(root,'module'))
  .filter(({rel})=>path.posix.basename(rel)!=='bridge-shim.js');
for(const required of ['module.json','card/index.html','card/core.js','card/config.js','card/main.js','card/data.js',
  'webroot/index.html','webroot/settings.js','webroot/settings.css']) {
  if(!entries.some(({rel})=>rel===required)) throw new Error('Missing module entry: '+required);
}
const bundle={};
const appFiles=new Map();
for(const {rel,abs} of entries) {
  let data=await readFile(abs);
  if(rel.startsWith('card/')&&rel.endsWith('.js')) data=Buffer.from(await compileScript(data.toString('utf8'),rel),'utf8');
  bundle[rel]=new Uint8Array(data);
  // The source app always generates card/data.js from its current projection.
  if(rel==='card/data.js') continue;
  const target=rel.startsWith('card/')?rel.slice('card/'.length):rel;
  if(appFiles.has(target)) throw new Error('App asset path collision: '+target);
  appFiles.set(target,data);
}
await mkdir(assets,{recursive:true});
for(const [name,data] of appFiles) {
  await mkdir(path.dirname(path.join(assets,name)),{recursive:true});
  await writeFile(path.join(assets,name),data);
}
// Remove stale generated files individually, without deleting the asset root.
async function pruneGeneratedAssets(relative='') {
  const directory=path.join(assets,relative);
  for(const entry of await readdir(directory,{withFileTypes:true})) {
    const name=relative?relative+'/'+entry.name:entry.name;
    if(entry.isDirectory()) await pruneGeneratedAssets(name);
    else if(entry.isFile()&&!appFiles.has(name)) await unlink(path.join(assets,name));
    else if(entry.isSymbolicLink()) throw new Error('Unexpected symbolic link in generated assets: '+name);
  }
  if(relative&&(await readdir(directory)).length===0) await rmdir(directory);
}
await pruneGeneratedAssets();
await mkdir(path.join(root,'dist'),{recursive:true});
await writeFile(path.join(root,`dist/featherline-rear-card-${manifest.version}.zip`),zipSync(bundle));
console.log(`Prepared ${appFiles.size} app assets and module ${manifest.version} ZIP (no health data).`);
