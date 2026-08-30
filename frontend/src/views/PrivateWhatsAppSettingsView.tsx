import { useCallback, useEffect, useState } from 'react';
import { ArrowRight, CheckCircle2, Info, Loader2, Save, Settings2, ShieldCheck } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { API, authFetch } from '@/utils/api';
import { useToast } from '@/components/ui/ToastProvider';

type Settings = { default_country_code?: string; sync_enabled?: boolean };

export default function PrivateWhatsAppSettingsView() {
  const navigate = useNavigate();
  const { addToast } = useToast();
  const [settings, setSettings] = useState<Settings>({ default_country_code: '', sync_enabled: true });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadSettings = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await authFetch(`${API}/private-whatsapp/settings`);
      const data = await response.json();
      if (!response.ok || !data?.success) throw new Error(data?.error || 'تعذر تحميل إعدادات القسم');
      setSettings({ default_country_code: data.settings?.default_country_code || '', sync_enabled: data.settings?.sync_enabled !== false });
    } catch (err: any) {
      setError(err?.message || 'تعذر تحميل الإعدادات');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadSettings(); }, [loadSettings]);

  const saveSettings = async () => {
    setSaving(true);
    try {
      const response = await authFetch(`${API}/private-whatsapp/settings`, {
        method: 'PATCH',
        body: JSON.stringify({ defaultCountryCode: settings.default_country_code, syncEnabled: settings.sync_enabled }),
      });
      const data = await response.json();
      if (!response.ok || !data?.success) throw new Error(data?.error || 'تعذر حفظ الإعدادات');
      setSettings({ default_country_code: data.settings?.default_country_code || '', sync_enabled: data.settings?.sync_enabled !== false });
      addToast({ type: 'success', title: 'تم حفظ الإعدادات', description: 'سيتم استخدام هذه الإعدادات في المزامنات القادمة.' });
    } catch (err: any) {
      addToast({ type: 'error', title: 'تعذر حفظ الإعدادات', description: err?.message || 'حدث خطأ غير متوقع.' });
    } finally {
      setSaving(false);
    }
  };

  return <div className="flex flex-col gap-6 animate-fade-in" dir="rtl">
    <div><button type="button" onClick={() => navigate('/private-whatsapp')} className="mb-3 inline-flex items-center gap-2 text-xs font-bold text-cyan-200 hover:text-cyan-100"><ArrowRight className="h-4 w-4" />العودة إلى قسم خاص واتس اب</button><div className="flex flex-wrap items-center justify-between gap-4"><div><h1 className="text-heading-xl text-primary">إعدادات قسم خاص واتس اب</h1><p className="mt-2 text-sm text-secondary">ضبط المزامنة والفصل التشغيلي للقسم من مكان واحد.</p></div><Badge variant="info" dot>إعدادات آمنة</Badge></div></div>

    <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1.4fr)_minmax(300px,0.8fr)]"><Card><CardContent className="p-5 md:p-6"><div className="mb-6 flex items-center gap-3"><div className="rounded-xl bg-cyan-300/10 p-3 text-cyan-200"><Settings2 className="h-5 w-5" /></div><div><h2 className="text-heading-s text-primary">إعدادات المزامنة</h2><p className="mt-1 text-xs text-muted">تُطبّق على عمليات المزامنة الجديدة فقط.</p></div></div>{loading ? <div className="flex items-center gap-2 p-6 text-sm text-muted"><Loader2 className="h-4 w-4 animate-spin" />جارٍ تحميل الإعدادات…</div> : error ? <div className="rounded-xl bg-rose-300/5 p-4 text-sm text-rose-200">{error}</div> : <div className="space-y-6"><label className="block"><span className="text-sm font-bold text-primary">رمز الدولة الافتراضي</span><span className="mt-1 block text-xs leading-5 text-muted">يُستخدم فقط للأرقام المحلية التي لا تبدأ بعلامة +. اتركه فارغًا لرفض التخمين.</span><input value={settings.default_country_code || ''} onChange={event => setSettings(current => ({ ...current, default_country_code: event.target.value.replace(/[^0-9]/g, '').slice(0, 3) }))} inputMode="numeric" dir="ltr" placeholder="مثال: 967" className="mt-3 w-full max-w-xs rounded-xl border border-[var(--border-default)] bg-[var(--bg-elevated)] px-3 py-2.5 text-sm text-primary outline-none focus:border-cyan-300/45" /></label><label className="flex items-start gap-3 rounded-2xl border border-[var(--border-default)] bg-[var(--bg-elevated)] p-4"><input type="checkbox" checked={settings.sync_enabled !== false} onChange={event => setSettings(current => ({ ...current, sync_enabled: event.target.checked }))} className="mt-1 h-4 w-4 accent-cyan-400" /><span><span className="block text-sm font-bold text-primary">السماح بجدولة المزامنة</span><span className="mt-1 block text-xs leading-5 text-muted">عند التعطيل، يجب ألا تبدأ عمليات مزامنة جديدة من الواجهة.</span></span></label><button type="button" onClick={saveSettings} disabled={saving} className="inline-flex items-center gap-2 rounded-xl bg-cyan-400 px-5 py-3 text-sm font-bold text-slate-950 transition-colors hover:bg-cyan-300 disabled:cursor-not-allowed disabled:opacity-60"><Save className="h-4 w-4" />{saving ? 'جارٍ الحفظ…' : 'حفظ الإعدادات'}</button></div>}</CardContent></Card>
      <div className="flex flex-col gap-6"><Card><CardContent className="p-5 md:p-6"><div className="flex items-center gap-3"><ShieldCheck className="h-5 w-5 text-emerald-300" /><div><h2 className="text-heading-s text-primary">حماية البيانات</h2><p className="mt-1 text-xs text-muted">فصل الإعدادات عن الأسرار الحساسة.</p></div></div><div className="mt-5 space-y-3 text-xs leading-6 text-secondary"><div className="flex items-start gap-2"><CheckCircle2 className="mt-1 h-4 w-4 shrink-0 text-emerald-300" />لا يتم حفظ Session Secret داخل إعدادات القسم.</div><div className="flex items-start gap-2"><CheckCircle2 className="mt-1 h-4 w-4 shrink-0 text-emerald-300" />حسابات النشر منفصلة عن حسابات الجمع العامة.</div><div className="flex items-start gap-2"><CheckCircle2 className="mt-1 h-4 w-4 shrink-0 text-emerald-300" />يتم تسجيل تحديثات الإعدادات في Audit Log.</div></div></CardContent></Card><div className="flex items-start gap-3 rounded-2xl border border-cyan-300/15 bg-cyan-300/5 p-4 text-xs leading-6 text-secondary"><Info className="mt-0.5 h-4 w-4 shrink-0 text-cyan-200" /><p>الإعدادات الحالية لا تنشئ حساب نشر أو جلسة واتساب تلقائيًا. ربط مزود النشر يتم لاحقًا عبر قناة اعتماد مستقلة.</p></div></div>
    </div>
  </div>;
}
