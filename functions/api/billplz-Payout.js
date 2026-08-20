// /api/billplz-payout - Auto payout owner share directly
export async function onRequestPost(context) {
  try {
    const body = await context.request.json();
    const { bookingId, ownerBankName, ownerBankAccount, ownerBankHolder, ownerAmount, platformFee, homestayName, guestName } = body;
    const apiKey = context.env.BILLPLZ_API_KEY;
    if (!apiKey) {
      return new Response(JSON.stringify({ 
        simulated: true, 
        message: `SIMULATED: Would payout RM${ownerAmount} to ${ownerBankHolder} (${ownerBankName} ${ownerBankAccount}) for booking ${bookingId}. Platform keeps RM${platformFee}`,
        bookingId,
        ownerAmount,
        platformFee
      }), { headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" } });
    }
    const auth = btoa(`${apiKey}:`);
    const payload = {
      bank_code: mapBank(ownerBankName),
      bank_account_number: ownerBankAccount,
      name: ownerBankHolder,
      amount: Math.round(ownerAmount * 100),
      description: `Payout ${homestayName} Booking ${bookingId} Guest ${guestName}`,
      reference_id: bookingId
    };
    const res = await fetch("https://www.billplz.com/api/v3/mass_payment_instruction", {
      method: "POST",
      headers: { "Authorization": `Basic ${auth}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const result = await res.json();
    return new Response(JSON.stringify({ success: res.ok, bookingId, payout: `RM${ownerAmount} to ${ownerBankHolder}`, result }), { headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" } });
  } catch(e){
    return new Response(JSON.stringify({ error: e.message }), { status:500, headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" } });
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
  return "MBBEMYKL";
}
export async function onRequestOptions(){ return new Response(null, { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" } }); }
