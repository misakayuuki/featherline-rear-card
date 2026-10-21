import {execFileSync} from 'node:child_process';
import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {zipSync} from '../upstream/rear-card-bridge/tools/card-build/node_modules/fflate/esm/index.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
const app=path.join(root,'Featherline');
const manifest=JSON.parse(await readFile(path.join(root,'module/module.json'),'utf8'));
if(!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(manifest.version)) throw new Error('Invalid module version');
const prefix='featherline-rear-card/';
const files={};
const paths=execFileSync('git',['-c',`safe.directory=${app.replaceAll('\\','/')}`,'ls-files','-z','--cached','--others','--exclude-standard'],{cwd:app,encoding:'utf8'}).split('\0').filter(Boolean);
for(const name of new Set(paths)) {
  // Never ship machine configuration, signing files, build output or local histories.
  if (/(^|\/)(\.git|\.gradle|\.kotlin|build|\.idea)(\/|$)/.test(name) || /(^|\/)(local\.properties|keystore\.properties)$/.test(name) || /\.(jks|keystore|apk|aab|log)$/i.test(name)) continue;
  files[prefix+'Featherline/'+name]=await readFile(path.join(app,name));
}
async function addTree(relative) {
  const entries=await readdir(path.join(root,relative),{withFileTypes:true});
  entries.sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);
  for(const entry of entries) {
    const name=relative+'/'+entry.name;
    if(entry.isDirectory()) await addTree(name);
    else if(entry.isFile()) files[prefix+name]=await readFile(path.join(root,name));
  }
}
for(const dir of ['module','tests']) await addTree(dir);
for(const name of ['.gitignore','README.md','VERIFICATION.md','RELEASE_NOTES.md','build-module.mjs','package-source.mjs',
  'preview/render-structured-card.cjs','preview/structured-card.png','preview/structured-card-empty.png','preview/structured-card-privacy.png',
  'preview/structured-card-blue.png','preview/structured-card-light.png','preview/settings-mobile.png']) {
  files[prefix+name]=await readFile(path.join(root,name));
}
files[prefix+'LICENSE']=await readFile(path.join(app,'LICENSE'));
await mkdir(path.join(root,'dist'),{recursive:true});
const output=path.join(root,`dist/Featherline-RearCard-${manifest.version}-source.zip`);
await writeFile(output,zipSync(files,{level:6}));
console.log(`Packaged ${Object.keys(files).length} source files: ${output}`);
