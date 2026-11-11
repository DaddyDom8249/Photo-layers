const json = (data, status=200) => Response.json(data,{status,headers:{'Cache-Control':'no-store'}});
const fail = message => { throw new Error(message); };
const uuid = value => typeof value==='string' && /^[0-9a-f-]{36}$/i.test(value);
const objSchema = properties => ({type:'object',properties,additionalProperties:false});
const tools = [
 {name:'layerpeel_status',description:'Read the connected LayerPeel browser workspace and current command. Open the app, load a photo and enable Connect to GPT first. Models run in the open browser. Status and layer metadata contain no photo bytes.',inputSchema:objSchema({}),annotations:{readOnlyHint:true}},
 {name:'layerpeel_run',description:'Queue one operation in the connected OPEN browser. Use workspace_id and revision from status to prevent editing a different photo. Returns queued, never claims processing is complete. Check layerpeel_result. Reuse request_id for retries. Reconstruction uses an already prepared outline in the editor; generated pixels are estimates. Never describe X-Ray as seeing hidden content.',inputSchema:{...objSchema({workspace_id:{type:'string'},revision:{type:'string'},request_id:{type:'string',description:'New UUID for each operation; reuse for retries'},action:{type:'string',enum:['separate','extract_at','set_view','update_layer','export_png','export_zip','reconstruct']},layer_index:{type:'integer',minimum:0},view:{type:'string',enum:['normal','material','outline','xray','peel']},x:{type:'number'},y:{type:'number'},rotation:{type:'number',minimum:-360,maximum:360},opacity:{type:'number',minimum:0,maximum:1},visible:{type:'boolean'},variant:{type:'string',enum:['source','completed','generated']}}),required:['workspace_id','revision','request_id','action']},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true}},
 {name:'layerpeel_result',description:'Read the latest queued/running/completed/failed operation and export links. A completed export PNG up to 4 MB can be returned as an image using include_image. Download links require the owner to sign in. Failure or pending is not a successful image operation.',inputSchema:objSchema({request_id:{type:'string'},include_image:{type:'boolean'}}),annotations:{readOnlyHint:true}}
];
async function read(bucket,key) {const value=await bucket.get(key);return {value:value?await value.json():null,etag:value?.etag};}
async function put(bucket,key,value,etag) {return bucket.put(key,JSON.stringify(value),{httpMetadata:{contentType:'application/json'},onlyIf:etag?{etagMatches:etag}:{etagDoesNotMatch:'*'}});}
async function body(request,limit=32768) {const reader=request.body?.getReader();if(!reader)return new Uint8Array();let total=0,parts=[];while(true){const {done,value}=await reader.read();if(done)break;total+=value.length;if(total>limit){await reader.cancel();fail('Request exceeds size limit');}parts.push(value);}let bytes=new Uint8Array(total),offset=0;for(const p of parts){bytes.set(p,offset);offset+=p.length;}return bytes;}
async function input(request) {return JSON.parse(new TextDecoder().decode(await body(request)));}
function validate(args) {
 if(!uuid(args.workspace_id)||!uuid(args.request_id)||!uuid(args.revision))fail('Workspace, revision and request IDs must be UUIDs');
 if(!tools[1].inputSchema.properties.action.enum.includes(args.action))fail('Unknown action');
 if(['update_layer','export_png','reconstruct'].includes(args.action)&&(!Number.isInteger(args.layer_index)||args.layer_index<0||args.layer_index>100))fail('Choose a valid layer_index');
 if(args.action==='extract_at'&&(!Number.isFinite(args.x)||!Number.isFinite(args.y)||args.x<0||args.x>1||args.y<0||args.y>1))fail('Extraction x/y must be normalized 0–1');
 if(args.action==='set_view'&&!tools[1].inputSchema.properties.view.enum.includes(args.view))fail('Unknown view');
 for(const k of ['x','y','rotation','opacity'])if(args[k]!==undefined&&(!Number.isFinite(args[k])||Math.abs(args[k])>100000))fail('Invalid '+k);
 if(args.opacity!==undefined&&(args.opacity<0||args.opacity>1))fail('Opacity must be 0–1');
 if(args.variant!==undefined&&!['source','completed','generated'].includes(args.variant))fail('Invalid export variant');
 if(args.visible!==undefined&&typeof args.visible!=='boolean')fail('Invalid visibility');
}
async function call(name,args,bucket,prefix,origin) {
 const {value:state}=await read(bucket,prefix+'state');
 if(name==='layerpeel_status')return {app_url:origin,connected:!!state&&Date.now()-state.seen<45000,workspace:state,command:(await read(bucket,prefix+'command')).value,limits:{browser_must_remain_open:true,cloud_gpu:false,hidden_content:'generated estimates only',reference_generation:'BLOCKED: provider backend not connected'}};
 if(name==='layerpeel_run') {
  validate(args);
  const {value:old,etag}=await read(bucket,prefix+'command');
  if(old?.request_id===args.request_id)return old;
  if(!state||Date.now()-state.seen>45000)fail('BLOCKED: Open LayerPeel, load a photo and enable Connect to GPT. Keep the browser open.');
  if(args.workspace_id!==state.workspace_id||args.revision!==state.revision)fail('Workspace changed. Read status before issuing another command.');
  if(old&&['queued','running'].includes(old.status))fail('A command is already pending. Read result; do not resubmit with a different ID.');
  const command={...args,status:'queued',created_at:Date.now()};
  if(!await put(bucket,prefix+'command',command,etag))fail('Workspace busy. Read status and retry with the same request_id.');
  return command;
 }
 if(name==='layerpeel_result') {
  const {value:command}=await read(bucket,prefix+'command');
  if(!command)return {status:'idle'};
  if(args.request_id&&args.request_id!==command.request_id)fail('This is not the latest command. Read status.');
  const result={...command};
  if(command.artifact)result.download_url=origin+'/api/gpt/file/'+command.artifact;
  return result;
 }
 fail('Unknown tool');
}
export default {async fetch(request,env) {
 const url=new URL(request.url),path=url.pathname;
 if(path!='/mcp'&&!path.startsWith('/api/gpt/')) {
  if(path==='/api/layerpeel/generate')return json({ok:false,error:'BLOCKED: BeatVision generation backend has not been connected.'},503);
  return env.ASSETS.fetch(request);
 }
 const user=request.headers.get('oai-authenticated-user-id');
 if(!user)return json({error:'Sign in with ChatGPT is required'},401);
 if(!env.BUCKET)return json({error:'Storage is unavailable'},503);
 const bucket=env.BUCKET,prefix='gpt/'+encodeURIComponent(user)+'/';
 try {
  if(path==='/mcp') {
   if(request.method!=='POST')return json({error:'Use POST'},405);
   const rpc=await input(request);
   if(rpc.method==='server/discover')return json({jsonrpc:'2.0',id:rpc.id,result:{supportedVersions:['2026-07-28'],capabilities:{tools:{}}}});
   if(rpc.method==='initialize')return json({jsonrpc:'2.0',id:rpc.id,result:{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'LayerPeel Studio',version:'1.0.0'}}});
   if(rpc.method==='tools/list')return json({jsonrpc:'2.0',id:rpc.id,result:{tools}});
   if(rpc.method==='notifications/initialized')return new Response(null,{status:202});
   if(rpc.method!=='tools/call')return json({jsonrpc:'2.0',id:rpc.id,error:{code:-32601,message:'Method not found'}});
   try {
    const args=rpc.params.arguments||{},value=await call(rpc.params.name,args,bucket,prefix,url.origin);
    const content=[{type:'text',text:JSON.stringify(value)}];
    if(rpc.params.name==='layerpeel_result'&&args.include_image&&value.status==='completed'&&value.artifact){
     const file=await bucket.get(prefix+'files/'+value.artifact);
     if(file?.httpMetadata?.contentType==='image/png'&&file.size<=4000000){const bytes=new Uint8Array(await file.arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));content.push({type:'image',mimeType:'image/png',data:btoa(binary)});}
    }
    return json({jsonrpc:'2.0',id:rpc.id,result:{content}});
   }catch(error){return json({jsonrpc:'2.0',id:rpc.id,result:{isError:true,content:[{type:'text',text:error.message}]}});}
  }
  if(path.startsWith('/api/gpt/file/')&&request.method==='GET') {
   const id=path.split('/').at(-1);if(!/^[0-9a-f-]{36}\.(png|zip)$/.test(id))return json({error:'Invalid file'},400);
   const file=await bucket.get(prefix+'files/'+id);if(!file)return json({error:'Not found'},404);
   return new Response(file.body,{headers:{'Content-Type':file.httpMetadata.contentType,'Content-Disposition':'attachment; filename="layerpeel-'+id+'"','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
  }
  if(request.method!=='POST')return json({error:'Use POST'},405);
  if(request.headers.get('origin')!==url.origin)return json({error:'Same-origin request required'},403);
  if(path==='/api/gpt/pulse') {
   const state=await input(request);if(!uuid(state.workspace_id)||!uuid(state.revision))fail('Invalid workspace');
   const {value:current}=await read(bucket,prefix+'state');
   if(state.connect!==true&&current?.workspace_id!==state.workspace_id)fail('This tab is no longer connected. Connect again to take control.');
   if(state.disconnect===true){if(current?.workspace_id===state.workspace_id)await bucket.delete(prefix+'state');return json({connected:false});}
   delete state.connect;await bucket.put(prefix+'state',JSON.stringify({...state,seen:Date.now()}));
   const {value:command}=await read(bucket,prefix+'command');
   return json({command:command?.workspace_id===state.workspace_id?command:null});
  }
  const {value:command,etag}=await read(bucket,prefix+'command');
  if(!command)fail('No command');
  if(path==='/api/gpt/upload') {
   if(command.status!=='running'||request.headers.get('x-command-id')!==command.request_id)fail('No matching running command');
   const type=request.headers.get('content-type');if(!['image/png','application/zip'].includes(type))fail('Invalid export type');
   const bytes=await body(request,16*1024*1024);if(!bytes.length)fail('Empty export');
   const artifact=command.request_id+(type==='image/png'?'.png':'.zip');await bucket.put(prefix+'files/'+artifact,bytes,{httpMetadata:{contentType:type}});return json({artifact});
  }
  const data=await input(request);
  if(data.request_id!==command.request_id||data.workspace_id!==command.workspace_id)fail('Command changed');
  if(path==='/api/gpt/claim') {
   const {value:state}=await read(bucket,prefix+'state');
   if(command.status!=='queued'||data.revision!==command.revision||state?.revision!==command.revision||state?.workspace_id!==command.workspace_id)fail('Command expired or workspace changed');
   const next={...command,status:'running',started_at:Date.now()};if(!await put(bucket,prefix+'command',next,etag))fail('Already claimed');return json(next);
  }
  if(path==='/api/gpt/finish') {
   if(!['running','queued'].includes(command.status))fail('Command already finished');
   if(data.artifact&&!new RegExp('^'+command.request_id+'\\.(png|zip)$').test(data.artifact))fail('Invalid artifact');
   const next={...command,status:data.error?'failed':'completed',finished_at:Date.now(),error:data.error?String(data.error).slice(0,500):undefined,artifact:data.artifact||undefined};
   if(!await put(bucket,prefix+'command',next,etag))fail('Command changed');return json(next);
  }
  return json({error:'Unknown endpoint'},404);
 }catch(error){return json({error:error.message},400);}
}};
