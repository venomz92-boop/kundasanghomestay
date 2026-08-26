import { corsHeaders } from './_utils.js';
export async function onRequestGet({request,env}){
  const live=env.TOYYIBPAY_PAYMENT_ENABLED==='true' && !!env.TOYYIBPAY_SECRET_KEY && !!env.TOYYIBPAY_CATEGORY_CODE;
  return new Response(JSON.stringify({enabled:live,isLive:live,mode:live?'live':'disabled'}),{status:200,headers:{...corsHeaders(request),'Cache-Control':'no-store'}});
}
export async function onRequestOptions({request}){return new Response(null,{headers:corsHeaders(request)})}
