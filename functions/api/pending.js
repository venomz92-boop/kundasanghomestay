import { corsHeaders, getClientIP, logAction, enforceHttps, hashPassword, getAdminToken, jsonResponse } from './_utils.js';

async function requireAdmin(request, env) {
  const token=await getAdminToken(request);
  if(!token||!env.ADMIN_TOKEN||token!==env.ADMIN_TOKEN)return jsonResponse({error:'Unauthorized'},401,request);
  return null;
}
async function read(db,key){const r=await db.prepare('SELECT data FROM store WHERE key=?').bind(key).first();try{return r?.data?JSON.parse(r.data):[]}catch(_){return[]}}

export async function onRequestGet({request,env}){
  const redirect=enforceHttps(request);if(redirect)return redirect;
  const err=await requireAdmin(request,env);if(err)return err;
  const db=env.DB;if(!db)return jsonResponse({error:'DB not configured'},500,request);
  await db.prepare('CREATE TABLE IF NOT EXISTS store(key TEXT PRIMARY KEY,data TEXT)').run();
  return jsonResponse(await read(db,'kd_pending'),200,request,{'Cache-Control':'no-store'});
}

export async function onRequestPost({request,env}){
  const redirect=enforceHttps(request);if(redirect)return redirect;
  try{
    const body=await request.json();
    // Public registration endpoint accepts ONE listing, never an entire pending array.
    const h=body.homestay||body.listing;
    const ownerPassword=String(body.ownerPassword||'');
    if(!h||!ownerPassword)return jsonResponse({error:'Homestay and ownerPassword are required'},400,request);
    if(ownerPassword.length<8)return jsonResponse({error:'Owner password must be at least 8 characters'},400,request);
    const required=['name','location','ownerPrice','ownerName','whatsapp','ownerEmail','ownerBankAccount','bankHolder'];
    for(const key of required)if(h[key]===undefined||h[key]===null||String(h[key]).trim()==='')return jsonResponse({error:`Missing required field: ${key}`},400,request);
    const price=Number(h.ownerPrice);if(!Number.isFinite(price)||price<=0||price>100000)return jsonResponse({error:'Invalid nightly price'},400,request);
    const db=env.DB;if(!db)return jsonResponse({error:'DB not configured'},500,request);
    await db.prepare('CREATE TABLE IF NOT EXISTS store(key TEXT PRIMARY KEY,data TEXT)').run();
    const pending=await read(db,'kd_pending'), approved=await read(db,'kd_approved');
    const whatsapp=String(h.whatsapp).replace(/[^0-9]/g,'');
    const duplicate=[...pending,...approved].some(x=>String(x.ownerEmail||'').toLowerCase()===String(h.ownerEmail).toLowerCase() && String(x.name||'').toLowerCase()===String(h.name).toLowerCase());
    if(duplicate)return jsonResponse({error:'A listing with this owner email and property name already exists.'},409,request);
    const hashed=await hashPassword(ownerPassword,env);
    const clean={...h,id:h.id||Date.now(),whatsapp,ownerPrice:Math.round(price*100)/100,approved:false,verified:false,ownerPasswordHash:hashed.hash,ownerSalt:hashed.salt,ownerPasswordAlgorithm:hashed.algorithm,createdAt:new Date().toISOString()};
    delete clean.password; delete clean.ownerPassword;
    pending.push(clean);
    await db.prepare('INSERT OR REPLACE INTO store(key,data) VALUES(?,?)').bind('kd_pending',JSON.stringify(pending)).run();
    await logAction({db,action:'homestay_submitted',admin:'public',details:`Homestay ${clean.id} submitted`,ip:getClientIP(request),userId:clean.ownerEmail,homestayId:clean.id});
    return jsonResponse({success:true,homestay:{...clean,ownerPasswordHash:undefined,ownerSalt:undefined,ownerPasswordAlgorithm:undefined}},201,request);
  }catch(e){console.error('Pending registration error:',e.message);return jsonResponse({error:'Could not submit listing'},500,request)}
}

export async function onRequestDelete({request,env}){
  const redirect=enforceHttps(request);if(redirect)return redirect;
  const err=await requireAdmin(request,env);if(err)return err;
  const db=env.DB;if(!db)return jsonResponse({error:'DB not configured'},500,request);
  const id=new URL(request.url).searchParams.get('id');if(!id)return jsonResponse({success:true},200,request);
  const pending=await read(db,'kd_pending');const deleted=pending.find(h=>String(h.id)===String(id));
  const next=pending.filter(h=>String(h.id)!==String(id));
  await db.prepare('INSERT OR REPLACE INTO store(key,data) VALUES(?,?)').bind('kd_pending',JSON.stringify(next)).run();
  await logAction({db,action:'homestay_pending_deleted',admin:'admin',details:`Deleted pending homestay ${id}`,ip:getClientIP(request),userId:deleted?.ownerEmail,homestayId:id});
  return jsonResponse({success:true,deleted:id},200,request);
}
export async function onRequestOptions({request}){return new Response(null,{headers:corsHeaders(request)})}
