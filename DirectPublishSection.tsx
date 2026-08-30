import { useEffect, useMemo, useState } from 'react';
import { Activity, Megaphone, Pause, Play, RotateCcw, ShieldCheck, Square, Timer, Users, Link2, AlertTriangle } from 'lucide-react';
import { API, authFetch } from '@/utils/api';
import { cn } from '@/utils/cn';

type LinkItem = { id: string; canonical_url: string; last_status?: string; last_error?: string };
type Account = { id: string; name: string; phone_number?: string; status?: string; health_status?: string };
type Dashboard = { task: any; operations: any[]; events: any[]; stats: Record<string, number>; progress: number };

type Props = {
  links: LinkItem[];
  accounts: Account[];
  selectedLinks: Set<string>;
  selectedAccounts: Set<string>;
  dashboard: Dashboard | null;
  taskId: string | null;
  busy: boolean;
  onToggleLink: (id: string) => void;
  onToggleAccount: (id: string) => void;
  onSelectLinks: () => void;
  onSelectAccounts: () => void;
  onStart: () => void;
  onControl: (status: string) => void;
};

type Ad = { id: string; name?: string; title?: string; content?: string; is_active?: boolean };

const statusLabel: Record<string, string> = {
  pending: 'في الانتظار', processing: 'قيد المعالجة', success: 'تمت العملية', failed: 'فشلت', paused: 'متوقفة', stopped: 'تم إيقافها', review: 'مراجعة',
};

function Metric({ label, value, icon: Icon, tone }: { label: string; value: string | number; icon: any; tone: string }) {
  return <div className="rounded-2xl border border-[var(--border-default)] bg-[var(--bg-elevated)] p-4"><Icon className={cn('mb-3 h-5 w-5', tone)} /><strong className="block text-2xl font-black">{value}</strong><span className="mt-1 block text-xs text-[var(--text-muted)]">{label}</span></div>;
}

