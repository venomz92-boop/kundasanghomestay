// /api/billplz-withdraw - Withdraw platform fee balance to admin bank, admin pays Billplz charge
export async function onRequestPost(context) {
  try {
    const body = await context.request.json();
    const { amount, bankName, bankAccount, bankHolder, description } = body;
    
    if (!amount || amount <=0) {
      return new Response(JSON.stringify({ error: "Invalid amount" }), { status:400, headers: corsJson() });
    }

    const apiKey = context.env.BILLPLZ_API_KEY;
    
    // Simulation mode if no API key (while waiting Billplz approval)
    if (!apiKey) {
      return new Response(JSON.stringify({
        simulated: true,
        success: true,
        message: `SIMULATED: Would withdraw RM${amount} to ${bankHolder} (${bankName} ${bankAccount}). Billplz charge RM1.50 will be deducted, you receive RM${(amount-1.5).toFixed(2)}`,
        amount,
        netReceive: amount - 1.5,
        billplzFee: 1.5
      }), { headers: corsJson() });
    }

    // Real Billplz Mass Payment for admin withdrawal
    const auth = btoa(`${apiKey}:`);
    const payload = {
      bank_code: mapBank(bankName),
      bank_account_number: String(bankAccount||"").replace(/[^0-9]/g, ""),
      name: bankHolder,
      amount: Math.round(amount * 100), // cents
      description: description || `Platform fee withdrawal RM${amount}`,
      reference_id: `WD-${Date.now()}`
    };

    const res = await fetch("https://www.billplz.com/api/v3/mass_payment_instruction", {
      method: "POST",
      headers: {
        "Authorization": `Basic ${auth}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const result = await res.json();

    if (!res.ok) {
      return new Response(JSON.stringify({ success:false, error: result, amount }), { status:400, headers: corsJson() });
    }

    return new Response(JSON.stringify({
      success: true,
      message: `SUCCESS: RM${amount} withdrawal to ${bankHolder} initiated. Billplz fee will be deducted.`,
      amount,
      result
    }), { headers: corsJson() });

  } catch(e){
    return new Response(JSON.stringify({ error: e.message }), { status:500, headers: corsJson() });
  }
}

function mapBank(n){
  if(!n) return "MBBEMYKL";
  const s=n.toLowerCase();
  if(s.includes("maybank")) return "MBBEMYKL";
  if(s.includes("cimb")) return "CIBBMYKL";
  if(s.includes("public")) return "PBBEMYKL";
  if(s.includes("rhb")) return "RHBBMYKL";
  if(s.includes("hong")) return "HLBBMYKL";
  if(s.includes("am")) return "ARBKMYKL";
  if(s.includes("bsn")) return "BSNAMYK1";
  if(s.includes("islam")) return "BIMBMYKL";
  if(s.includes("rakyat")) return "BKRMMYKL";
  return "MBBEMYKL";
}
function corsJson(){ return { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }; }
export async function onRequestOptions(){ return new Response(null, { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" } }); }
