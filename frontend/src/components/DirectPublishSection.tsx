import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Activity, AlertTriangle, CheckCircle2, Clock3, Eye, FileUp, Filter, Link2,
  Loader2, Megaphone, Pause, Play, RotateCcw, Search, ShieldCheck, Square,
  Timer, UserPlus, Users, X, XCircle,
} from 'lucide-react';
import { API, authFetch } from '@/utils/api';
import { cn } from '@/utils/cn';
import { useToast } from '@/components/ui/ToastProvider';
import { importLinkFile, type LinkImportSummary } from '@/utils/linkImport';

type LinkItem = { id: string; canonical_url: string; source_filename?: string; last_status?: string; last_error?: string };
type Account = {
  id: string;
  name: string;
  phone_number?: string;
  status?: string;
  health_status?: string;
  task_status?: string;
  is_ready?: boolean;
};
type Ad = {
  id: string;
  name?: string;
  title?: string;
  content?: string;
  is_active?: boolean;
  media_paths?: string[];
  priority?: number;
};
type Operation = {
  id: string;
  account_id: string;
  account_name: string;
  link_id: string;
  url: string;
  status: string;
  current_stage?: string;
  join_status?: string;
  publish_status?: string;
  leave_status?: string;
  last_error?: string;
  attempt_count?: number;
  join_started_at?: string;
  join_completed_at?: string;
  publish_started_at?: string;
  publish_completed_at?: string;
  leave_started_at?: string;
  leave_completed_at?: string;
  wait_started_at?: string;
  wait_completed_at?: string;
};
type Dashboard = { task: any; operations: Operation[]; events: any[]; stats: Record<string, number>; progress: number };
export type DirectPublishConfig = {
  adLibraryIds: string[];
  waitAfterJoinSeconds: number;
  waitAfterPublishSeconds: number;
  waitAfterLeaveSeconds: number;
  leaveEnabled: boolean;
  maxRetries: number;
};

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
  onClearAccounts: () => void;
  onLinksImported: () => Promise<void> | void;
  onSelectLinks: () => void;
  onSelectAccounts: () => void;
  onStart: (config: DirectPublishConfig) => void | Promise<void>;
  onControl: (status: string) => void;
  onReset: () => void;
};

const statusLabel: Record<string, string> = {
  pending: 'في الانتظار', processing: 'قيد التنفيذ', success: 'مكتملة', failed: 'فشلت',
  paused: 'متوقفة مؤقتًا', stopped: 'متوقفة', review: 'تحتاج مراجعة', retry: 'إعادة محاولة',
  skipped: 'تم تجاوزها', joining: 'انضمام', publishing: 'نشر', leaving: 'خروج',
  wait_after_join: 'انتظار بعد الانضمام', wait_after_publish: 'انتظار بعد النشر', wait_after_leave: 'انتظار بعد الخروج',
};
const stageLabel: Record<string, string> = {
  pending: 'في الانتظار', joining: 'الانضمام', wait_after_join: 'الانتظار بعد الانضمام',
  publishing: 'النشر', wait_after_publish: 'الانتظار بعد النشر', leaving: 'الخروج',
  wait_after_leave: 'الانتظار بعد الخروج', completed: 'مكتملة', failed: 'فشلت',
};
const durationPresets = [
  { value: 0, label: 'بدون انتظار' },
  { value: 10, label: '10 ثوانٍ' },
  { value: 30, label: '30 ثانية' },
  { value: 60, label: 'دقيقة واحدة' },
  { value: 120, label: 'دقيقتان' },
  { value: 300, label: '5 دقائق' },
];

function Metric({ label, value, icon: Icon, tone }: { label: string; value: string | number; icon: any; tone: string }) {
  return <div className="rounded-2xl border border-[var(--border-default)] bg-[var(--bg-elevated)] p-4"><Icon className={cn('mb-3 h-5 w-5', tone)} /><strong className="block text-2xl font-black">{value}</strong><span className="mt-1 block text-xs text-[var(--text-muted)]">{label}</span></div>;
}

function StepHeader({ number, title, description, locked = false, complete = false }: { number: number; title: string; description: string; locked?: boolean; complete?: boolean }) {
  return <div className={cn('mb-4 flex items-start gap-3', locked && 'opacity-55')}><div className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-black', complete ? 'bg-emerald-500 text-slate-950' : locked ? 'bg-[var(--bg-surface)] text-[var(--text-muted)]' : 'bg-cyan-500 text-slate-950')}>{complete ? <CheckCircle2 className="h-4 w-4" /> : number}</div><div><h3 className="font-black">{title}</h3><p className="mt-1 text-xs leading-5 text-[var(--text-muted)]">{description}</p></div></div>;
}

