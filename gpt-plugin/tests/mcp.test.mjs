import {test} from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.js';
class Bucket {
 constructor(){this.items=new Map();this.serial=0;}
 async get(key){const v=this.items.get(key);return v?{etag:v.etag,size:v.bytes.length,httpMetadata:v.metadata,body:v.bytes,json:async()=>JSON.parse(new TextDecoder().decode(v.bytes)),arrayBuffer:async()=>v.bytes.buffer}:null;}
 async put(key,value,options={}){const old=this.items.get(key);if(options.onlyIf?.etagMatches&&old?.etag!==options.onlyIf.etagMatches)return null;if(options.onlyIf?.etagDoesNotMatch==='*'&&old)return null;const bytes=typeof value==='string'?new TextEncoder().encode(value):value;this.items.set(key,{bytes,etag:String(++this.serial),metadata:options.httpMetadata});return {etag:String(this.serial)};}
 async delete(key){this.items.delete(key);}
}
const origin='https://example.test',workspace_id=crypto.randomUUID(),revision=crypto.randomUUID();
function setup(){const env={BUCKET:new Bucket(),ASSETS:{fetch:async()=>new Response('editor')}};return {env,request:async(path,data,user='alice',extra={})=>worker.fetch(new Request(origin+path,{method:data===undefined?'GET':'POST',headers:{'oai-authenticated-user-id':user,'content-type':'application/json',origin,...extra},body:data===undefined?undefined:JSON.stringify(data)}),env)};}
async function rpc(request,name,args={}){return(await(await request('/mcp',{jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})).json()).result;}
async function connected(ctx){await ctx.request('/api/gpt/pulse',{workspace_id,revision,connect:true,layers:[],photo_loaded:true});}
const command=()=>({workspace_id,revision,request_id:crypto.randomUUID(),action:'separate'});
test('MCP discovery and tool schemas',async()=>{const c=setup();const r=await(await c.request('/mcp',{id:1,method:'tools/list'})).json();assert.equal(r.result.tools.length,3);assert.equal(r.result.tools[1].inputSchema.additionalProperties,false);});
test('requires identity and same-origin browser writes',async()=>{const c=setup();assert.equal((await c.request('/mcp',{},'')).status,401);assert.equal((await c.request('/api/gpt/pulse',{},'alice',{origin:'https://evil.test'})).status,403);});
test('offline browser returns blocked without fake processing',async()=>{const c=setup();const r=await rpc(c.request,'layerpeel_run',command());assert.equal(r.isError,true);assert.match(r.content[0].text,/BLOCKED/);});
test('queue is idempotent, claim is atomic, finish returns completed',async()=>{const c=setup();await connected(c);const args=command();assert.equal(JSON.parse((await rpc(c.request,'layerpeel_run',args)).content[0].text).status,'queued');assert.equal((await rpc(c.request,'layerpeel_run',args)).isError,undefined);assert.equal((await rpc(c.request,'layerpeel_run',command())).isError,true);assert.equal((await c.request('/api/gpt/claim',args)).status,200);assert.equal((await c.request('/api/gpt/claim',args)).status,400);await c.request('/api/gpt/finish',{...args,error:'model failed'});assert.equal(JSON.parse((await rpc(c.request,'layerpeel_result')).content[0].text).status,'failed');});
test('rejects stale photo revision and isolates user workspaces',async()=>{const c=setup();await connected(c);assert.equal((await rpc(c.request,'layerpeel_run',{...command(),revision:crypto.randomUUID()})).isError,true);const res=await c.request('/mcp',{id:1,method:'tools/call',params:{name:'layerpeel_status'}},'bob');assert.equal(JSON.parse((await res.json()).result.content[0].text).connected,false);assert.equal((await c.request('/api/gpt/file/'+crypto.randomUUID()+'.png',undefined,'bob')).status,404);});
test('queued command is not claimed after photo changes',async()=>{const c=setup();await connected(c);const args=command();await rpc(c.request,'layerpeel_run',args);await c.request('/api/gpt/pulse',{workspace_id,revision:crypto.randomUUID()});assert.equal((await c.request('/api/gpt/claim',args)).status,400);});
