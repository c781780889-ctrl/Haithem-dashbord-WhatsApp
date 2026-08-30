import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, CheckCircle2, Info, Loader2, MessageSquare, RefreshCw, Send, Settings2, Smartphone, Users, XCircle } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { API, authFetch } from '@/utils/api';
import { useToast } from '@/components/ui/ToastProvider';

type PublishingAccount = { id: string; name: string; phone_number?: string; status?: string; last_activity_at?: string };

function statusLabel(status?: string) {
  const labels: Record<string, string> = { ONLINE: 'متصل', WORKING: 'يعمل', CONNECTING: 'جارٍ الاتصال', PAUSED: 'متوقف مؤقتًا', ERROR: 'خطأ', DISABLED: 'معطل' };
  return labels[status || ''] || status || 'غير متاح';
}

export default function PrivateWhatsAppPublishingView() {
  const navigate = useNavigate();
  const { addToast } = useToast();
  const [accounts, setAccounts] = useState<PublishingAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadAccounts = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await authFetch(`${API}/private-whatsapp/publishing/accounts`);
      const data = await response.json();
      if (!response.ok || !data?.success) throw new Error(data?.error || 'تعذر تحميل حسابات النشر');
      setAccounts(data.accounts || []);
    } catch (err: any) {
      setError(err?.message || 'تعذر تحميل البيانات');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadAccounts(); }, [loadAccounts]);

  const notifyNotReady = () => addToast({ type: 'info', title: 'النشر غير مفعّل بعد', description: 'يلزم ربط حساب نشر مستقل عبر مزود واتساب رسمي قبل تشغيل أي حملة.' });

  return <div className="flex flex-col gap-6 animate-fade-in" dir="rtl">
    <div className="flex flex-wrap items-center justify-between gap-4"><div><button type="button" onClick={() => navigate('/private-whatsapp')} className="mb-3 inline-flex items-center gap-2 text-xs font-bold text-cyan-200 hover:text-cyan-100"><ArrowRight className="h-4 w-4" />العودة إلى قسم خاص واتس اب</button><h1 className="text-heading-xl text-primary">نشر واتس اب</h1><p className="mt-2 text-sm text-secondary">إدارة حسابات النشر والحملات في مساحة منفصلة عن حسابات الجمع العامة.</p></div><Badge variant={accounts.length ? 'success' : 'warning'} dot>{accounts.length ? `${accounts.length.toLocaleString('ar')} حساب` : 'لا توجد حسابات نشر'}</Badge></div>

    <section className="rounded-3xl border border-amber-300/20 bg-gradient-to-l from-amber-300/10 via-[var(--bg-surface)] to-[var(--bg-surface)] p-6"><div className="flex flex-col gap-5 md:flex-row md:items-center md:justify-between"><div className="flex items-start gap-4"><div className="rounded-2xl bg-amber-300/10 p-3 text-amber-200"><Send className="h-6 w-6" /></div><div><h2 className="text-heading-s text-primary">مساحة النشر المستقلة</h2><p className="mt-2 max-w-2xl text-sm leading-6 text-secondary">لا تستخدم هذه الصفحة حسابات الجمع العامة. لا يمكن تشغيل إرسال تلقائي قبل وجود حسابات نشر موثقة وموافقات صريحة للمستلمين.</p></div></div><button type="button" onClick={() => navigate('/private-whatsapp/settings')} className="inline-flex items-center justify-center gap-2 rounded-xl border border-amber-200/25 px-4 py-3 text-sm font-bold text-amber-100 transition-colors hover:bg-amber-200/10"><Settings2 className="h-4 w-4" />إعدادات النشر</button></div></section>

    <div className="grid grid-cols-1 gap-4 md:grid-cols-3"><Card><CardContent className="p-5"><Smartphone className="h-5 w-5 text-cyan-300" /><p className="mt-4 text-xs text-muted">حسابات النشر</p><p className="mt-2 text-2xl font-black text-primary">{loading ? '…' : accounts.length.toLocaleString('ar')}</p></CardContent></Card><Card><CardContent className="p-5"><MessageSquare className="h-5 w-5 text-violet-300" /><p className="mt-4 text-xs text-muted">الحملات النشطة</p><p className="mt-2 text-2xl font-black text-primary">غير متاح</p></CardContent></Card><Card><CardContent className="p-5"><Users className="h-5 w-5 text-emerald-300" /><p className="mt-4 text-xs text-muted">المستلمون المؤهلون</p><p className="mt-2 text-2xl font-black text-primary">غير متاح</p></CardContent></Card></div>

    <Card><CardContent className="p-0"><div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border-default)] p-5"><div><h2 className="text-heading-s text-primary">حسابات النشر</h2><p className="mt-1 text-xs text-muted">هذه القائمة مستقلة عن حسابات الجمع في Dashboard.</p></div><button type="button" onClick={loadAccounts} disabled={loading} className="inline-flex items-center gap-2 rounded-lg border border-[var(--border-default)] px-3 py-2 text-xs font-bold text-secondary hover:border-cyan-300/40 disabled:opacity-50"><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />تحديث</button></div>{loading ? <div className="p-10 text-center text-sm text-muted"><Loader2 className="mx-auto mb-2 h-5 w-5 animate-spin" />جارٍ تحميل الحسابات…</div> : error ? <div className="flex items-center gap-2 p-10 text-sm text-rose-200"><XCircle className="h-5 w-5" />{error}</div> : accounts.length === 0 ? <div className="p-10 text-center"><Smartphone className="mx-auto h-8 w-8 text-muted" /><h3 className="mt-3 text-sm font-bold text-primary">لا توجد حسابات نشر مهيأة</h3><p className="mx-auto mt-2 max-w-md text-xs leading-6 text-muted">لم يتم إنشاء جلسة نشر مستقلة بعد. يمكنك مراجعة إعدادات القسم، ولن يتم استخدام الحسابات العامة بدلًا منها.</p><button type="button" onClick={() => navigate('/private-whatsapp/settings')} className="mt-5 inline-flex items-center gap-2 rounded-xl bg-cyan-400 px-4 py-2.5 text-xs font-bold text-slate-950 hover:bg-cyan-300"><Settings2 className="h-4 w-4" />فتح الإعدادات</button></div> : <div className="divide-y divide-[var(--border-default)]">{accounts.map(account => <div key={account.id} className="flex flex-wrap items-center justify-between gap-3 p-5"><div className="flex items-center gap-3"><div className="rounded-xl bg-amber-300/10 p-3 text-amber-200"><Smartphone className="h-5 w-5" /></div><div><p className="text-sm font-bold text-primary">{account.name}</p><p className="mt-1 font-mono text-xs text-muted" dir="ltr">{account.phone_number || 'رقم غير متاح'}</p></div></div><Badge variant={account.status === 'ONLINE' || account.status === 'WORKING' ? 'success' : 'warning'} dot>{statusLabel(account.status)}</Badge></div>)}</div>}</CardContent></Card>

    <div className="flex items-start gap-3 rounded-2xl border border-cyan-300/15 bg-cyan-300/5 p-4 text-xs leading-6 text-secondary"><Info className="mt-0.5 h-4 w-4 shrink-0 text-cyan-200" /><p>تم تفعيل الزر والصفحة والمسار. إنشاء جلسات الإرسال وربط مزود واتساب الرسمي خطوة تشغيلية مستقلة، ولا يتم اختلاق حسابات أو حالات اتصال غير موجودة.</p></div>
    <button type="button" onClick={notifyNotReady} className="hidden">إشعار الجاهزية</button>
  </div>;
}
