import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,unlink,rmdir,readdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {parseHosts,renderHosts,readHosts,saveHosts} from './hosts.mjs';

test('managed block preserves unrelated Windows hosts entries',()=>{
  const before='# Windows hosts\r\n127.0.0.1 localhost\r\n';
  const after=renderHosts(before,[{ip:'10.1.2.3',host:'portal.dev.lan'}]);
  assert.ok(after.startsWith(before));
  assert.deepEqual(parseHosts(after).entries,[{ip:'10.1.2.3',host:'portal.dev.lan'}]);
  assert.deepEqual(parseHosts(after).existing,[{ip:'127.0.0.1',host:'localhost'}]);
  assert.equal(renderHosts(after,[]),'# Windows hosts\r\n127.0.0.1 localhost\r\n');
});

test('invalid or conflicting names are rejected before saving',()=>{
  assert.throws(()=>renderHosts('10.0.0.1 portal.dev.lan\n',[{ip:'10.0.0.2',host:'portal.dev.lan'}]),/уже задан/);
  assert.throws(()=>renderHosts('',[{ip:'not-ip',host:'portal.dev.lan'}]),/IPv4/);
  assert.throws(()=>renderHosts('',[{ip:'10.0.0.1',host:'bad host'}]),/имя хоста/);
  assert.throws(()=>renderHosts('',[{ip:'10.0.0.1',host:'x.test'},{ip:'10.0.0.2',host:'x.test'}]),/несколько раз/);
});

test('save checks the original file hash and only writes the managed block',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'lk-hosts-test-'));
  const filename=path.join(dir,'hosts');
  try{
    await writeFile(filename,'127.0.0.1 localhost\n');
    const original=await readHosts(filename);
    let elevationCalled=false;
    const run=async(_script,inputFile,resultFile)=>{elevationCalled=true;const job=JSON.parse(await readFile(inputFile,'utf8'));await writeFile(filename,job.content);await writeFile(resultFile,JSON.stringify({ok:true}))};
    const saved=await saveHosts({hash:original.hash,entries:[{ip:'10.1.2.3',host:'portal.dev.lan'}]},{filename,directory:dir,run});
    assert.ok(elevationCalled);assert.equal(saved.entries[0].host,'portal.dev.lan');assert.equal(saved.existing[0].host,'localhost');
    await assert.rejects(saveHosts({hash:original.hash,entries:[]},{filename,directory:dir,run}),/изменился/);
  }finally{for(const name of await readdir(dir))await unlink(path.join(dir,name));await rmdir(dir)}
});
