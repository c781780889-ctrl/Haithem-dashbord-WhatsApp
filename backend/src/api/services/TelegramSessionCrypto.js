'use strict';
const crypto = require('crypto');
function key(){ const raw=process.env.SESSION_ENCRYPTION_KEY; if(!raw) throw new Error('SESSION_ENCRYPTION_KEY غير مهيأ في الخادم'); return crypto.createHash('sha256').update(raw).digest(); }
function encrypt(value){ const iv=crypto.randomBytes(12); const cipher=crypto.createCipheriv('aes-256-gcm',key(),iv); const data=Buffer.concat([cipher.update(String(value),'utf8'),cipher.final()]); return `v1:${iv.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${data.toString('base64url')}`; }
function decrypt(payload){ if(!payload) return ''; if(!String(payload).startsWith('v1:')) return String(payload); const [,iv,tag,data]=String(payload).split(':'); const decipher=crypto.createDecipheriv('aes-256-gcm',key(),Buffer.from(iv,'base64url')); decipher.setAuthTag(Buffer.from(tag,'base64url')); return Buffer.concat([decipher.update(Buffer.from(data,'base64url')),decipher.final()]).toString('utf8'); }
module.exports={encrypt,decrypt};
