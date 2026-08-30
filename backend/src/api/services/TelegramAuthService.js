'use strict';
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { query, queryOne } = require('../../lib/postgres');
const SocketBridge = require('../../core/SocketBridge');
const TelegramService = require('./TelegramService');
const { encrypt } = require('./TelegramSessionCrypto');
const { v4: uuidv4 } = require('uuid');
const active = new Map();
const limits = new Map();
const TTL = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
function env(){
 const apiId=Number(process.env.TELEGRAM_API_ID || process.env.TELEGRAM_APP_ID || process.env.TELEGRAM_APIID || process.env.API_ID || 0);
 const apiHash=String(process.env.TELEGRAM_API_HASH || process.env.TELEGRAM_APP_HASH || process.env.TELEGRAM_APIHASH || process.env.API_HASH || '').trim();
 if(!Number.isInteger(apiId) || apiId <= 0 || !apiHash) throw new Error('إعدادات Telegram API غير مهيأة في الخادم. اضبط TELEGRAM_API_ID و TELEGRAM_API_HASH في Railway.');
 return {apiId,apiHash};
}
function phone(value){ const p=String(value||'').replace(/[\s().-]/g,''); if(!/^\+[1-9]\d{7,14}$/.test(p)) throw new Error('أدخل رقم Telegram بصيغة دولية صحيحة مثل +967XXXXXXXXX'); return p; }
function safeError(err){
 const code=String(err?.errorMessage||err?.message||'');
 if(/PHONE_CODE_INVALID/i.test(code)) return 'رمز التحقق غير صحيح';
 if(/PHONE_CODE_EXPIRED/i.test(code)) return 'انتهت صلاحية رمز التحقق';
 if(/PHONE_NUMBER_INVALID/i.test(code)) return 'رقم الهاتف غير صالح';
 if(/SESSION_PASSWORD_NEEDED/i.test(code)) return 'الحساب محمي بالتحقق بخطوتين';
 if(/API_ID_INVALID|API_HASH_INVALID|API_ID_PUBLISHED_FLOOD/i.test(code)) return 'بيانات Telegram API غير صحيحة. راجع API_ID وAPI_HASH في Railway';
 if(/SESSION_ENCRYPTION_KEY غير مهيأ|SESSION_ENCRYPTION_KEY.*(missing|not set)/i.test(code)) return 'مفتاح SESSION_ENCRYPTION_KEY غير مهيأ في Railway؛ أضفه إلى خدمة التطبيق ثم أعد النشر';
 if(/FLOOD_WAIT/i.test(code)) return 'طلب Telegram مهلة مؤقتة. حاول لاحقاً';
 if(/TIMEOUT|ETIMEDOUT|ECONNRESET|CONNECTION/i.test(code)) return 'انقطع اتصال Telegram مؤقتاً. أعد طلب الكود وحاول مرة أخرى';
 if(/AUTH_KEY_UNREGISTERED|SESSION_REVOKED/i.test(code)) return 'تعذر إنشاء جلسة Telegram';
 if(/TELEGRAM_ACCOUNT_EXISTS|duplicate key|idx_tg_accounts_user_/i.test(code)) return 'هذا الحساب مضاف مسبقاً إلى لوحة التحكم';
 if(code) console.error(`[TelegramAuth] Authentication failed: ${code}`);
 return 'تعذر إكمال مصادقة Telegram';
}
function deferred(){ let resolve,reject; const promise=new Promise((r,j)=>{resolve=r;reject=j}); return {promise,resolve,reject}; }
function emit(userId,event,payload={}){ try{ SocketBridge.to(`user:${userId}`).emit(event,{...payload}); }catch{} }
async function state(id,state,extra={}){ await query(`UPDATE telegram_auth_sessions SET state=$1,last_error=$2,updated_at=NOW() WHERE id=$3`,[state,extra.error||null,id]).catch(()=>{}); const row=await queryOne(`SELECT id,user_id,phone_reference,state,last_error,expires_at,attempts FROM telegram_auth_sessions WHERE id=$1`,[id]).catch(()=>null); if(row) emit(row.user_id,`telegram:auth:${state}`,{authSessionId:id,phone:row.phone_reference,expiresAt:row.expires_at,...extra}); return row; }
async function cleanup(id,disconnect=true){ const item=active.get(id); if(item){ item.expired=true; if(disconnect) await item.client.disconnect().catch(()=>{}); active.delete(id); } }
const Service={
 normalizePhone:phone,
 async requestCode(userId,rawPhone,rawRole='SEARCH_ROLE'){ const automationRole=['SEARCH_ROLE','JOIN_ROLE'].includes(rawRole) ? rawRole : 'SEARCH_ROLE'; const p=phone(rawPhone); const now=Date.now(); const key=`${userId}:${p}`; const recent=limits.get(key)||0; if(now-recent<60000) throw new Error('انتظر دقيقة قبل طلب كود جديد لهذا الرقم'); limits.set(key,now); const existing=await queryOne(`SELECT id,state,expires_at FROM telegram_auth_sessions WHERE user_id=$1 AND phone_reference=$2 AND state IN ('created','code_requested','waiting_code','verifying','waiting_2fa') AND expires_at>NOW()`,[userId,p]); if(existing) throw new Error('يوجد طلب تحقق نشط بالفعل لهذا الرقم'); const {apiId,apiHash}=env(); const id=uuidv4(); await query(`INSERT INTO telegram_auth_sessions(id,user_id,phone_reference,state,expires_at) VALUES($1,$2,$3,'created',NOW()+INTERVAL '10 minutes')`,[id,userId,p]); const client=new TelegramClient(new StringSession(''),apiId,apiHash,{connectionRetries:20,retryDelay:3000,autoReconnect:true}); const item={client,code:deferred(),password:deferred(),expired:false}; active.set(id,item); emit(userId,'telegram:auth:created',{authSessionId:id,phone:p}); item.promise=(async()=>{ try { await client.connect(); await state(id,'code_requested'); await client.signInUser({apiId,apiHash},{phoneNumber:p,phoneCode:async()=>{ await state(id,'waiting_code'); emit(userId,'telegram:auth:code_requested',{authSessionId:id}); return item.code.promise; },password:async()=>{ await state(id,'waiting_2fa'); return item.password.promise; },onError:async()=>false}); if(item.expired) throw new Error('AUTH_SESSION_EXPIRED'); const me=await client.getMe(); const telegramUserId=String(me.id||''); const existingAccount=await queryOne(`SELECT id,name,phone_number,telegram_user_id,username,status,last_connected_at FROM telegram_accounts WHERE user_id=$1 AND ((telegram_user_id=$2 AND telegram_user_id IS NOT NULL AND telegram_user_id<>'') OR phone_number=$3) ORDER BY last_connected_at DESC NULLS LAST,created_at DESC NULLS LAST LIMIT 1`,[userId,telegramUserId,p]); if(existingAccount){ await client.disconnect().catch(()=>{}); active.delete(id); throw new Error('TELEGRAM_ACCOUNT_EXISTS'); } const session=client.session.save(); const encrypted=encrypt(session); const name=[me.firstName,me.lastName].filter(Boolean).join(' ')||me.username||p; const account=await queryOne(`INSERT INTO telegram_accounts(id,user_id,name,phone_number,api_id,api_hash,session_string,session_encrypted,telegram_user_id,username,first_name,last_name,automation_role,status,last_connected_at,auth_required) VALUES($1,$2,$3,$4,NULL,NULL,NULL,$5,$6,$7,$8,$9,$10,'connecting',NOW(),false) RETURNING id,name,phone_number,telegram_user_id,username,first_name,last_name,status,last_connected_at`,[uuidv4(),userId,name,p,encrypted,telegramUserId,me.username||null,me.firstName||null,me.lastName||null,automationRole]);
 await state(id,'authenticated',{accountId:account.id}); await client.disconnect().catch(()=>{}); active.delete(id); await state(id,'completed',{accountId:account.id}); const full=await queryOne(`SELECT * FROM telegram_accounts WHERE id=$1`,[account.id]); await TelegramService.startWorker(full); emit(userId,'telegram:account:connected',{accountId:account.id,account}); return account; } catch(err){ const message=safeError(err); await state(id,'failed',{error:message}); await cleanup(id); throw err; } })(); item.promise.catch(()=>{}); return {authSessionId:id,phone:p,expiresAt:new Date(Date.now()+TTL).toISOString(),state:'waiting_code'}; },
 async verifyCode(userId,id,rawCode){ const row=await queryOne(`SELECT * FROM telegram_auth_sessions WHERE id=$1 AND user_id=$2 AND expires_at>NOW()`,[id,userId]); if(!row) throw new Error('انتهت صلاحية عملية التحقق'); if(row.attempts>=MAX_ATTEMPTS) throw new Error('تم تجاوز عدد محاولات التحقق'); const code=String(rawCode||'').replace(/\s/g,''); if(!/^\d{3,8}$/.test(code)) throw new Error('رمز التحقق غير صالح'); const item=active.get(id); if(!item) throw new Error('جلسة التحقق غير متاحة'); await query(`UPDATE telegram_auth_sessions SET attempts=attempts+1,state='verifying',updated_at=NOW() WHERE id=$1`,[id]); item.code.resolve(code); return {accepted:true,state:'verifying'}; },
 async verify2fa(userId,id,password){ const row=await queryOne(`SELECT * FROM telegram_auth_sessions WHERE id=$1 AND user_id=$2 AND expires_at>NOW()`,[id,userId]); if(!row) throw new Error('انتهت صلاحية عملية التحقق'); if(!password || String(password).length<1) throw new Error('كلمة مرور التحقق بخطوتين مطلوبة'); const item=active.get(id); if(!item) throw new Error('جلسة التحقق غير متاحة'); item.password.resolve(String(password)); return {accepted:true,state:'verifying'}; },
 async status(userId,id){ const row=await queryOne(`SELECT id,user_id,phone_reference,state,last_error,expires_at,attempts FROM telegram_auth_sessions WHERE id=$1 AND user_id=$2`,[id,userId]); if(!row) return {state:'expired'}; if(new Date(row.expires_at).getTime()<Date.now()){ await query(`UPDATE telegram_auth_sessions SET state='expired' WHERE id=$1`,[id]).catch(()=>{}); await cleanup(id); return {state:'expired'}; } return row; },
 async cancel(userId,id){ const row=await queryOne(`SELECT id FROM telegram_auth_sessions WHERE id=$1 AND user_id=$2`,[id,userId]); if(row) { await query(`DELETE FROM telegram_auth_sessions WHERE id=$1`,[id]); await cleanup(id); } return {cancelled:true}; },
 startCleanup(){ if(this._cleanupTimer) return; this._cleanupTimer=setInterval(()=>this.expire().catch(()=>{}),30000); this.expire().catch(()=>{}); },
 stopCleanup(){ if(this._cleanupTimer){ clearInterval(this._cleanupTimer); this._cleanupTimer=null; } for(const id of active.keys()) cleanup(id).catch(()=>{}); },
 async expire(){ const rows=await require('../../lib/postgres').queryAll(`SELECT id,state FROM telegram_auth_sessions WHERE expires_at<=NOW()`).catch(()=>[]); for(const r of rows){ if(['completed','failed','expired'].includes(r.state)){ await query(`DELETE FROM telegram_auth_sessions WHERE id=$1`,[r.id]).catch(()=>{}); } else { await query(`UPDATE telegram_auth_sessions SET state='expired',last_error='انتهت صلاحية عملية التحقق' WHERE id=$1`,[r.id]).catch(()=>{}); await cleanup(r.id); } } },
};
module.exports=Service;