export default function DirectPublishSection({ links, accounts, selectedLinks, selectedAccounts, dashboard, taskId, busy, onToggleLink, onToggleAccount, onSelectLinks, onSelectAccounts, onStart, onControl }: Props) {
  const [ads, setAds] = useState<Ad[]>([]);
  const [selectedAd, setSelectedAd] = useState('');
  const [search, setSearch] = useState('');
  const [intervalMinutes, setIntervalMinutes] = useState(10);
  const [breakMinutes, setBreakMinutes] = useState(15);
  const [nextAt, setNextAt] = useState<number | null>(null);

  const selectedAccount = accounts.find(a => selectedAccounts.has(a.id));
  useEffect(() => {
    if (!selectedAccount?.id) { setAds([]); return; }
    authFetch(`${API}/accounts/${selectedAccount.id}/ads`).then(r => r.json()).then(d => {
      if (d.success) setAds((d.ads || []).filter((ad: Ad) => ad.is_active !== false));
    }).catch(() => setAds([]));
  }, [selectedAccount?.id]);

  const visibleLinks = useMemo(() => links.filter(link => !search || link.canonical_url.toLowerCase().includes(search.toLowerCase())), [links, search]);
  const stats = dashboard?.stats || {};
  const activeAccounts = accounts.filter(a => selectedAccounts.has(a.id) && a.status === 'connected').length;
  const current = dashboard?.operations?.find(op => op.status === 'processing');
  const countdown = nextAt ? Math.max(0, Math.ceil((nextAt - Date.now()) / 1000)) : 0;

  useEffect(() => {
    if (!nextAt) return;
    const timer = window.setInterval(() => setNextAt(value => value && value <= Date.now() ? null : value), 1000);
    return () => window.clearInterval(timer);
  }, [nextAt]);

  function startSafely() {
    if (!selectedLinks.size || !selectedAccounts.size) return;
    setNextAt(Date.now() + intervalMinutes * 60_000);
    onStart();
  }

  return <section dir="rtl" className="space-y-5 rounded-3xl border border-cyan-500/20 bg-gradient-to-br from-[var(--bg-surface)] to-cyan-500/[0.03] p-5 shadow-xl">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div><div className="mb-2 flex items-center gap-2 text-cyan-400"><Megaphone className="h-5 w-5" /><span className="text-xs font-black tracking-[.16em]">الروابط / التشغيل المتحكم</span></div><h2 className="text-2xl font-black">الانضمام والنشر المباشر</h2><p className="mt-2 max-w-3xl text-sm leading-6 text-[var(--text-muted)]">تشغيل منظم للروابط المصرح بها فقط، مع اختيار الحساب والإعلان، فواصل زمنية، إيقاف واستئناف، وسجل مباشر. لا يتجاوز هذا القسم أي قيود أو أنظمة حماية في WhatsApp.</p></div>
      <div className="rounded-2xl border border-emerald-500/25 bg-emerald-500/10 px-4 py-3 text-xs text-emerald-300"><ShieldCheck className="mb-1 h-5 w-5" />تشغيل ضمن الصلاحيات</div>
    </div>

    <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7"><Metric label="إجمالي الروابط" value={links.length} icon={Link2} tone="text-cyan-400" /><Metric label="مكتملة" value={stats.success || 0} icon={ShieldCheck} tone="text-emerald-400" /><Metric label="متبقية" value={stats.pending || 0} icon={Timer} tone="text-amber-400" /><Metric label="قيد التنفيذ" value={stats.processing || 0} icon={Activity} tone="text-sky-400" /><Metric label="فاشلة" value={stats.failed || 0} icon={AlertTriangle} tone="text-rose-400" /><Metric label="الحسابات النشطة" value={`${activeAccounts} / ${accounts.length}`} icon={Users} tone="text-violet-400" /><Metric label="النشر" value={stats.success || 0} icon={Megaphone} tone="text-fuchsia-400" /></div>

    <div className="grid gap-5 xl:grid-cols-[1.2fr_.8fr]">
      <div className="rounded-2xl border border-[var(--border-default)] bg-[var(--bg-elevated)] p-4"><div className="mb-3 flex flex-wrap items-center justify-between gap-2"><h3 className="font-black">قائمة الروابط وإدارة المهمة</h3><div className="flex gap-2"><button onClick={onSelectLinks} className="text-xs text-cyan-400">تحديد الكل</button><span className="text-xs text-[var(--text-muted)]">{selectedLinks.size} محدد</span></div></div><input value={search} onChange={e => setSearch(e.target.value)} placeholder="بحث في الروابط..." className="mb-3 w-full rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] px-3 py-2 text-sm" dir="ltr" /><div className="max-h-64 space-y-2 overflow-auto">{visibleLinks.length ? visibleLinks.map(link => <label key={link.id} className="flex cursor-pointer items-center gap-3 rounded-xl border border-[var(--border-default)] p-3 hover:border-cyan-500/40"><input type="checkbox" checked={selectedLinks.has(link.id)} onChange={() => onToggleLink(link.id)} className="h-4 w-4 accent-cyan-500" /><span className="min-w-0 flex-1 truncate text-sm" dir="ltr">{link.canonical_url}</span><span className="text-[11px] text-[var(--text-muted)]">{statusLabel[link.last_status || 'pending'] || 'انتظار'}</span></label>) : <div className="py-8 text-center text-sm text-[var(--text-muted)]">لا توجد روابط مستوردة</div>}</div></div>
      <div className="rounded-2xl border border-[var(--border-default)] bg-[var(--bg-elevated)] p-4"><div className="mb-3 flex items-center justify-between"><h3 className="font-black">الحسابات والإعلان</h3><button onClick={onSelectAccounts} className="text-xs text-cyan-400">تحديد المؤهل</button></div><div className="max-h-36 space-y-2 overflow-auto">{accounts.map(account => <label key={account.id} className="flex cursor-pointer items-center gap-3 rounded-xl border border-[var(--border-default)] p-3"><input type="checkbox" disabled={account.status !== 'connected'} checked={selectedAccounts.has(account.id)} onChange={() => onToggleAccount(account.id)} className="h-4 w-4 accent-violet-500" /><span className="min-w-0 flex-1"><strong className="block text-sm">{account.name}</strong><small className="text-xs text-[var(--text-muted)]">{account.phone_number || 'رقم مخفي'}</small></span><span className="text-[11px] text-[var(--text-muted)]">{account.status === 'connected' ? 'متصل' : 'غير نشط'}</span></label>)}</div><label className="mt-3 block text-sm"><span className="mb-2 block text-xs text-[var(--text-muted)]">الإعلان من مكتبة الإعلانات</span><select value={selectedAd} onChange={e => setSelectedAd(e.target.value)} className="w-full rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] px-3 py-2.5"><option value="">اختيار إعلان</option>{ads.map(ad => <option key={ad.id} value={ad.id}>{ad.name || ad.title || `إعلان ${ad.id.slice(0, 8)}`}</option>)}</select></label><p className="mt-2 text-[11px] text-[var(--text-muted)]">تُحمّل الإعلانات من مكتبة الحساب المحدد الأول، ولا يتم إنشاء مكتبة مكررة.</p></div>
    </div>

    <div className="rounded-2xl border border-[var(--border-default)] bg-[var(--bg-elevated)] p-4"><h3 className="mb-3 font-black">الفاصل الزمني وفترة الاستراحة</h3><div className="grid gap-3 md:grid-cols-3"><label className="text-sm"><span className="mb-2 block text-xs text-[var(--text-muted)]">الفاصل بين العمليات بالدقائق</span><input type="number" min="1" max="1440" value={intervalMinutes} onChange={e => setIntervalMinutes(Math.max(1, Number(e.target.value)))} className="w-full rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] px-3 py-2.5" /></label><label className="text-sm"><span className="mb-2 block text-xs text-[var(--text-muted)]">مدة الاستراحة بالدقائق</span><input type="number" min="0" max="1440" value={breakMinutes} onChange={e => setBreakMinutes(Math.max(0, Number(e.target.value)))} className="w-full rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] px-3 py-2.5" /></label><div className="rounded-xl border border-[var(--border-default)] p-3 text-sm"><span className="block text-xs text-[var(--text-muted)]">العملية التالية بعد</span><strong className="mt-2 block text-lg text-cyan-400">{countdown ? `${Math.floor(countdown / 60).toString().padStart(2, '0')}:${(countdown % 60).toString().padStart(2, '0')}` : 'غير مجدولة'}</strong></div></div><div className="mt-4 flex flex-wrap gap-3"><button onClick={startSafely} disabled={busy || !selectedLinks.size || !selectedAccounts.size} className="inline-flex items-center gap-2 rounded-xl bg-cyan-500 px-5 py-3 text-sm font-black text-slate-950 disabled:opacity-40"><Play className="h-4 w-4" />تأكيد وبدء</button>{taskId && <><button onClick={() => onControl('paused')} className="inline-flex items-center gap-2 rounded-xl border border-amber-500/30 px-4 py-3 text-sm font-bold text-amber-300"><Pause className="h-4 w-4" />إيقاف مؤقت</button><button onClick={() => onControl('stopped')} className="inline-flex items-center gap-2 rounded-xl border border-rose-500/30 px-4 py-3 text-sm font-bold text-rose-300"><Square className="h-4 w-4" />إيقاف كامل</button><button onClick={() => onControl('pending')} className="inline-flex items-center gap-2 rounded-xl border border-sky-500/30 px-4 py-3 text-sm font-bold text-sky-300"><RotateCcw className="h-4 w-4" />استئناف</button></>}</div></div>

    {current && <div className="rounded-2xl border border-cyan-500/30 bg-cyan-500/5 p-4"><h3 className="mb-3 flex items-center gap-2 font-black text-cyan-300"><Activity className="h-5 w-5" />العملية الحالية</h3><div className="grid gap-3 text-sm md:grid-cols-4"><div><span className="block text-xs text-[var(--text-muted)]">الرابط</span><strong dir="ltr" className="mt-1 block truncate">{current.url}</strong></div><div><span className="block text-xs text-[var(--text-muted)]">الحساب</span><strong className="mt-1 block">{current.account_name}</strong></div><div><span className="block text-xs text-[var(--text-muted)]">الحالة</span><strong className="mt-1 block text-sky-300">{statusLabel[current.status] || current.status}</strong></div><div><span className="block text-xs text-[var(--text-muted)]">المحاولة</span><strong className="mt-1 block">{current.attempt_count || 1}</strong></div></div></div>}

    <div className="grid gap-5 lg:grid-cols-[1fr_.9fr]"><div className="rounded-2xl border border-[var(--border-default)] bg-[var(--bg-elevated)] p-4"><h3 className="mb-3 font-black">سجل النشاط المباشر</h3><div className="max-h-44 space-y-2 overflow-auto">{dashboard?.events?.length ? dashboard.events.slice().reverse().map((event: any) => <div key={event.id} className="flex items-center justify-between rounded-xl bg-[var(--bg-surface)] p-3 text-xs"><span>{event.event_type}</span><time className="text-[var(--text-muted)]">{new Date(event.created_at).toLocaleTimeString('ar-SA')}</time></div>) : <div className="py-8 text-center text-sm text-[var(--text-muted)]">سيظهر النشاط بعد بدء مهمة مصرح بها</div>}</div></div><div className="rounded-2xl border border-amber-500/25 bg-amber-500/5 p-4 text-sm leading-7 text-[var(--text-muted)]"><h3 className="mb-2 flex items-center gap-2 font-black text-amber-300"><ShieldCheck className="h-5 w-5" />ضوابط السلامة</h3><p>لا يبدأ التشغيل إلا بعد اختيار حسابات متصلة وروابط مستوردة. الحسابات المحمية أو غير المتصلة مستبعدة، ولا توجد محاولة لتجاوز الحظر أو CAPTCHA أو قيود WhatsApp.</p><p className="mt-2">الإعلان المختار للمعاينة فقط حاليًا؛ تنفيذ النشر يتطلب مسار API مصرحًا ومحدد الصلاحيات في الخادم.</p></div></div>
  </section>;
}
