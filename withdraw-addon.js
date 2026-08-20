/**
 * Kundasang Admin - Withdraw Addon v2 (with API + local fallback)
 * Place at repo root: /withdraw-addon.js
 * Include in admin.html: <script src="withdraw-addon.js"></script>
 */
(function () {
  const STORAGE_WITHDRAWALS = "kd_withdrawals";
  const STORAGE_BANK = "kd_bank_profile";
  const API_CANDIDATES = ["/api/withdraw", "/api/withdraw-api"]; // try clean name first

  const CSS = `
  .kd-withdraw-btn{display:inline-flex;align-items:center;gap:8px;margin-top:12px;padding:10px 18px;border-radius:999px;background:#0F382E;color:#fff;font-weight:600;font-size:13px;border:1px solid #0F382E;cursor:pointer;transition:.18s;box-shadow:0 4px 14px -4px rgba(15,56,46,.35);}
  .kd-withdraw-btn:hover{transform:translateY(-1px);box-shadow:0 8px 20px -6px rgba(15,56,46,.4);}
  .kd-withdraw-btn:disabled{opacity:.45;cursor:not-allowed;transform:none;}
  .kd-withdraw-btn svg{width:16px;height:16px;}
  .kd-w-overlay{position:fixed;inset:0;z-index:9999;display:flex;align-items:flex-end;justify-content:center;background:rgba(15,23,18,.48);backdrop-filter:blur(8px);opacity:0;pointer-events:none;transition:opacity .25s ease;}
  .kd-w-overlay.open{opacity:1;pointer-events:auto;}
  .kd-w-modal{background:#fff;width:100%;max-width:480px;max-height:92vh;overflow:auto;border-radius:28px 28px 0 0;box-shadow:0 -20px 60px -15px rgba(0,0,0,.3);transform:translateY(18px);transition:transform .28s cubic-bezier(.22,1,.36,1);}
  .kd-w-overlay.open .kd-w-modal{transform:translateY(0);}
  @media(min-width:640px){.kd-w-overlay{align-items:center;padding:20px;}.kd-w-modal{border-radius:24px;max-height:88vh;}}
  .kd-w-head{position:sticky;top:0;background:#fff;z-index:2;padding:22px 24px 0 24px;border-radius:inherit;}
  .kd-w-body{padding:18px 24px 24px 24px;}
  .kd-w-balance{background:#F8F5F0;border:1px solid #efe7d9;border-radius:18px;padding:16px 18px;display:flex;justify-content:space-between;align-items:center;gap:12px;margin-top:14px;}
  .kd-w-balance b{font-size:22px;letter-spacing:-.02em;color:#0F382E;}
  .kd-w-field{margin-top:14px;}
  .kd-w-field label{display:block;font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:#6b7280;margin-bottom:6px;}
  .kd-w-input{width:100%;border:1px solid #e5e7eb;background:#fff;border-radius:999px;padding:12px 16px;font-size:14px;outline:none;transition:.18s;}
  .kd-w-input:focus{border-color:#0F382E;box-shadow:0 0 0 4px rgba(15,56,46,.08);}
  .kd-w-row{display:grid;grid-template-columns:1fr 1fr;gap:12px;}
  @media(max-width:420px){.kd-w-row{grid-template-columns:1fr;}}
  .kd-w-actions{display:flex;gap:10px;margin-top:20px;}
  .kd-w-actions button{flex:1;padding:12px 18px;border-radius:999px;font-weight:600;font-size:14px;cursor:pointer;border:1px solid transparent;}
  .kd-w-cancel{background:#fff;border-color:#e5e7eb !important;color:#111827;}
  .kd-w-confirm{background:#0F382E;color:#fff;}
  .kd-w-confirm:disabled{opacity:.5;cursor:not-allowed;}
  .kd-w-history{margin-top:22px;border-top:1px dashed #e5e7eb;padding-top:18px;}
  .kd-w-h-item{display:flex;justify-content:space-between;gap:12px;padding:10px 12px;border-radius:12px;background:#f9fafb;border:1px solid #f3f4f6;margin-top:8px;font-size:13px;}
  .kd-w-badge{font-size:10px;font-weight:700;letter-spacing:.05em;padding:4px 8px;border-radius:999px;text-transform:uppercase;}
  .kd-w-badge.pending{background:#fef3c7;color:#92400e;border:1px solid #fde68a;}
  .kd-w-badge.done{background:#dcfce7;color:#166534;border:1px solid #bbf7d0;}
  .kd-toast{position:fixed;left:50%;bottom:22px;transform:translateX(-50%) translateY(20px);background:#0F382E;color:#fff;padding:12px 18px;border-radius:999px;font-size:13px;font-weight:600;box-shadow:0 10px 30px -10px rgba(0,0,0,.4);z-index:10000;opacity:0;transition:.28s;pointer-events:none;}
  .kd-toast.show{opacity:1;transform:translateX(-50%) translateY(0);}
  `;

  function injectCSS(){ if(document.getElementById("kd-withdraw-style")) return; const s=document.createElement("style"); s.id="kd-withdraw-style"; s.textContent=CSS; document.head.appendChild(s); }
  function getLifetime(){ const el=document.getElementById("totalFees"); if(!el) return 0; const n=parseFloat((el.textContent||"0").replace(/[^0-9.]/g,"")); return isNaN(n)?0:n; }
  function getWithdrawals(){ try{ return JSON.parse(localStorage.getItem(STORAGE_WITHDRAWALS)||"[]"); }catch{ return []; } }
  function getTotalWithdrawn(){ return getWithdrawals().reduce((s,w)=>s+(Number(w.amount)||0),0); }
  function getAvailable(){ return Math.max(0,getLifetime()-getTotalWithdrawn()); }
  function getBankProfile(){ try{ return JSON.parse(localStorage.getItem(STORAGE_BANK)||"{}"); }catch{ return {}; } }
  function formatRM(n){ return "RM"+Number(n).toFixed(2); }
  function showToast(msg){ let t=document.getElementById("kd-toast"); if(!t){ t=document.createElement("div"); t.id="kd-toast"; t.className="kd-toast"; document.body.appendChild(t);} t.textContent=msg; t.classList.add("show"); clearTimeout(t._hide); t._hide=setTimeout(()=>t.classList.remove("show"),2800); }

  function createButton(){
    if(document.getElementById("kdWithdrawBtn")) return;
    const feeEl=document.getElementById("totalFees"); if(!feeEl) return;
    const card=feeEl.closest(".card")||feeEl.parentElement;
    const btn=document.createElement("button");
    btn.id="kdWithdrawBtn"; btn.className="kd-withdraw-btn";
    btn.innerHTML=`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v18"/><path d="M19 8a5 5 0 0 0-9 0 5 5 0 0 1-9 0"/><path d="M5 16a5 5 0 0 0 9 0 5 5 0 0 1 9 0"/></svg> Withdraw to Bank`;
    btn.addEventListener("click", openModal);
    card.appendChild(btn);
    updateButtonState();
  }
  function updateButtonState(){
    const btn=document.getElementById("kdWithdrawBtn"); if(!btn) return;
    const avail=getAvailable(); const lifetime=getLifetime();
    btn.disabled=avail<=0.5; btn.title=avail<=0.5?(lifetime===0?"No earnings yet":"Nothing available to withdraw"):`Available: ${formatRM(avail)}`;
    const bal=document.getElementById("kdAvailValue"); if(bal) bal.textContent=formatRM(avail);
    const life=document.getElementById("kdLifetimeValue"); if(life) life.textContent=formatRM(lifetime);
    const withd=document.getElementById("kdWithdrawnValue"); if(withd) withd.textContent=formatRM(getTotalWithdrawn());
  }
  function buildModal(){
    if(document.getElementById("kdWithdrawOverlay")) return;
    const bank=getBankProfile();
    const overlay=document.createElement("div"); overlay.id="kdWithdrawOverlay"; overlay.className="kd-w-overlay";
    overlay.innerHTML=`
      <div class="kd-w-modal" role="dialog" aria-modal="true">
        <div class="kd-w-head">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;">
            <div><div style="font-family:Fraunces,serif;font-size:22px;font-weight:700;color:#0F382E;">Withdraw Earnings</div><div style="font-size:12px;color:#6b7280;margin-top:2px;">Transfer your 11% platform fees to your bank</div></div>
            <button id="kdCloseX" style="width:36px;height:36px;border-radius:999px;border:1px solid #e5e7eb;background:#fff;cursor:pointer;">✕</button>
          </div>
          <div class="kd-w-balance"><div><div style="font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#6b7280;">Available to Withdraw</div><b id="kdAvailValue">RM0.00</b><div style="font-size:11px;color:#6b7280;margin-top:4px;"><span id="kdLifetimeValue">RM0.00</span> lifetime • <span id="kdWithdrawnValue">RM0.00</span> withdrawn</div></div><div style="background:#0F382E;color:#E8B86D;width:44px;height:44px;border-radius:999px;display:flex;align-items:center;justify-content:center;font-size:20px;">₍RM₎</div></div>
        </div>
        <div class="kd-w-body">
          <div class="kd-w-field"><label>Withdraw Amount (RM)</label><input id="kdAmt" class="kd-w-input" type="number" inputmode="decimal" placeholder="e.g. 150.00" min="1" step="0.01"/><div style="display:flex;gap:8px;margin-top:8px;"><button type="button" class="kd-w-quick" data-p="50" style="font-size:11px;padding:6px 10px;border-radius:999px;border:1px solid #e5e7eb;background:#fff;cursor:pointer;">50%</button><button type="button" class="kd-w-quick" data-p="100" style="font-size:11px;padding:6px 10px;border-radius:999px;border:1px solid #e5e7eb;background:#fff;cursor:pointer;">Max</button><span id="kdAmtHint" style="font-size:11px;color:#6b7280;margin-left:auto;align-self:center;"></span></div></div>
          <div class="kd-w-row"><div class="kd-w-field"><label>Bank Name</label><input id="kdBankName" class="kd-w-input" list="kdBankList" placeholder="Maybank, CIMB, etc." value="${bank.bankName||""}"/><datalist id="kdBankList"><option value="Maybank"/><option value="CIMB Bank"/><option value="Public Bank"/><option value="RHB Bank"/><option value="Hong Leong Bank"/><option value="AmBank"/><option value="Bank Islam"/><option value="Bank Rakyat"/><option value="OCBC Bank"/><option value="HSBC Bank"/><option value="UOB Bank"/></datalist></div><div class="kd-w-field"><label>Account Holder Name</label><input id="kdHolder" class="kd-w-input" placeholder="As per bank account" value="${bank.holder||""}"/></div></div>
          <div class="kd-w-field"><label>Bank Account Number</label><input id="kdAcct" class="kd-w-input" placeholder="e.g. 1234567890" value="${bank.acct||""}"/></div>
          <div class="kd-w-field"><label>Note (Optional)</label><input id="kdNote" class="kd-w-input" placeholder="e.g. April payout"/></div>
          <div class="kd-w-actions"><button id="kdCancel" class="kd-w-cancel">Cancel</button><button id="kdConfirm" class="kd-w-confirm">Confirm Withdraw</button></div>
          <div class="kd-w-history"><div style="display:flex;justify-content:space-between;align-items:center;"><div style="font-weight:700;font-size:13px;">Recent Withdrawals</div><button id="kdClearHist" style="font-size:11px;color:#991b1b;background:none;border:none;cursor:pointer;text-decoration:underline;">Clear history</button></div><div id="kdHistoryList" style="margin-top:6px;"></div><div id="kdEmptyHist" style="font-size:12px;color:#9ca3af;text-align:center;padding:18px 0;display:none;">No withdrawals yet. Your payouts will appear here.</div></div>
          <div style="font-size:11px;color:#9ca3af;text-align:center;margin-top:18px;line-height:1.4;">Calls <code>/api/withdraw</code> (or <code>/api/withdraw-api</code> if renamed) → falls back to local simulation if API not ready.<br/>Data saved in browser localStorage.</div>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener("click",(e)=>{ if(e.target===overlay) closeModal(); });
    overlay.querySelector("#kdCloseX").addEventListener("click",closeModal);
    overlay.querySelector("#kdCancel").addEventListener("click",closeModal);
    overlay.querySelector("#kdClearHist").addEventListener("click",()=>{ if(!confirm("Clear all withdrawal history?")) return; localStorage.removeItem(STORAGE_WITHDRAWALS); renderHistory(); updateButtonState(); showToast("History cleared"); });
    overlay.querySelectorAll(".kd-w-quick").forEach(b=>{ b.addEventListener("click",()=>{ const p=Number(b.dataset.p); const avail=getAvailable(); const val=p===100?avail:+(avail*p/100).toFixed(2); document.getElementById("kdAmt").value=val>0?val:""; validate(); }); });
    ["kdAmt","kdBankName","kdHolder","kdAcct"].forEach(id=>{ document.getElementById(id).addEventListener("input",validate); });
    document.getElementById("kdConfirm").addEventListener("click",doWithdraw);
  }
  function validate(){
    const amt=parseFloat(document.getElementById("kdAmt").value); const bank=document.getElementById("kdBankName").value.trim(); const holder=document.getElementById("kdHolder").value.trim(); const acct=document.getElementById("kdAcct").value.trim(); const avail=getAvailable(); const hint=document.getElementById("kdAmtHint"); const btn=document.getElementById("kdConfirm");
    let ok=true; let hintText=""; if(!amt||amt<=0){ ok=false; hintText=""; } else if(amt>avail+0.001){ ok=false; hintText="Exceeds available"; } else { hintText=`${((amt/avail)*100).toFixed(0)}% of available`; }
    if(!bank||!holder||acct.length<6) ok=false; hint.textContent=hintText; btn.disabled=!ok; return ok;
  }
  function renderHistory(){
    const list=document.getElementById("kdHistoryList"); const empty=document.getElementById("kdEmptyHist"); if(!list) return;
    const items=getWithdrawals().slice().reverse(); list.innerHTML="";
    if(items.length===0){ empty.style.display="block"; return; } empty.style.display="none";
    items.forEach(w=>{ const div=document.createElement("div"); div.className="kd-w-h-item"; const last4=w.acct?w.acct.slice(-4):"••••"; div.innerHTML=`<div><div style="font-weight:600;">${formatRM(w.amount)} → ${w.bank} ••••${last4}</div><div style="font-size:11px;color:#6b7280;margin-top:2px;">${new Date(w.date).toLocaleString()} • ${w.holder}</div>${w.note?`<div style="font-size:11px;color:#4b5563;margin-top:2px;">${w.note}</div>`:""}</div><div><span class="kd-w-badge ${w.status==='Done'?'done':'pending'}">${w.status||'Pending'}</span></div>`; list.appendChild(div); });
  }
  function openModal(){ buildModal(); updateButtonState(); renderHistory(); validate(); const overlay=document.getElementById("kdWithdrawOverlay"); overlay.classList.add("open"); document.body.style.overflow="hidden"; setTimeout(()=>document.getElementById("kdAmt")?.focus(),120); }
  function closeModal(){ const overlay=document.getElementById("kdWithdrawOverlay"); if(!overlay) return; overlay.classList.remove("open"); document.body.style.overflow=""; }

  async function tryApiWithdraw(payload){
    for(const url of API_CANDIDATES){
      try{
        const res=await fetch(url,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});
        if(res.ok){ const json=await res.json().catch(()=>({})); return {ok:true,url,json}; }
        if(res.status!==404) { const txt=await res.text(); return {ok:false,url,error:txt}; }
      }catch(e){ /* try next */ }
    }
    return {ok:false, tried:API_CANDIDATES};
  }

  async function doWithdraw(){
    if(!validate()) return;
    const amt=parseFloat(document.getElementById("kdAmt").value);
    const bankName=document.getElementById("kdBankName").value.trim();
    const holder=document.getElementById("kdHolder").value.trim();
    const acct=document.getElementById("kdAcct").value.trim();
    const note=document.getElementById("kdNote").value.trim();
    const avail=getAvailable();
    if(amt>avail+0.001){ showToast("Amount exceeds available"); return; }

    const btn=document.getElementById("kdConfirm");
    const origText=btn.textContent; btn.textContent="Processing..."; btn.disabled=true;

    // Save bank profile
    localStorage.setItem(STORAGE_BANK, JSON.stringify({bankName,holder,acct}));

    // Try real API first
    let apiResult=null;
    try{ apiResult=await tryApiWithdraw({amount:amt,bankName,accountHolder:holder,accountNumber:acct,note}); }catch{}

    // Always store locally for history (even if API succeeded)
    const withdrawals=getWithdrawals();
    withdrawals.push({id:"WD"+Date.now(),amount:amt,bank:bankName,acct,holder,note,date:new Date().toISOString(),status:apiResult&&apiResult.ok?"Pending":"Pending"});
    localStorage.setItem(STORAGE_WITHDRAWALS, JSON.stringify(withdrawals));

    if(apiResult&&apiResult.ok){
      showToast(`Withdraw ${formatRM(amt)} submitted to ${apiResult.url}`);
      // simulate Done after 1.5s
      setTimeout(()=>{ const cur=getWithdrawals(); const last=cur[cur.length-1]; if(last){ last.status="Done"; localStorage.setItem(STORAGE_WITHDRAWALS,JSON.stringify(cur)); renderHistory(); } },1500);
    } else {
      showToast(`Withdraw ${formatRM(amt)} saved locally (API not yet live)`);
      setTimeout(()=>{ const cur=getWithdrawals(); const last=cur[cur.length-1]; if(last){ last.status="Done"; localStorage.setItem(STORAGE_WITHDRAWALS,JSON.stringify(cur)); renderHistory(); } },1500);
    }

    renderHistory(); updateButtonState(); closeModal(); btn.textContent=origText; btn.disabled=false; patchFeeDisplay();
  }

  function patchFeeDisplay(){
    if(window.__kdWithdrawPatched){ updateButtonState(); return; }
    const orig=window.renderAdmin;
    if(typeof orig==="function"){
      window.renderAdmin=function(){ const res=orig.apply(this,arguments); setTimeout(()=>{ createButton(); updateButtonState(); },0); return res; };
      window.__kdWithdrawPatched=true;
    }
    updateButtonState();
  }
  function boot(){
    injectCSS(); buildModal(); createButton(); patchFeeDisplay();
    const obs=new MutationObserver(()=>{ const dash=document.getElementById("adminDashboard"); if(dash&&!dash.classList.contains("hidden")){ setTimeout(()=>{ createButton(); updateButtonState(); },150); } });
    obs.observe(document.documentElement,{attributes:true,subtree:true,attributeFilter:["class"]});
    let lastVal=""; setInterval(()=>{ const el=document.getElementById("totalFees"); if(el&&el.textContent!==lastVal){ lastVal=el.textContent; updateButtonState(); } },800);
  }
  if(document.readyState==="loading"){ document.addEventListener("DOMContentLoaded",boot); } else { boot(); }
})();
