import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const windows = process.platform === 'win32';
export const directory = process.env.LK_DATA_DIR || (windows ? path.join(process.env.LOCALAPPDATA, 'LK-Jira-Board') : '/data');
const filename = path.join(directory, windows ? 'profile.dpapi' : 'profile.json');

function protect(value, encrypt) {
  const command = encrypt
    ? '$s=[Console]::In.ReadToEnd() | ConvertTo-SecureString -AsPlainText -Force; [Console]::Out.Write(($s | ConvertFrom-SecureString))'
    : '$s=[Console]::In.ReadToEnd() | ConvertTo-SecureString; $p=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s); try {[Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($p))} finally {[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p)}';
  return new Promise((resolve,reject) => {
    const childEnv={...process.env};
    // Do not inherit a parent PowerShell module path: it can make the child fail to load Security on duplicate type data.
    delete childEnv.PSModulePath;
    const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',"$ErrorActionPreference='Stop'; [Console]::InputEncoding=[Text.UTF8Encoding]::new($false); [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); "+command],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:childEnv});
    let output='';child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>output+=chunk);
    child.stderr.resume();child.on('error',()=>reject(new Error('Profile encryption unavailable')));
    child.on('exit',code=>code===0?resolve(output.trim()):reject(new Error('Profile encryption failed')));
    child.stdin.on('error',()=>{});child.stdin.end(value);
  });
}
export async function loadProfile() {
  let raw;
  try { raw=await readFile(filename,'utf8'); } catch(error) { if(error.code==='ENOENT')return null;throw error; }
  return JSON.parse(windows ? await protect(raw,false) : raw);
}
export async function saveProfile(profile) {
  await mkdir(directory,{recursive:true,mode:0o700});
  const json=JSON.stringify(profile);
  const content=windows ? await protect(json,true) : json;
  await writeFile(filename+'.tmp',content,{mode:0o600});
  await rename(filename+'.tmp',filename);
}