function AccountState({ account }: { account: Account }) {
  const reconnect = ['needs_reconnect', 'reconnect_required', 'qr_required'].includes(account.health_status || '') || account.task_status === 'needs_reconnect';
  const connecting = ['connecting', 'reconnecting', 'initializing'].includes(account.status || '') || ['connecting', 'reconnecting'].includes(account.task_status || '');
  const connected = account.status === 'connected' && account.is_ready !== false && !reconnect && !['protected', 'blocked'].includes(account.health_status || '');
  if (reconnect) return <span className="text-[11px] text-amber-300">يحتاج إعادة ربط</span>;
  if (connecting) return <span className="text-[11px] text-sky-300">جاري الاتصال</span>;
  if (connected) return <span className="text-[11px] text-emerald-300">متصل</span>;
  return <span className="text-[11px] text-[var(--text-muted)]">غير متصل</span>;
}

function DurationField({ label, value, onChange, disabled }: { label: string; value: number; onChange: (value: number) => void; disabled?: boolean }) {
  const preset = durationPresets.some(item => item.value === value) ? String(value) : 'custom';
  return <label className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-elevated)] p-3 text-sm"><span className="mb-2 flex items-center gap-2 text-xs text-[var(--text-muted)]"><Clock3 className="h-3.5 w-3.5 text-cyan-300" />{label}</span><select value={preset} disabled={disabled} onChange={event => { if (event.target.value !== 'custom') onChange(Number(event.target.value)); }} className="w-full rounded-lg border border-[var(--border-default)] bg-[var(--bg-surface)] px-2.5 py-2 text-sm"><option value="0">بدون انتظار</option>{durationPresets.slice(1).map(item => <option key={item.value} value={item.value}>{item.label}</option>)}<option value="custom">قيمة مخصصة</option></select>{preset === 'custom' && <div className="mt-2 flex items-center gap-2"><input type="number" min="0" max="86400" value={value} disabled={disabled} onChange={event => onChange(Math.max(0, Math.min(86400, Number(event.target.value) || 0)))} className="w-full rounded-lg border border-[var(--border-default)] bg-[var(--bg-surface)] px-2.5 py-2 text-sm" /><span className="shrink-0 text-xs text-[var(--text-muted)]">ثانية</span></div>}</label>;
}

function StageBadge({ value }: { value?: string }) {
  return <span className="inline-flex items-center rounded-full bg-[var(--bg-surface)] px-2 py-1 text-[11px] text-[var(--text-muted)]">{stageLabel[value || 'pending'] || statusLabel[value || 'pending'] || value || '—'}</span>;
}

