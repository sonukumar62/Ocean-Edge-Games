import { Router } from 'express';
import { createHmac, timingSafeEqual, createHash, randomUUID } from 'node:crypto';
import Razorpay from 'razorpay';
import { z } from 'zod';
import multer from 'multer';
import { query, withTransaction } from '../config/db.js';
import { requireAdmin, requirePlayer } from '../middleware/auth.js';
import { isRefundEligible } from '../domain/progression.js';
import { recordAudit, notifyAdmin } from '../services/audit.js';
import { signedAssetUrl, uploadProfileAsset, removeProfileAsset } from '../services/storage.js';

export const paymentsRouter = Router();
export const razorpayWebhookRouter = Router();
const uploadImage=multer({storage:multer.memoryStorage(),limits:{fileSize:4*1024*1024,files:1}});
const uploadSingle=field=>(req,res,next)=>uploadImage.single(field)(req,res,error=>{
  if(!error)return next();
  if(error.code==='LIMIT_FILE_SIZE')return res.status(413).json({error:'Image is too large. Maximum allowed size is 4 MB.'});
  return res.status(400).json({error:'Choose one valid image file.'});
});
function imageType(buffer){
  if(buffer.length>=8&&buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return {mime:'image/png',ext:'png'};
  if(buffer.length>=3&&buffer[0]===0xff&&buffer[1]===0xd8&&buffer[2]===0xff)return {mime:'image/jpeg',ext:'jpg'};
  if(buffer.length>=12&&buffer.toString('ascii',0,4)==='RIFF'&&buffer.toString('ascii',8,12)==='WEBP')return {mime:'image/webp',ext:'webp'};
  return null;
}
const actorId=req=>req.session.user.id;
async function paymentConfig(){const r=await query("select value from site_settings where key='payment_configuration'");return r.rows[0]?.value||{method:'razorpay',upiId:'',qrPath:null};}

function gateway() {
  const id = process.env.RAZORPAY_KEY_ID;
  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (process.env.RAZORPAY_MODE !== 'test' || !id?.startsWith('rzp_test_') || !secret) {
    const error = new Error('Online payment is temporarily unavailable. Your entry is saved as pending payment; try again later from Payments & rewards or contact tournament support.');
    error.status = 503;
    error.code = 'PAYMENTS_NOT_CONFIGURED';
    throw error;
  }
  return new Razorpay({ key_id: id, key_secret: secret });
}

function verifyHmac(secret, body, signature) {
  if (!secret || !signature) return false;
  const expected = createHmac('sha256', secret).update(body).digest();
  let received;
  try { received = Buffer.from(signature, 'hex'); } catch { return false; }
  return received.length === expected.length && timingSafeEqual(expected, received);
}

async function confirmRegistrationForCapturedPayment(client, registrationId) {
  const found=await client.query(`select r.id,r.status,r.payment_status,r.player_id,r.team_id,t.id tournament_id,t.capacity
    from tournament_registrations r join tournaments t on t.id=r.tournament_id where r.id=$1 for update of t,r`,[registrationId]);
  if(!found.rowCount)return;
  const r=found.rows[0];
  if(r.status!=='pending_payment'){
    if(r.payment_status==='paid')return;
    await notifyAdmin(client,'payment_reconciliation','Captured payment needs review','A captured payment belongs to a registration that is no longer awaiting payment.','/pass/ads/payments');
    await client.query(`insert into notifications(user_id,kind,title,body,href) select rp.user_id,'payment','Payment needs support','Your payment was captured, but the registration is no longer active. Contact support so the team can review it.','/support' from registration_participants rp where rp.registration_id=$1`,[registrationId]);
    return;
  }
  const count=await client.query("select count(*)::int n from tournament_registrations where tournament_id=$1 and status='confirmed'",[r.tournament_id]);
  const full=r.capacity&&Number(count.rows[0].n)>=Number(r.capacity);
  const status=full?'waitlisted':'confirmed';
  await client.query('update tournament_registrations set status=$2,payment_status=\'paid\',reserved_until=null,updated_at=now() where id=$1',[registrationId,status]);
  if(full)await notifyAdmin(client,'payment_reconciliation','Paid entry needs review','A captured payment arrived after the reserved capacity was filled.','/pass/ads/payments');
  const participants=await client.query('select user_id from registration_participants where registration_id=$1',[registrationId]);
  for(const participant of participants.rows)await client.query(`insert into notifications(user_id,kind,title,body,href) values($1,'payment',$2,$3,'/tournaments')`,[participant.user_id,full?'Payment received — entry waitlisted':'Entry fee paid',full?'Your payment was captured after tournament capacity filled. Support will help resolve the entry.':'Your tournament payment was verified.']);
}

paymentsRouter.get('/checkout/:registrationId',requirePlayer,async(req,res)=>{
  const id=z.string().uuid().safeParse(req.params.registrationId);if(!id.success)return res.status(400).json({error:'Invalid registration.'});
  const r=await query(`select r.id,r.registration_number,r.status,r.payment_status,r.payment_method,r.payment_qr_path,r.payment_upi_id,r.reserved_until,t.name tournament_name,t.entry_fee_paise
    from tournament_registrations r join tournaments t on t.id=r.tournament_id where r.id=$1 and (r.player_id=$2 or exists(select 1 from registration_participants rp where rp.registration_id=r.id and rp.user_id=$2))`,[id.data,actorId(req)]);
  if(!r.rowCount)return res.status(404).json({error:'Registration not found.'});const row=r.rows[0];
  let qrUrl=null;if(row.payment_method==='manual'&&row.payment_qr_path)qrUrl=await signedAssetUrl(row.payment_qr_path);
  res.json({registrationId:row.id,registrationNumber:row.registration_number,status:row.status,paymentStatus:row.payment_status,paymentMethod:row.payment_method,amountPaise:Number(row.entry_fee_paise),tournamentName:row.tournament_name,upiId:row.payment_method==='manual'?row.payment_upi_id:null,qrUrl});
});

paymentsRouter.post('/orders', requirePlayer, async (req, res) => {
  const parsed = z.object({ registrationId: z.string().uuid() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'A valid registration is required.' });
  const registration = await query(`select r.id,r.reference,r.status,r.payment_status,r.payment_method,r.reserved_until,t.name tournament_name,t.entry_fee_paise
    from tournament_registrations r join tournaments t on t.id=r.tournament_id
    where r.id=$1 and (r.player_id=$2 or exists(select 1 from registration_participants rp where rp.registration_id=r.id and rp.user_id=$2))`, [parsed.data.registrationId, req.session.user.id]);
  if (!registration.rowCount) return res.status(404).json({ error: 'Registration not found.' });
  const row = registration.rows[0];
  if(row.payment_method!=='razorpay')return res.status(409).json({error:'This registration uses manual UPI payment. Continue from the QR payment screen.'});
  if (row.status !== 'pending_payment' || !['pending','failed'].includes(row.payment_status) || !row.reserved_until || new Date(row.reserved_until) <= new Date()) return res.status(409).json({ error: 'The payment reservation expired or is no longer payable.' });
  if (Number(row.entry_fee_paise) <= 0) return res.status(400).json({ error: 'This registration does not require payment.' });
  try {
    const razorpay = gateway();
    const prior=await query("select order_id from payments where registration_id=$1 and status='created' order by created_at desc limit 1",[row.id]);
    const order=prior.rowCount?await razorpay.orders.fetch(prior.rows[0].order_id):await razorpay.orders.create({ amount: Number(row.entry_fee_paise), currency: 'INR', receipt: row.reference, notes: { registrationId: row.id } });
    if(!prior.rowCount){await query(`insert into payments(registration_id,order_id,amount_paise,currency,status,payment_method) values($1,$2,$3,'INR','created','razorpay')`, [row.id, order.id, Number(row.entry_fee_paise)]);await query("update tournament_registrations set payment_status='pending',updated_at=now() where id=$1 and status='pending_payment'",[row.id]);}
    res.status(201).json({ order: { id: order.id, amount: order.amount, currency: order.currency, keyId: process.env.RAZORPAY_KEY_ID, tournamentName: row.tournament_name } });
  } catch (error) { throw error; }
});

paymentsRouter.post('/manual/submit',requirePlayer,uploadSingle('proof'),async(req,res)=>{
  const parsed=z.object({registrationId:z.string().uuid()}).safeParse(req.body);if(!parsed.success)return res.status(400).json({error:'A valid registration is required.'});
  const file=req.file;if(!file)return res.status(400).json({error:'Upload a screenshot of your completed UPI payment.'});const detected=imageType(file.buffer);if(!detected||detected.mime!==file.mimetype)return res.status(400).json({error:'Use a valid PNG, JPEG, or WebP image (up to 4 MB).'});
  const path=`payments/proofs/${randomUUID()}.${detected.ext}`;await uploadProfileAsset(path,file.buffer,detected.mime);
  try{
    const result=await withTransaction(async(client)=>{
      const found=await client.query(`select r.id,r.status,r.payment_status,r.payment_method,r.reserved_until,t.entry_fee_paise from tournament_registrations r join tournaments t on t.id=r.tournament_id where r.id=$1 and (r.player_id=$2 or exists(select 1 from registration_participants rp where rp.registration_id=r.id and rp.user_id=$2)) for update of r`,[parsed.data.registrationId,actorId(req)]);
      if(!found.rowCount)return {error:'Registration not found.',status:404};const r=found.rows[0];
      if(r.payment_method!=='manual')return {error:'This registration is not configured for manual payment.',status:409};
      if(r.status!=='pending_payment'||!['pending','failed','rejected'].includes(r.payment_status))return {error:'This registration cannot accept another payment proof.',status:409};
      if(!r.reserved_until||new Date(r.reserved_until)<=new Date())return {error:'The registration reservation expired. Contact tournament support before submitting payment.',status:409};
      const payment=await client.query(`insert into payments(registration_id,provider,amount_paise,currency,status,payment_method) values($1,'upi_manual',$2,'INR','pending_verification','manual') returning id,amount_paise,status,created_at`,[r.id,r.entry_fee_paise]);
      const proof=await client.query(`insert into manual_payment_proofs(payment_id,storage_path,mime_type,byte_size,submitted_by) values($1,$2,$3,$4,$5) returning id,submitted_at`,[payment.rows[0].id,path,detected.mime,file.size,actorId(req)]);
      await client.query("update tournament_registrations set payment_status='pending_verification',reserved_until=null,updated_at=now() where id=$1",[r.id]);
      await notifyAdmin(client,'manual_payment','Manual payment needs verification',`A player submitted payment proof for registration ${r.id}.`,'/pass/ads/payments');
      await client.query(`insert into notifications(user_id,kind,title,body,href) select rp.user_id,'payment','Payment pending verification','Your payment proof was submitted. Your registration will be confirmed after an administrator verifies receipt.','/payments' from registration_participants rp where rp.registration_id=$1`,[r.id]);
      return {payment:payment.rows[0],proofId:proof.rows[0].id};
    });
    if(result.error){await removeProfileAsset(path);return res.status(result.status).json({error:result.error});}
    res.status(201).json({status:'pending_verification',paymentId:result.payment.id});
  }catch(error){await removeProfileAsset(path).catch(()=>{});throw error;}
});

paymentsRouter.get('/admin/config',requireAdmin,async(req,res)=>{
  const config=await paymentConfig();const razorpayAvailable=process.env.RAZORPAY_MODE==='test'&&!!process.env.RAZORPAY_KEY_ID?.startsWith('rzp_test_')&&!!process.env.RAZORPAY_KEY_SECRET;
  res.json({method:config.method||'razorpay',upiId:config.upiId||'',qrUrl:config.qrPath?await signedAssetUrl(config.qrPath):null,razorpayAvailable});
});
paymentsRouter.patch('/admin/config',requireAdmin,async(req,res)=>{
  const parsed=z.object({method:z.enum(['razorpay','manual']),upiId:z.string().trim().max(120).optional()}).safeParse(req.body);if(!parsed.success)return res.status(400).json({error:'Choose a payment method and enter a valid UPI ID.'});
  if(parsed.data.method==='manual'&&(!parsed.data.upiId||!/^[-a-zA-Z0-9._]{2,256}@[a-zA-Z]{2,64}$/.test(parsed.data.upiId)))return res.status(400).json({error:'Enter a valid UPI ID before enabling QR payments.'});
  if(parsed.data.method==='manual'&&!(await paymentConfig()).qrPath)return res.status(409).json({error:'Upload a payment QR code before enabling manual payments.'});
  if(parsed.data.method==='razorpay'&&!(process.env.RAZORPAY_MODE==='test'&&process.env.RAZORPAY_KEY_ID?.startsWith('rzp_test_')&&process.env.RAZORPAY_KEY_SECRET))return res.status(409).json({error:'Razorpay test credentials are not configured on the server.'});
  const saved=await withTransaction(async(client)=>{const prev=await client.query("select value from site_settings where key='payment_configuration' for update");const config={...(prev.rows[0]?.value||{}),method:parsed.data.method,upiId:parsed.data.upiId||prev.rows[0]?.value?.upiId||''};await client.query("insert into site_settings(key,value,updated_by) values('payment_configuration',$1::jsonb,$2) on conflict(key) do update set value=excluded.value,updated_by=excluded.updated_by,updated_at=now()",[JSON.stringify(config),actorId(req)]);await recordAudit(client,actorId(req),'payment_method_changed','site_setting','payment_configuration',{method:config.method});return config;});
  res.json({method:saved.method,upiId:saved.upiId,qrUrl:saved.qrPath?await signedAssetUrl(saved.qrPath):null});
});
paymentsRouter.post('/admin/config/qr',requireAdmin,uploadSingle('qr'),async(req,res)=>{
  const file=req.file;if(!file)return res.status(400).json({error:'Choose a QR image to upload.'});const detected=imageType(file.buffer);if(!detected||detected.mime!==file.mimetype)return res.status(400).json({error:'Use a valid PNG, JPEG, or WebP image (up to 4 MB).'});
  const path=`payments/qr/${randomUUID()}.${detected.ext}`;await uploadProfileAsset(path,file.buffer,detected.mime);
  try{const old=await withTransaction(async(client)=>{const r=await client.query("select value from site_settings where key='payment_configuration' for update");const config={...(r.rows[0]?.value||{}),method:r.rows[0]?.value?.method||'razorpay',qrPath:path};await client.query("insert into site_settings(key,value,updated_by) values('payment_configuration',$1::jsonb,$2) on conflict(key) do update set value=excluded.value,updated_by=excluded.updated_by,updated_at=now()",[JSON.stringify(config),actorId(req)]);await recordAudit(client,actorId(req),'payment_qr_uploaded','site_setting','payment_configuration',{mimeType:detected.mime,byteSize:file.size});return r.rows[0]?.value?.qrPath||null;});res.status(201).json({qrUrl:await signedAssetUrl(path)});if(old){const stillUsed=await query('select 1 from tournament_registrations where payment_qr_path=$1 limit 1',[old]);if(!stillUsed.rowCount)await removeProfileAsset(old).catch(()=>{});}}
  catch(error){await removeProfileAsset(path).catch(()=>{});throw error;}
});
paymentsRouter.delete('/admin/config/qr',requireAdmin,async(req,res)=>{
  const old=await withTransaction(async(client)=>{const r=await client.query("select value from site_settings where key='payment_configuration' for update");const config=r.rows[0]?.value||{};const path=config.qrPath||null;config.qrPath=null;await client.query("update site_settings set value=$1::jsonb,updated_by=$2,updated_at=now() where key='payment_configuration'",[JSON.stringify(config),actorId(req)]);await recordAudit(client,actorId(req),'payment_qr_removed','site_setting','payment_configuration');return path;});
  if(old){const used=await query('select 1 from tournament_registrations where payment_qr_path=$1 limit 1',[old]);if(!used.rowCount)await removeProfileAsset(old);}res.json({ok:true});
});

paymentsRouter.get('/admin/manual',requireAdmin,async(req,res)=>{
  const rows=await query(`select mp.id proof_id,mp.review_status,mp.review_reason,mp.submitted_at,mp.storage_path,mp.mime_type,
    p.id payment_id,p.amount_paise,p.status payment_status,r.id registration_id,r.registration_number,pf.upi_id player_upi_id,
    t.name tournament_name,u.email,pf.username,pf.full_name
    from manual_payment_proofs mp join payments p on p.id=mp.payment_id join tournament_registrations r on r.id=p.registration_id
    join tournaments t on t.id=r.tournament_id left join users u on u.id=mp.submitted_by left join player_profiles pf on pf.user_id=mp.submitted_by
    where mp.review_status in ('pending','rejected','verified') order by (mp.review_status='pending') desc,mp.submitted_at desc limit 200`);
  const data=await Promise.all(rows.rows.map(async row=>({...row,proof_url:row.storage_path?await signedAssetUrl(row.storage_path):null})));res.json({data});
});
paymentsRouter.patch('/admin/manual/:proofId',requireAdmin,async(req,res)=>{
  const parsed=z.object({action:z.enum(['approve','reject']),reason:z.string().trim().min(5).max(500).optional()}).safeParse(req.body);if(!parsed.success||parsed.data.action==='reject'&&!parsed.data.reason)return res.status(400).json({error:'Choose approve or provide a rejection reason (at least 5 characters).'});
  const out=await withTransaction(async(client)=>{
    const found=await client.query(`select mp.id,mp.review_status,mp.payment_id,p.registration_id,p.status payment_status,r.status registration_status,r.payment_status registration_payment_status,r.tournament_id,t.capacity
      from manual_payment_proofs mp join payments p on p.id=mp.payment_id join tournament_registrations r on r.id=p.registration_id join tournaments t on t.id=r.tournament_id where mp.id=$1 for update of mp,p,r,t`,[req.params.proofId]);
    if(!found.rowCount)return {error:'Payment proof not found.',status:404};const row=found.rows[0];if(row.review_status!=='pending'||row.payment_status!=='pending_verification'||row.registration_status!=='pending_payment'||row.registration_payment_status!=='pending_verification')return {error:'This proof has already been reviewed or its registration is no longer pending.',status:409};
    if(parsed.data.action==='approve'){
      const count=await client.query("select count(*)::int n from tournament_registrations where tournament_id=$1 and status='confirmed'",[row.tournament_id]);const full=row.capacity&&Number(count.rows[0].n)>=Number(row.capacity);const entryStatus=full?'waitlisted':'confirmed';
      await client.query("update manual_payment_proofs set review_status='verified',review_reason=null,reviewed_by=$2,reviewed_at=now() where id=$1",[row.id,actorId(req)]);await client.query("update payments set status='verified',updated_at=now() where id=$1",[row.payment_id]);await client.query("update tournament_registrations set status=$2,payment_status='paid',reserved_until=null,updated_at=now() where id=$1",[row.registration_id,entryStatus]);
      await client.query(`insert into notifications(user_id,kind,title,body,href) select rp.user_id,'payment','Payment verified', $2,'/payments' from registration_participants rp where rp.registration_id=$1`,[row.registration_id,full?'Your manual payment was verified. Tournament capacity is full, so your entry is waitlisted; contact support for next steps.':'Your manual payment was verified and your tournament entry is confirmed.']);
      await recordAudit(client,actorId(req),'manual_payment_approved','manual_payment_proof',row.id,{paymentId:row.payment_id,registrationId:row.registration_id});return {status:'verified'};
    }
    await client.query("update manual_payment_proofs set review_status='rejected',review_reason=$2,reviewed_by=$3,reviewed_at=now() where id=$1",[row.id,parsed.data.reason,actorId(req)]);await client.query("update payments set status='failed',updated_at=now() where id=$1",[row.payment_id]);await client.query("update tournament_registrations set payment_status='rejected',reserved_until=now()+make_interval(mins=>$2),updated_at=now() where id=$1",[row.registration_id,Number(process.env.PAYMENT_RESERVATION_TTL_MINUTES||15)]);
    await client.query(`insert into notifications(user_id,kind,title,body,href) select rp.user_id,'payment','Payment proof rejected',$2,'/payments' from registration_participants rp where rp.registration_id=$1`,[row.registration_id,parsed.data.reason]);await recordAudit(client,actorId(req),'manual_payment_rejected','manual_payment_proof',row.id,{paymentId:row.payment_id,registrationId:row.registration_id,reason:parsed.data.reason});return {status:'rejected'};
  });if(out.error)return res.status(out.status).json({error:out.error});res.json(out);
});
paymentsRouter.delete('/admin/manual/:proofId',requireAdmin,async(req,res)=>{
  const out=await withTransaction(async(client)=>{const f=await client.query(`select mp.id,mp.review_status,mp.storage_path,mp.payment_id,p.registration_id,p.status payment_status,r.payment_status registration_payment_status,r.status registration_status from manual_payment_proofs mp join payments p on p.id=mp.payment_id join tournament_registrations r on r.id=p.registration_id where mp.id=$1 for update of mp,p,r`,[req.params.proofId]);if(!f.rowCount)return null;const x=f.rows[0];if(x.review_status==='deleted')return {error:'This payment screenshot was already deleted.',status:409};const path=x.storage_path;await client.query("update manual_payment_proofs set review_status='deleted',storage_path=null,reviewed_by=$2,reviewed_at=now(),deleted_at=now() where id=$1",[x.id,actorId(req)]);const verified=x.payment_status==='verified'||x.registration_payment_status==='paid';if(!verified){await client.query("update payments set status='failed',updated_at=now() where id=$1",[x.payment_id]);if(x.registration_status==='pending_payment')await client.query("update tournament_registrations set payment_status='failed',reserved_until=now()+make_interval(mins=>$2),updated_at=now() where id=$1",[x.registration_id,Number(process.env.PAYMENT_RESERVATION_TTL_MINUTES||15)]);}await recordAudit(client,actorId(req),'manual_payment_proof_deleted','manual_payment_proof',x.id,{paymentId:x.payment_id,registrationId:x.registration_id,verifiedEvidence:verified});return {path};});
  if(!out)return res.status(404).json({error:'Payment proof not found.'});if(out.error)return res.status(out.status).json({error:out.error});if(out.path)await removeProfileAsset(out.path);res.json({ok:true});
});

paymentsRouter.post('/verify', requirePlayer, async (req, res) => {
  const parsed = z.object({ razorpay_order_id: z.string().min(4).max(100), razorpay_payment_id: z.string().min(4).max(100), razorpay_signature: z.string().length(64) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Payment verification details are incomplete.' });
  try {
    const { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature } = parsed.data;
    const row = await query(`select p.id,p.registration_id,p.amount_paise,p.status,r.player_id,r.team_id,t.entry_fee_paise
      from payments p join tournament_registrations r on r.id=p.registration_id join tournaments t on t.id=r.tournament_id
      where p.order_id=$1 and p.provider='razorpay' and p.payment_method='razorpay' and r.payment_method='razorpay' and (r.player_id=$2 or exists(select 1 from registration_participants rp where rp.registration_id=r.id and rp.user_id=$2))`, [orderId, req.session.user.id]);
    if (!row.rowCount) return res.status(404).json({ error: 'Payment order not found.' });
    const valid = verifyHmac(process.env.RAZORPAY_KEY_SECRET, `${orderId}|${paymentId}`, signature);
    if (!valid) return res.status(400).json({ error: 'Payment signature is invalid.' });
    const razorpay = gateway();
    const providerPayment = await razorpay.payments.fetch(paymentId);
    if (providerPayment.order_id !== orderId || Number(providerPayment.amount) !== Number(row.rows[0].amount_paise) || providerPayment.status !== 'captured') return res.status(409).json({ error: 'The provider has not confirmed a captured payment for this order.' });
    await withTransaction(async (client) => {
      await client.query("update payments set payment_id=$2,status='captured',signature_verified_at=now(),updated_at=now() where id=$1 and status<>'captured'", [row.rows[0].id, paymentId]);
      await confirmRegistrationForCapturedPayment(client,row.rows[0].registration_id);
    });
    res.json({ status: 'captured' });
  } catch (error) { throw error; }
});

razorpayWebhookRouter.post('/', async (req, res) => {
  const body = req.body;
  const signature = req.get('x-razorpay-signature');
  const eventId = req.get('x-razorpay-event-id');
  if (!Buffer.isBuffer(body) || !verifyHmac(process.env.RAZORPAY_WEBHOOK_SECRET, body, signature)) return res.status(400).json({ error: 'Webhook signature is invalid.' });
  let event;
  try { event = JSON.parse(body.toString('utf8')); }
  catch { return res.status(400).json({ error: 'Webhook payload is invalid.' }); }
  if (!eventId) return res.status(400).json({ error: 'Webhook event identifier is missing.' });
  const refund = event.payload?.refund?.entity;
  if (refund?.id && ['refund.processed','refund.failed'].includes(event.event)) {
    await withTransaction(async (client) => {
      const result=await client.query(`update refunds set status=$2,webhook_event_id=$3,updated_at=now() where provider_refund_id=$1 and status='processing' and (webhook_event_id is null or webhook_event_id=$3) returning id,payment_id,status`,[refund.id,event.event==='refund.processed'?'completed':'failed',eventId]);
      if(!result.rowCount)return;
      if(result.rows[0].status==='completed')await client.query("update payments set status='refunded',updated_at=now() where id=$1 and amount_paise<=(select coalesce(sum(amount_paise),0) from refunds where payment_id=$1 and status='completed')",[result.rows[0].payment_id]);
      await notifyAdmin(client,'refund',`Refund ${result.rows[0].status}`,`Refund ${refund.id} was updated.`,'/pass/ads/payments');
    });
    return res.json({received:true});
  }
  const payment = event.payload?.payment?.entity;
  if (!payment?.order_id || !['payment.captured','payment.failed'].includes(event.event)) return res.json({ received: true, ignored: true });
  await withTransaction(async (client) => {
    const saved = await client.query("select id,registration_id,amount_paise,status from payments where order_id=$1 and payment_method='razorpay' and provider='razorpay' for update",[payment.order_id]);
    if(!saved.rowCount)return;
    const row=saved.rows[0];
    if(Number(payment.amount)!==Number(row.amount_paise))return;
    const eventSaved=await client.query(`insert into razorpay_webhook_events(event_id,event_type,order_id,payload_sha256) values($1,$2,$3,$4) on conflict(event_id) do nothing returning event_id`,[eventId,event.event,payment.order_id,createHash('sha256').update(body).digest('hex')]);
    if(!eventSaved.rowCount)return;
    const recorded=await client.query('update payments set webhook_event_id=coalesce(webhook_event_id,$2),payment_id=coalesce(payment_id,$3),status=case when status=\'captured\' then status when $4 then \'captured\' else \'failed\' end,updated_at=now() where id=$1 returning id,status',[row.id,eventId,payment.id||null,event.event==='payment.captured']);
    if(!recorded.rowCount)return;
    if(recorded.rows[0].status==='captured'){
      await confirmRegistrationForCapturedPayment(client,row.registration_id);
    }else{
      await client.query("update tournament_registrations set payment_status='failed',updated_at=now() where id=$1 and status='pending_payment'",[row.registration_id]);
      await client.query(`insert into notifications(user_id,kind,title,body,href) select rp.user_id,'payment','Payment failed','Your tournament payment did not complete. Try again before the reservation expires.','/tournaments' from registration_participants rp where rp.registration_id=$1`,[row.registration_id]);
    }
    await notifyAdmin(client,'payment',`Payment ${recorded.rows[0].status}`,`Payment order ${payment.order_id} was updated.`, '/pass/ads/payments');
  });
  res.json({ received: true });
});

paymentsRouter.post('/refund-requests', requirePlayer, async (req, res) => {
  const parsed=z.object({paymentId:z.string().uuid(),reason:z.string().trim().min(5).max(500)}).safeParse(req.body);
  if(!parsed.success)return res.status(400).json({error:'Provide a payment and refund reason.'});
  const result=await withTransaction(async(client)=>{
    const eligibility=await client.query(`select p.id,p.amount_paise,p.status,t.start_at
      from payments p join tournament_registrations r on r.id=p.registration_id join tournaments t on t.id=r.tournament_id
      where p.id=$1 and (r.player_id=$2 or exists(select 1 from registration_participants rp where rp.registration_id=r.id and rp.user_id=$2))
      for update of p,r,t`,[parsed.data.paymentId,req.session.user.id]);
    if(!eligibility.rowCount||eligibility.rows[0].status!=='captured')return {error:'Captured payment not found.',status:404};
    if(!isRefundEligible(eligibility.rows[0].start_at))return {error:'Entry-fee refunds are unavailable within the final 48 hours before the scheduled tournament start.',status:409};
    const prior=await client.query("select id from refunds where payment_id=$1 and status not in ('rejected','failed')",[parsed.data.paymentId]);
    if(prior.rowCount)return {error:'A refund request already exists for this payment.',status:409};
    const inserted=await client.query("insert into refunds(payment_id,amount_paise,reason) values($1,$2,$3) returning id,status",[eligibility.rows[0].id,eligibility.rows[0].amount_paise,parsed.data.reason]);
    await notifyAdmin(client,'refund','Refund request received','A player requested a tournament entry-fee refund.','/pass/ads/payments');
    return {refund:inserted.rows[0]};
  });
  if(result.error)return res.status(result.status||409).json({error:result.error});
  res.status(201).json(result);
});

paymentsRouter.get('/history', requirePlayer, async(req,res)=>{
  const result=await query(`select r.id registration_id,r.registration_number,r.status registration_status,r.payment_status registration_payment_status,r.payment_method,
    r.created_at registration_created_at,t.name tournament_name,t.entry_fee_paise,p.id payment_id,p.amount_paise,p.currency,p.status payment_attempt_status,p.created_at,
    latest.review_reason,latest.review_status,latest.storage_path,rf.status refund_status
    from tournament_registrations r join tournaments t on t.id=r.tournament_id
    left join payments p on p.registration_id=r.id
    left join lateral (select mp.review_reason,mp.review_status,mp.storage_path from manual_payment_proofs mp where mp.payment_id=p.id limit 1) latest on true
    left join refunds rf on rf.payment_id=p.id
    where r.player_id=$1 or exists(select 1 from registration_participants rp where rp.registration_id=r.id and rp.user_id=$1)
    order by coalesce(p.created_at,r.created_at) desc limit 100`,[req.session.user.id]);
  const data=await Promise.all(result.rows.map(async row=>({...row,amount_paise:Number(row.amount_paise??row.entry_fee_paise),proof_url:row.storage_path?await signedAssetUrl(row.storage_path):null})));res.json({data});
});

paymentsRouter.get('/admin', requireAdmin, async(req,res)=>{
  const [payments,refunds,payouts,cashRewards]=await Promise.all([
    query(`select p.id,p.order_id,p.payment_id,p.amount_paise,p.status,p.created_at,r.reference,t.name tournament_name,u.email from payments p join tournament_registrations r on r.id=p.registration_id join tournaments t on t.id=r.tournament_id left join users u on u.id=r.player_id order by p.created_at desc limit 200`),
    query('select rf.*,p.order_id,p.payment_id,t.name tournament_name from refunds rf join payments p on p.id=rf.payment_id join tournament_registrations r on r.id=p.registration_id join tournaments t on t.id=r.tournament_id order by rf.created_at desc limit 100'),
    query(`select pr.*,c.amount_paise reward_amount,t.name tournament_name,coalesce(p.username,team.name,'Team reward') recipient
      from payout_records pr join cash_reward_records c on c.id=pr.cash_reward_id join reward_transactions rt on rt.id=c.reward_transaction_id
      join match_results mr on mr.id=rt.result_id join matches m on m.id=mr.match_id join tournaments t on t.id=m.tournament_id
      left join player_profiles p on p.user_id=c.user_id left join teams team on team.id=c.team_id order by pr.created_at desc limit 100`),
    query(`select c.id,c.amount_paise,c.status,c.created_at,t.name tournament_name,coalesce(p.username,team.name,'Team reward') recipient,
      pr.id payout_id,pr.status payout_status,pr.provider_reference from cash_reward_records c join reward_transactions rt on rt.id=c.reward_transaction_id
      join match_results mr on mr.id=rt.result_id join matches m on m.id=mr.match_id join tournaments t on t.id=m.tournament_id
      left join player_profiles p on p.user_id=c.user_id left join teams team on team.id=c.team_id left join payout_records pr on pr.cash_reward_id=c.id
      where c.status in ('pending','confirmed','paid') order by c.created_at desc limit 200`),
  ]);
  res.json({payments:payments.rows,refunds:refunds.rows,payouts:payouts.rows,cashRewards:cashRewards.rows});
});

paymentsRouter.post('/admin/payouts',requireAdmin,async(req,res)=>{
  const parsed=z.object({cashRewardId:z.string().uuid()}).safeParse(req.body);
  if(!parsed.success)return res.status(400).json({error:'Choose a valid cash reward.'});
  const result=await withTransaction(async(client)=>{
    const reward=await client.query("select id,amount_paise,status from cash_reward_records where id=$1 for update",[parsed.data.cashRewardId]);
    if(!reward.rowCount)return {error:'Cash reward not found.',status:404};
    if(!['pending','confirmed'].includes(reward.rows[0].status))return {error:'This reward is not available for payout.',status:409};
    const existing=await client.query('select id from payout_records where cash_reward_id=$1',[parsed.data.cashRewardId]);
    if(existing.rowCount)return {error:'A payout record already exists for this reward.',status:409};
    const created=await client.query("insert into payout_records(cash_reward_id,amount_paise,status) values($1,$2,'pending') returning id,status,amount_paise",[reward.rows[0].id,reward.rows[0].amount_paise]);
    await recordAudit(client,req.session.user.id,'cash_payout_record_created','payout',created.rows[0].id,{cashRewardId:reward.rows[0].id,amountPaise:reward.rows[0].amount_paise});
    return {payout:created.rows[0]};
  });
  if(result.error)return res.status(result.status).json({error:result.error});
  res.status(201).json(result);
});

paymentsRouter.patch('/admin/payouts/:id',requireAdmin,async(req,res)=>{
  const parsed=z.object({status:z.enum(['pending','processing','paid','failed']),providerReference:z.string().trim().max(120).optional().or(z.literal(''))}).safeParse(req.body);
  if(!parsed.success|| (parsed.data?.status==='paid'&&!parsed.data.providerReference))return res.status(400).json({error:'Choose a payout status and provide a transfer reference before marking it paid.'});
  const result=await withTransaction(async(client)=>{
    const payout=await client.query(`select pr.id,pr.status,pr.cash_reward_id,c.reward_transaction_id from payout_records pr join cash_reward_records c on c.id=pr.cash_reward_id where pr.id=$1 for update of pr,c`,[req.params.id]);
    if(!payout.rowCount)return {error:'Payout record not found.',status:404};
    if(payout.rows[0].status==='paid'&&parsed.data.status!=='paid')return {error:'A paid payout cannot be changed. Record an audited correction with finance.',status:409};
    const saved=await client.query(`update payout_records set status=$2,provider_reference=case when $3<>'' then $3 else provider_reference end,paid_at=case when $2='paid' then coalesce(paid_at,now()) else null end where id=$1 returning id,status,provider_reference,paid_at`,[req.params.id,parsed.data.status,parsed.data.providerReference||'']);
    if(parsed.data.status==='paid'){
      await client.query("update cash_reward_records set status='paid',updated_at=now() where id=$1",[payout.rows[0].cash_reward_id]);
      await client.query("update reward_transactions set status='paid' where id=$1",[payout.rows[0].reward_transaction_id]);
    }else{
      await client.query("update cash_reward_records set status='confirmed',updated_at=now() where id=$1 and status in ('pending','confirmed')",[payout.rows[0].cash_reward_id]);
    }
    await recordAudit(client,req.session.user.id,'cash_payout_status_changed','payout',req.params.id,{status:parsed.data.status,providerReference:parsed.data.providerReference||null});
    return {payout:saved.rows[0]};
  });
  if(result.error)return res.status(result.status).json({error:result.error});
  res.json(result);
});

paymentsRouter.patch('/admin/refunds/:id', requireAdmin, async(req,res)=>{
  const parsed=z.object({action:z.enum(['approve','reject'])}).safeParse(req.body);
  if(!parsed.success)return res.status(400).json({error:'Choose approve or reject.'});
  const providerClient=parsed.data.action==='approve'?gateway():null;
  const decision=await withTransaction(async(client)=>{
    const refund=await client.query(`select rf.*,p.order_id,p.payment_id,p.status payment_status,t.start_at from refunds rf join payments p on p.id=rf.payment_id join tournament_registrations r on r.id=p.registration_id join tournaments t on t.id=r.tournament_id where rf.id=$1 for update`,[req.params.id]);
    if(!refund.rowCount)return {error:'Refund request not found.',status:404};
    if(refund.rows[0].status!=='requested')return {error:'Refund request was already decided.',status:409};
    if(parsed.data.action==='approve'&&!isRefundEligible(refund.rows[0].start_at))return {error:'Refunds are unavailable within 48 hours of tournament start.',status:409};
    if(parsed.data.action==='approve'){
      if(!refund.rows[0].payment_id)return {error:'The captured provider payment identifier is missing.',status:409};
      const saved=await client.query("update refunds set status='processing',decided_by=$2,updated_at=now() where id=$1 returning id,status,payment_id,amount_paise",[refund.rows[0].id,req.session.user.id]);
      await recordAudit(client,req.session.user.id,'refund_approved','refund',refund.rows[0].id,{amountPaise:refund.rows[0].amount_paise});
      return {refund:saved.rows[0],approve:true,providerPaymentId:refund.rows[0].payment_id};
    }
    const saved=await client.query("update refunds set status='rejected',decided_by=$2,updated_at=now() where id=$1 returning id,status",[refund.rows[0].id,req.session.user.id]);
    await recordAudit(client,req.session.user.id,'refund_rejected','refund',refund.rows[0].id);
    return {refund:saved.rows[0],approve:false};
  });
  if(decision.error)return res.status(decision.status).json({error:decision.error});
  if(decision.approve){
    try{
      const providerRefund=await providerClient.payments.refund(decision.providerPaymentId,{amount:decision.refund.amount_paise,notes:{refundRequestId:decision.refund.id}});
      const saved=await query("update refunds set provider_refund_id=$2,updated_at=now() where id=$1 and status='processing' returning id,status",[decision.refund.id,providerRefund.id]);
      return res.json({refund:saved.rows[0]});
    }catch(error){
      // Keep the request processing when provider state is uncertain; reconcile before retrying.
      console.error(`[payments] Refund ${decision.refund.id} needs reconciliation (${error.statusCode||error.code||'provider error'}).`);
      return res.status(503).json({error:'Razorpay did not confirm the refund request. The refund remains in processing for reconciliation.'});
    }
  }
  res.json({refund:decision.refund});
});
