// Compare binaries on an isolated transfer fixture; STORY_BENCH_MODE=dom|real-video selects other workloads.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtemp,readFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const [before,after]=process.argv.slice(2).map(p=>path.resolve(p));
const realVideo=process.env.STORY_BENCH_MODE==='real-video';
const dom=process.env.STORY_BENCH_MODE==='dom';
assert(before&&after,'usage: node tests/bench-story.mjs <before-fb> <after-fb>');
assert.equal(process.platform,'linux','Linux daemon memory metrics required');
const dir=await mkdtemp(path.join(tmpdir(),'fb-bench-')),samples={before:[],after:[]};
try{
 for(let i=0;i<5;i++)for(const [name,binary] of [['before',before],['after',after]]){
  const env={...process.env,FB:binary,E2E_ONLY:realVideo?'protected story recording offsets and cross-origin safety':'story transfer benchmark',E2E_OUTPUT:dir};
  if(name==='before')env.STORY_BENCH_LEGACY='1';else delete env.STORY_BENCH_LEGACY;
  if(realVideo)delete env.STORY_BENCH;else env.STORY_BENCH='1';
  await promisify(execFile)(process.execPath,[path.join(root,'tests/e2e.mjs')],{env,timeout:120000,maxBuffer:1024*1024});
  const report=JSON.parse(await readFile(path.join(dir,'report.json'),'utf8'));
  const result=realVideo?{elapsedMs:report.find(x=>x.args?.[0]==='page'&&x.args?.[1]==='story-seek'&&x.args?.[2]==='record'&&x.args?.[3].endsWith('story-first.webm'))?.ms,bytes:(await stat(path.join(dir,'story-first.webm'))).size}:report.find(x=>x.benchmark)?.benchmark;
  assert(result?.elapsedMs>0,'benchmark completed');if(!realVideo)assert.equal(result.bytes,(dom?1:512)*(65536+2));samples[name].push(result);
 }
 const stats=values=>{const sorted=[...values].sort((a,b)=>a-b);return {median:sorted[2],min:sorted[0],max:sorted[4]}};
 console.log(JSON.stringify({samples,summary:Object.fromEntries(Object.entries(samples).map(([name,runs])=>[name,{elapsedMs:stats(runs.map(r=>r.elapsedMs)),...(realVideo?{}:{openMs:stats(runs.map(r=>r.openMs)),daemonPeakKiB:stats(runs.map(r=>r.daemonPeakKiB)),daemonCpuTicks:stats(runs.map(r=>r.daemonCpuTicks)),browserCpuTicks:runs.every(r=>r.browserCpuComplete)?stats(runs.map(r=>r.browserCpuTicks)):null})}]))},null,2));
}finally{await rm(dir,{recursive:true,force:true})}