function formatTime(value?: string) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export default function DirectPublishSection({ links, accounts, selectedLinks, selectedAccounts, dashboard, taskId, busy, onToggleLink, onToggleAccount, onClearAccounts, onLinksImported, onSelectLinks, onSelectAccounts, onStart, onControl, onReset }: Props) {
  const navigate = useNavigate();
  const { addToast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [ads, setAds] = useState<Ad[]>([]);
  const [selectedAdIds, setSelectedAdIds] = useState<Set<string>>(new Set());
  const [adSearch, setAdSearch] = useState('');
  const [adFilter, setAdFilter] = useState<'all' | 'active' | 'inactive'>('active');
  const [search, setSearch] = useState('');
  const [showCompleted, setShowCompleted] = useState(false);
  const [waitAfterJoin, setWaitAfterJoin] = useState(30);
  const [waitAfterPublish, setWaitAfterPublish] = useState(10);
  const [waitAfterLeave, setWaitAfterLeave] = useState(10);
  const [leaveEnabled, setLeaveEnabled] = useState(false);
  const [maxRetries, setMaxRetries] = useState(2);
  const [importingLinks, setImportingLinks] = useState(false);
  const [importSummary, setImportSummary] = useState<LinkImportSummary | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);

  const locked = Boolean(taskId || busy);
  const selectedAccount = accounts.find(account => selectedAccounts.has(account.id));
  const eligibleAccounts = accounts.filter(account => account.status === 'connected' && account.is_ready !== false && !['protected', 'blocked'].includes(account.health_status || '') && account.task_status !== 'stopped');
  const visibleLinks = useMemo(() => links.filter(link => (showCompleted || link.last_status !== 'success') && (!search || link.canonical_url.toLowerCase().includes(search.toLowerCase()))), [links, search, showCompleted]);
  const visibleAds = useMemo(() => ads.filter(ad => {
    const matchesSearch = !adSearch || `${ad.name || ad.title || ''} ${ad.content || ''}`.toLowerCase().includes(adSearch.toLowerCase());
    const matchesFilter = adFilter === 'all' || (adFilter === 'active' ? ad.is_active !== false : ad.is_active === false);
    return matchesSearch && matchesFilter;
  }), [ads, adFilter, adSearch]);
  const stats = dashboard?.stats || {};
  const activeAccounts = accounts.filter(account => selectedAccounts.has(account.id) && account.status === 'connected').length;
  const current = dashboard?.operations?.find(operation => operation.status === 'processing');
  const selectedAds = ads.filter(ad => selectedAdIds.has(ad.id));
  const readyForStart = selectedAccounts.size > 0 && selectedLinks.size > 0 && selectedAdIds.size > 0 && !locked;
  const allEligibleSelected = eligibleAccounts.length > 0 && eligibleAccounts.every(account => selectedAccounts.has(account.id));

  useEffect(() => {
    if (!selectedAccount?.id) { setAds([]); setSelectedAdIds(new Set()); return; }
    authFetch(`${API}/accounts/${selectedAccount.id}/ads`).then(response => response.json()).then(data => {
      if (data.success) {
        const nextAds = (data.ads || []).map((ad: Ad) => ({
          ...ad,
          media_paths: typeof ad.media_paths === 'string' ? (() => { try { return JSON.parse(ad.media_paths as unknown as string); } catch { return []; } })() : (ad.media_paths || []),
        }));
        setAds(nextAds);
        setSelectedAdIds(old => new Set([...old].filter(id => nextAds.some((ad: Ad) => ad.id === id && ad.is_active !== false))));
      }
    }).catch(() => setAds([]));
  }, [selectedAccount?.id]);

  useEffect(() => {
    if (locked) return;
    setSelectedAdIds(old => new Set([...old].filter(id => ads.some(ad => ad.id === id && ad.is_active !== false))));
  }, [ads, locked]);

  function toggleAd(id: string) {
    if (locked) return;
    const ad = ads.find(item => item.id === id);
    if (!ad || ad.is_active === false) return;
    setSelectedAdIds(old => { const next = new Set(old); next.has(id) ? next.delete(id) : next.add(id); return next; });
  }

  async function handleLinkImport(file?: File) {
    if (!file) return;
    setImportingLinks(true);
    setImportSummary(null);
    try {
      const summary = await importLinkFile(file);
      setImportSummary(summary);
      await onLinksImported();
      addToast({ title: 'تم استيراد الروابط ومراجعتها', type: 'success' });
    } catch (error: any) {
      addToast({ title: error?.message || 'تعذر استيراد الملف', type: 'error' });
    } finally {
      setImportingLinks(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  function resetLocal() {
    if (taskId) return addToast({ title: 'أوقف العملية أولًا قبل إعادة ضبط إعداداتها', type: 'error' });
    setSelectedAdIds(new Set());
    setSearch('');
    setShowCompleted(false);
    setAdSearch('');
    setImportSummary(null);
    setWaitAfterJoin(30);
    setWaitAfterPublish(10);
    setWaitAfterLeave(10);
    setLeaveEnabled(false);
    setMaxRetries(2);
    onClearAccounts();
    onReset();
  }

  function startSafely() {
    if (!readyForStart) {
      addToast({ title: 'أكمل اختيار حساب مؤهل وإعلان فعال وروابط صالحة أولًا', type: 'error' });
      return;
    }
    onStart({ adLibraryIds: [...selectedAdIds], waitAfterJoinSeconds: waitAfterJoin, waitAfterPublishSeconds: waitAfterPublish, waitAfterLeaveSeconds: waitAfterLeave, leaveEnabled, maxRetries });
  }

  return <section dir="rtl" className="space-y-5 rounded-3xl border border-cyan-500/20 bg-gradient-to-br from-[var(--bg-surface)] to-cyan-500/[0.03] p-5 shadow-xl">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div><div className="mb-2 flex items-center gap-2 text-cyan-400"><Megaphone className="h-5 w-5" /><span className="text-xs font-black tracking-[.16em]">الروابط / مسار التشغيل الآمن</span></div><h2 className="text-2xl font-black">الانضمام والنشر المباشر</h2><p className="mt-2 max-w-3xl text-sm leading-6 text-[var(--text-muted)]">مسار متسلسل لا يبدأ قبل استكمال الحسابات والإعلان والروابط والتوقيتات. تنفذ كل علاقة وفق: انضمام ← انتظار ← نشر ← انتظار ← خروج اختياري ← انتظار.</p></div>
      <div className="rounded-2xl border border-emerald-500/25 bg-emerald-500/10 px-4 py-3 text-xs text-emerald-300"><ShieldCheck className="mb-1 h-5 w-5" />ضمن الصلاحيات ولا يتجاوز حماية WhatsApp</div>
    </div>

    <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7"><Metric label="إجمالي الروابط" value={links.length} icon={Link2} tone="text-cyan-400" /><Metric label="مكتملة" value={stats.success || 0} icon={CheckCircle2} tone="text-emerald-400" /><Metric label="متبقية" value={stats.pending || 0} icon={Timer} tone="text-amber-400" /><Metric label="قيد التنفيذ" value={stats.processing || 0} icon={Activity} tone="text-sky-400" /><Metric label="فشلت/مراجعة" value={(stats.failed || 0) + (stats.review || 0)} icon={AlertTriangle} tone="text-rose-400" /><Metric label="الحسابات المحددة" value={`${activeAccounts} / ${accounts.length}`} icon={Users} tone="text-violet-400" /><Metric label="التقدم" value={`${dashboard?.progress || 0}%`} icon={Activity} tone="text-sky-400" /></div>

    <section className="rounded-2xl border border-[var(--border-default)] bg-[var(--bg-elevated)] p-4">
      <StepHeader number={1} title="اختيار الحساب أو الحسابات" description="حدد حسابًا واحدًا أو عدة حسابات. الحسابات غير المتصلة أو المحمية لا يمكن تشغيلها." complete={selectedAccounts.size > 0} />
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><div className="text-xs text-[var(--text-muted)]">{selectedAccounts.size ? `تم تحديد ${selectedAccounts.size} حساب` : 'لم يتم تحديد حساب بعد'}</div><div className="flex items-center gap-3"><button type="button" disabled={locked || !eligibleAccounts.length} onClick={() => allEligibleSelected ? onClearAccounts() : onSelectAccounts()} className="text-xs text-cyan-300 disabled:cursor-not-allowed disabled:opacity-40">{allEligibleSelected ? 'إلغاء تحديد الكل' : 'تحديد كل المؤهل'}</button>{selectedAccounts.size > 0 && <button type="button" disabled={locked} onClick={onClearAccounts} className="inline-flex items-center gap-1 text-xs text-[var(--text-muted)] hover:text-rose-300 disabled:opacity-40"><X className="h-3 w-3" />مسح التحديد</button>}<button type="button" disabled={locked} onClick={() => navigate('/accounts')} className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-400/30 bg-cyan-500/10 px-2.5 py-1.5 text-xs font-bold text-cyan-300 disabled:opacity-40"><UserPlus className="h-3.5 w-3.5" />إضافة حساب</button></div></div>
      {accounts.length ? <div className="grid gap-2 md:grid-cols-2">{accounts.map(account => { const eligible = eligibleAccounts.some(item => item.id === account.id); return <label key={account.id} className={cn('flex items-center gap-3 rounded-xl border border-[var(--border-default)] p-3 transition', eligible && !locked ? 'cursor-pointer hover:border-cyan-500/40' : 'cursor-not-allowed opacity-60')}><input type="checkbox" disabled={!eligible || locked} checked={selectedAccounts.has(account.id)} onChange={() => onToggleAccount(account.id)} className="h-4 w-4 accent-cyan-500" /><span className="min-w-0 flex-1"><strong className="block text-sm">{account.name}</strong><small className="text-xs text-[var(--text-muted)]">{account.phone_number || 'رقم مخفي'}</small></span><AccountState account={account} /></label>; })}</div> : <div className="rounded-xl border border-dashed border-cyan-400/30 bg-cyan-500/5 p-5 text-center"><Users className="mx-auto mb-2 h-6 w-6 text-cyan-300" /><p className="text-sm font-bold">لا توجد حسابات مرتبطة</p><p className="mt-1 text-xs text-[var(--text-muted)]">أضف حساب WhatsApp من صفحة الحسابات ثم ارجع لإكمال المسار.</p><button type="button" onClick={() => navigate('/accounts')} className="mt-3 inline-flex items-center gap-2 rounded-xl bg-cyan-500 px-4 py-2 text-xs font-black text-slate-950"><UserPlus className="h-3.5 w-3.5" />إضافة أول حساب</button></div>}
    </section>

    <section className={cn('rounded-2xl border border-[var(--border-default)] bg-[var(--bg-elevated)] p-4', !selectedAccounts.size && 'opacity-60')}>
      <StepHeader number={2} title="اختيار الإعلان من مكتبة الإعلانات" description="تظهر إعلانات الحساب المحدد الأول من المكتبة الحالية فقط. يمكنك اختيار إعلان واحد أو عدة إعلانات فعالة." locked={!selectedAccounts.size} complete={selectedAdIds.size > 0} />
      {!selectedAccounts.size ? <p className="rounded-xl bg-[var(--bg-surface)] p-4 text-center text-xs text-[var(--text-muted)]">أكمل الخطوة الأولى لعرض الإعلانات المتاحة.</p> : <><div className="mb-3 flex flex-wrap items-center gap-2"><div className="relative min-w-[220px] flex-1"><Search className="absolute right-3 top-2.5 h-4 w-4 text-[var(--text-muted)]" /><input value={adSearch} onChange={event => setAdSearch(event.target.value)} disabled={locked} placeholder="بحث داخل مكتبة الإعلانات..." className="w-full rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] py-2 pr-9 pl-3 text-sm" /></div><select value={adFilter} onChange={event => setAdFilter(event.target.value as 'all' | 'active' | 'inactive')} disabled={locked} className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] px-3 py-2 text-sm"><option value="active">الفعالة فقط</option><option value="all">كل الإعلانات</option><option value="inactive">المعطلة</option></select><button type="button" disabled={locked} onClick={() => navigate(`/ad-library?accountId=${encodeURIComponent(selectedAccount.id)}`)} className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-400/30 bg-cyan-500/10 px-3 py-2 text-xs font-bold text-cyan-300 disabled:opacity-40"><Eye className="h-3.5 w-3.5" />فتح مكتبة الإعلانات</button></div><div className="grid gap-2 md:grid-cols-2">{visibleAds.length ? visibleAds.map(ad => <label key={ad.id} className={cn('flex gap-3 rounded-xl border p-3 transition', ad.is_active === false ? 'cursor-not-allowed border-[var(--border-default)] opacity-55' : !locked ? 'cursor-pointer border-[var(--border-default)] hover:border-cyan-500/50' : 'cursor-not-allowed border-[var(--border-default)] opacity-75')}><input type="checkbox" disabled={ad.is_active === false || locked} checked={selectedAdIds.has(ad.id)} onChange={() => toggleAd(ad.id)} className="mt-1 h-4 w-4 accent-violet-500" /><span className="min-w-0 flex-1">{ad.media_paths?.[0] && <img src={ad.media_paths[0]} alt="معاينة وسائط الإعلان" className="mb-2 h-20 w-full rounded-lg object-cover" loading="lazy" />}<span className="flex items-center justify-between gap-2"><strong className="truncate text-sm">{ad.name || ad.title || `إعلان ${ad.id.slice(0, 8)}`}</strong><span className={cn('shrink-0 text-[11px]', ad.is_active === false ? 'text-[var(--text-muted)]' : 'text-emerald-300')}>{ad.is_active === false ? 'معطل' : 'فعال'}</span></span><span className="mt-1 block line-clamp-2 text-xs leading-5 text-[var(--text-muted)]">{ad.content || 'لا يوجد نص؛ قد يحتوي الإعلان على وسائط.'}</span>{(ad.media_paths?.length || ad.priority) && <span className="mt-1 block text-[11px] text-[var(--text-muted)]">{ad.media_paths?.length ? `${ad.media_paths.length} وسائط` : ''}{ad.media_paths?.length && ad.priority ? ' · ' : ''}{ad.priority ? `أولوية ${ad.priority}` : ''}</span>}</span></label>) : <div className="col-span-full rounded-xl border border-dashed border-violet-400/25 bg-violet-500/5 p-5 text-center text-xs text-[var(--text-muted)]">لا توجد إعلانات مطابقة. أضف إعلانًا أو فعّله من مكتبة الإعلانات.</div>}</div><p className="mt-3 text-xs text-[var(--text-muted)]">{selectedAdIds.size ? `تم اختيار ${selectedAdIds.size} إعلان` : 'اختر إعلانًا فعالًا واحدًا على الأقل للمتابعة.'}</p></>}
    </section>

    <section className={cn('rounded-2xl border border-[var(--border-default)] bg-[var(--bg-elevated)] p-4', !selectedAdIds.size && 'opacity-60')}>
      <StepHeader number={3} title="استيراد ملف الروابط ومراجعتها" description="تدعم هذه الخطوة DOCX وTXT وCSV وXLSX، وتعرض الروابط بعد التحقق والتوحيد وإزالة التكرار." locked={!selectedAdIds.size} complete={selectedLinks.size > 0} />
      {!selectedAdIds.size ? <p className="rounded-xl bg-[var(--bg-surface)] p-4 text-center text-xs text-[var(--text-muted)]">أكمل اختيار إعلان فعال لفتح استيراد الروابط.</p> : <><div className="mb-3 flex flex-wrap items-center justify-between gap-2"><div className="relative min-w-[220px] flex-1"><Search className="absolute right-3 top-2.5 h-4 w-4 text-[var(--text-muted)]" /><input value={search} onChange={event => setSearch(event.target.value)} disabled={locked} placeholder="بحث في الروابط..." className="w-full rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] py-2 pr-9 pl-3 text-sm" dir="ltr" /></div><div className="flex flex-wrap items-center gap-2"><button type="button" onClick={() => fileRef.current?.click()} disabled={locked || importingLinks} className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-400/30 bg-emerald-500/10 px-3 py-2 text-xs font-bold text-emerald-300 disabled:opacity-50">{importingLinks ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileUp className="h-3.5 w-3.5" />}استيراد ملف</button><button type="button" onClick={onSelectLinks} disabled={locked || !links.length} className="text-xs text-cyan-300 disabled:opacity-40">تحديد الكل</button><label className="flex items-center gap-1.5 text-xs text-[var(--text-muted)]"><input type="checkbox" checked={showCompleted} disabled={locked} onChange={event => setShowCompleted(event.target.checked)} className="h-3.5 w-3.5 accent-cyan-500" />إظهار المكتملة</label><span className="text-xs text-[var(--text-muted)]">{selectedLinks.size} محدد</span></div></div><input ref={fileRef} hidden type="file" accept=".docx,.txt,.csv,.xlsx,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv,text/plain" onChange={event => handleLinkImport(event.target.files?.[0])} />{importSummary && <p className="mb-3 rounded-xl border border-emerald-400/20 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-200">{importSummary.filename || 'الملف'}: {importSummary.validCount ?? importSummary.newCount ?? 0} روابط صحيحة، {importSummary.newCount ?? 0} جديدة، {importSummary.duplicateCount ?? 0} مكررة، {importSummary.invalidCount ?? 0} غير صالحة.</p>}<div className="max-h-72 space-y-2 overflow-auto">{visibleLinks.length ? visibleLinks.map(link => <label key={link.id} className={cn('flex items-center gap-3 rounded-xl border border-[var(--border-default)] p-3', !locked ? 'cursor-pointer hover:border-cyan-500/40' : 'cursor-not-allowed opacity-75')}><input type="checkbox" checked={selectedLinks.has(link.id)} disabled={locked} onChange={() => onToggleLink(link.id)} className="h-4 w-4 accent-cyan-500" /><span className="min-w-0 flex-1"><span className="block truncate text-sm" dir="ltr">{link.canonical_url}</span><small className="mt-1 block truncate text-[11px] text-[var(--text-muted)]">المصدر: {link.source_filename || 'إدخال سابق'}</small></span><span className="text-[11px] text-[var(--text-muted)]">{statusLabel[link.last_status || 'pending'] || 'مراجعة'}</span></label>) : <div className="rounded-xl border border-dashed border-emerald-400/25 bg-emerald-500/5 p-6 text-center"><FileUp className="mx-auto mb-2 h-6 w-6 text-emerald-300" /><p className="text-sm font-bold">لا توجد روابط جاهزة</p><p className="mt-1 text-xs leading-5 text-[var(--text-muted)]">اختر ملف TXT أو CSV أو XLSX أو DOCX من ذاكرة الهاتف.</p><button type="button" onClick={() => fileRef.current?.click()} disabled={locked || importingLinks} className="mt-3 inline-flex items-center gap-2 rounded-xl bg-emerald-500 px-4 py-2 text-xs font-black text-slate-950 disabled:opacity-50"><FileUp className="h-3.5 w-3.5" />اختيار ملف</button></div>}</div></>}
    </section>

    <section className={cn('rounded-2xl border border-[var(--border-default)] bg-[var(--bg-elevated)] p-4', !selectedLinks.size && 'opacity-60')}>
      <StepHeader number={4} title="إعداد توقيت العمليات" description="كل مرحلة لها فلتر مستقل؛ لا ينتقل الرابط التالي قبل إكمال الدورة الحالية." locked={!selectedLinks.size} complete={selectedLinks.size > 0 && selectedAdIds.size > 0} />
      {!selectedLinks.size ? <p className="rounded-xl bg-[var(--bg-surface)] p-4 text-center text-xs text-[var(--text-muted)]">راجع الروابط وحدد رابطًا واحدًا على الأقل لفتح إعدادات التوقيت.</p> : <><div className="grid gap-3 md:grid-cols-3"><DurationField label="الانتظار بعد الانضمام" value={waitAfterJoin} onChange={setWaitAfterJoin} disabled={locked} /><DurationField label="الانتظار بعد النشر" value={waitAfterPublish} onChange={setWaitAfterPublish} disabled={locked} /><DurationField label="الانتظار بعد الخروج" value={waitAfterLeave} onChange={setWaitAfterLeave} disabled={locked} /></div><div className="mt-3 flex flex-wrap items-center gap-4 rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] p-3 text-sm"><label className="flex items-center gap-2"><input type="checkbox" checked={leaveEnabled} disabled={locked} onChange={event => setLeaveEnabled(event.target.checked)} className="h-4 w-4 accent-cyan-500" />تفعيل الخروج بعد النشر</label><label className="flex items-center gap-2 text-xs text-[var(--text-muted)]">إعادة المحاولة عند الخطأ<input type="number" min="0" max="3" value={maxRetries} disabled={locked} onChange={event => setMaxRetries(Math.max(0, Math.min(3, Number(event.target.value) || 0)))} className="w-16 rounded-lg border border-[var(--border-default)] bg-[var(--bg-elevated)] px-2 py-1.5 text-center text-sm" />مرة</label></div></>}
    </section>

    <section className="rounded-2xl border border-cyan-500/20 bg-cyan-500/[0.03] p-4"><div className="mb-3 flex flex-wrap items-center justify-between gap-2"><h3 className="font-black">ملخص العملية</h3><span className="text-xs text-[var(--text-muted)]">لا يبدأ التنفيذ قبل الضغط على زر البدء</span></div><div className="grid gap-3 text-sm md:grid-cols-2 lg:grid-cols-4"><div><span className="block text-xs text-[var(--text-muted)]">الحسابات المختارة</span><strong className="mt-1 block">{selectedAccounts.size || '—'}</strong></div><div><span className="block text-xs text-[var(--text-muted)]">الإعلانات المختارة</span><strong className="mt-1 block">{selectedAds.length || '—'}</strong></div><div><span className="block text-xs text-[var(--text-muted)]">الروابط المحددة / الصحيحة</span><strong className="mt-1 block">{selectedLinks.size} / {links.length}</strong></div><div><span className="block text-xs text-[var(--text-muted)]">الخروج</span><strong className="mt-1 block">{leaveEnabled ? 'مفعل' : 'غير مفعل'}</strong></div><div><span className="block text-xs text-[var(--text-muted)]">بعد الانضمام</span><strong className="mt-1 block">{waitAfterJoin} ثانية</strong></div><div><span className="block text-xs text-[var(--text-muted)]">بعد النشر</span><strong className="mt-1 block">{waitAfterPublish} ثانية</strong></div><div><span className="block text-xs text-[var(--text-muted)]">بعد الخروج</span><strong className="mt-1 block">{waitAfterLeave} ثانية</strong></div><div><span className="block text-xs text-[var(--text-muted)]">التسلسل</span><strong className="mt-1 block text-xs">انضمام ← نشر ← خروج</strong></div></div></section>

    <div className="flex flex-wrap gap-3"><button type="button" onClick={() => setPreviewOpen(true)} disabled={!selectedAccounts.size || !selectedAdIds.size || !selectedLinks.size || locked} className="inline-flex items-center gap-2 rounded-xl border border-violet-400/35 bg-violet-500/10 px-5 py-3 text-sm font-black text-violet-200 disabled:cursor-not-allowed disabled:opacity-40"><Eye className="h-4 w-4" />معاينة الإعدادات</button><button type="button" onClick={startSafely} disabled={!readyForStart} className="inline-flex items-center gap-2 rounded-xl bg-cyan-500 px-5 py-3 text-sm font-black text-slate-950 disabled:cursor-not-allowed disabled:opacity-40">{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}بدء العملية</button>{taskId && <><button type="button" onClick={() => onControl('paused')} className="inline-flex items-center gap-2 rounded-xl border border-amber-500/30 px-4 py-3 text-sm font-bold text-amber-300"><Pause className="h-4 w-4" />إيقاف مؤقت</button><button type="button" onClick={() => onControl('pending')} className="inline-flex items-center gap-2 rounded-xl border border-sky-500/30 px-4 py-3 text-sm font-bold text-sky-300"><RotateCcw className="h-4 w-4" />استئناف</button><button type="button" onClick={() => onControl('stopped')} className="inline-flex items-center gap-2 rounded-xl border border-rose-500/30 px-4 py-3 text-sm font-bold text-rose-300"><Square className="h-4 w-4" />إيقاف كامل</button></>}<button type="button" onClick={resetLocal} disabled={busy || Boolean(taskId)} className="inline-flex items-center gap-2 rounded-xl border border-[var(--border-default)] px-4 py-3 text-sm font-bold text-[var(--text-muted)] disabled:cursor-not-allowed disabled:opacity-40"><RotateCcw className="h-4 w-4" />إعادة ضبط</button></div>

    {current && <div className="rounded-2xl border border-cyan-500/30 bg-cyan-500/5 p-4"><h3 className="mb-3 flex items-center gap-2 font-black text-cyan-300"><Activity className="h-5 w-5" />العملية الحالية</h3><div className="grid gap-3 text-sm md:grid-cols-4"><div><span className="block text-xs text-[var(--text-muted)]">الرابط</span><strong dir="ltr" className="mt-1 block truncate">{current.url}</strong></div><div><span className="block text-xs text-[var(--text-muted)]">الحساب</span><strong className="mt-1 block">{current.account_name}</strong></div><div><span className="block text-xs text-[var(--text-muted)]">المرحلة</span><strong className="mt-1 block text-sky-300">{stageLabel[current.current_stage || 'pending'] || current.current_stage}</strong></div><div><span className="block text-xs text-[var(--text-muted)]">المحاولة</span><strong className="mt-1 block">{current.attempt_count || 1}</strong></div></div></div>}

    {dashboard && <section className="rounded-2xl border border-[var(--border-default)] bg-[var(--bg-elevated)] p-4"><div className="mb-4 flex flex-wrap items-center justify-between gap-2"><h3 className="font-black">سجل التنفيذ المباشر</h3><span className="text-xs text-[var(--text-muted)]">{dashboard.progress}% مكتمل</span></div><div className="overflow-auto"><table className="w-full min-w-[900px] text-right text-xs"><thead><tr className="border-b border-[var(--border-default)] text-[var(--text-muted)]"><th className="p-3">الرابط</th><th className="p-3">الحساب</th><th className="p-3">الانضمام</th><th className="p-3">النشر</th><th className="p-3">الخروج</th><th className="p-3">الانتظار</th><th className="p-3">الحالة</th><th className="p-3">آخر خطأ</th></tr></thead><tbody>{dashboard.operations.map(operation => <tr key={operation.id} className="border-b border-[var(--border-default)]"><td className="max-w-[220px] p-3" dir="ltr"><span className="block truncate">{operation.url}</span></td><td className="p-3 font-bold">{operation.account_name}</td><td className="p-3"><StageBadge value={operation.join_status} /><div className="mt-1 text-[10px] text-[var(--text-muted)]">{formatTime(operation.join_completed_at)}</div></td><td className="p-3"><StageBadge value={operation.publish_status} /><div className="mt-1 text-[10px] text-[var(--text-muted)]">{formatTime(operation.publish_completed_at)}</div></td><td className="p-3"><StageBadge value={operation.leave_status} /><div className="mt-1 text-[10px] text-[var(--text-muted)]">{formatTime(operation.leave_completed_at)}</div></td><td className="p-3"><div>{formatTime(operation.wait_started_at)} → {formatTime(operation.wait_completed_at)}</div></td><td className="p-3"><span className={cn('font-bold', operation.status === 'success' ? 'text-emerald-300' : operation.status === 'failed' || operation.status === 'review' ? 'text-rose-300' : 'text-amber-300')}>{statusLabel[operation.status] || operation.status}</span></td><td className="max-w-[220px] p-3 text-rose-300">{operation.last_error || '—'}</td></tr>)}</tbody></table></div><div className="mt-5 grid gap-4 lg:grid-cols-2"><div><h4 className="mb-2 font-bold">الأحداث</h4><div className="max-h-48 space-y-2 overflow-auto">{dashboard.events?.length ? dashboard.events.map((event: any) => <div key={event.id} className="flex items-start justify-between gap-3 rounded-xl bg-[var(--bg-surface)] p-3 text-xs"><span>{event.payload?.error || event.event_type}</span><time className="shrink-0 text-[var(--text-muted)]">{formatTime(event.created_at)}</time></div>) : <div className="py-5 text-center text-xs text-[var(--text-muted)]">سيظهر السجل بعد بدء العملية</div>}</div></div><div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-4 text-xs leading-6 text-[var(--text-muted)]"><h4 className="mb-1 font-black text-amber-300">قواعد الاستقرار</h4><p>لكل حساب قفل تشغيل مستقل، ولا تُرسل العملية التالية قبل إكمال الحالية. الأخطاء تُسجل على الرابط والحساب والمرحلة، والحساب المحمي ينتقل إلى المراجعة بدل تكرار المحاولة بلا نهاية.</p></div></div></section>}

    {previewOpen && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" role="dialog" aria-modal="true" aria-label="معاينة إعدادات العملية"><div className="max-h-[90vh] w-full max-w-2xl overflow-auto rounded-3xl border border-[var(--border-default)] bg-[var(--bg-surface)] p-5 shadow-2xl"><div className="mb-4 flex items-center justify-between"><h3 className="text-xl font-black">معاينة إعدادات العملية</h3><button type="button" onClick={() => setPreviewOpen(false)} className="rounded-lg p-2 text-[var(--text-muted)] hover:bg-[var(--bg-elevated)]" aria-label="إغلاق المعاينة"><X className="h-5 w-5" /></button></div><div className="grid gap-3 text-sm md:grid-cols-2"><div className="rounded-xl bg-[var(--bg-elevated)] p-3"><span className="text-xs text-[var(--text-muted)]">الحسابات</span><strong className="mt-1 block">{[...selectedAccounts].map(id => accounts.find(account => account.id === id)?.name).filter(Boolean).join('، ') || '—'}</strong></div><div className="rounded-xl bg-[var(--bg-elevated)] p-3"><span className="text-xs text-[var(--text-muted)]">الإعلانات</span><strong className="mt-1 block">{selectedAds.map(ad => ad.name || ad.title).join('، ') || '—'}</strong></div><div className="rounded-xl bg-[var(--bg-elevated)] p-3"><span className="text-xs text-[var(--text-muted)]">الروابط</span><strong className="mt-1 block">{selectedLinks.size} من أصل {links.length}</strong></div><div className="rounded-xl bg-[var(--bg-elevated)] p-3"><span className="text-xs text-[var(--text-muted)]">التسلسل</span><strong className="mt-1 block">انضمام → انتظار → نشر → انتظار → {leaveEnabled ? 'خروج → انتظار' : 'اكتمال'}</strong></div><div className="rounded-xl bg-[var(--bg-elevated)] p-3">بعد الانضمام: <strong>{waitAfterJoin} ثانية</strong></div><div className="rounded-xl bg-[var(--bg-elevated)] p-3">بعد النشر: <strong>{waitAfterPublish} ثانية</strong></div><div className="rounded-xl bg-[var(--bg-elevated)] p-3">بعد الخروج: <strong>{waitAfterLeave} ثانية</strong></div><div className="rounded-xl bg-[var(--bg-elevated)] p-3">الخروج: <strong>{leaveEnabled ? 'مفعل' : 'غير مفعل'}</strong></div></div><button type="button" onClick={() => setPreviewOpen(false)} className="mt-5 w-full rounded-xl bg-cyan-500 px-4 py-3 text-sm font-black text-slate-950">العودة للتعديل</button></div></div>}
  </section>;
}
