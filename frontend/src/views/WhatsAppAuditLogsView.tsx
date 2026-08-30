import { useCallback, useEffect, useMemo, useState } from 'react';
import { io } from 'socket.io-client';
import {
  Activity, AlertTriangle, BarChart3, CalendarDays, ChevronLeft, ChevronRight,
  Clock3, Download, Eye, FileSearch, Filter, Loader2, RefreshCw, Search,
  ShieldCheck, UserRound, X, Zap,
} from 'lucide-react';
import { API, authFetch } from '../utils/api';
import { cn } from '@/utils/cn';
import { useToast } from '../components/ui/ToastProvider';

type AuditItem = {
  id: string | number;
  actor_id: string;
  actor_username?: string;
  action: string;
  entity_type: string;
  entity_id?: string | null;
  before_state?: Record<string, unknown>;
  after_state?: Record<string, unknown>;
  ip?: string | null;
  user_agent?: string | null;
  created_at: string;
};

type AuditStats = {
  total: number;
  last24h: number;
  last7d: number;
  actors: number;
  lastEventAt?: string | null;
  byAction: Array<{ action: string; count: number }>;
  byEntity: Array<{ entity_type: string; count: number }>;
  byDay: Array<{ day: string; count: number }>;
};

type AuditResponse = {
  items: AuditItem[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

const actionLabels: Record<string, string> = {
  IMPORT: 'استيراد روابط',
  JOB_CREATE: 'إنشاء مهمة',
  LINK_ARCHIVE: 'أرشفة رابط',
  EXPORT: 'تصدير بيانات',
  TASK_CONTROL: 'التحكم بالمهمة',
  SEARCH_START: 'بدء البحث',
  ROLE_CHANGE: 'تغيير الدور',
};

const entityLabels: Record<string, string> = {
  whatsapp_link: 'رابط واتساب',
  whatsapp_link_import: 'استيراد روابط',
  whatsapp_task: 'مهمة انضمام',
  whatsapp_audit_logs: 'سجل التدقيق',
};

function actionLabel(action: string) { return actionLabels[action] || action || 'إجراء غير معروف'; }
function entityLabel(entity: string) { return entityLabels[entity] || entity || 'كيان غير معروف'; }
function formatDate(value?: string | null) {
  if (!value) return '—';
  try { return new Date(value).toLocaleString('ar-SA', { dateStyle: 'medium', timeStyle: 'short' }); } catch { return '—'; }
}
function formatTime(value?: string | null) {
  if (!value) return '—';
  try { return new Date(value).toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit' }); } catch { return '—'; }
}
function toneForAction(action: string) {
  if (action === 'LINK_ARCHIVE') return 'warning';
  if (action === 'EXPORT') return 'neutral';
  if (action === 'JOB_CREATE' || action === 'IMPORT') return 'success';
  return 'info';
}
function toneClass(tone: string) {
  return tone === 'success'
    ? 'border-emerald-400/25 bg-emerald-500/10 text-emerald-200'
    : tone === 'warning'
      ? 'border-amber-400/25 bg-amber-500/10 text-amber-200'
      : tone === 'neutral'
        ? 'border-slate-400/25 bg-slate-500/10 text-slate-200'
        : 'border-cyan-400/25 bg-cyan-500/10 text-cyan-200';
}
function safeJson(value: unknown) {
  try { return JSON.stringify(value ?? {}, null, 2); } catch { return '{}'; }
}
function newRequestId(prefix: string) {
  return globalThis.crypto?.randomUUID?.() || `${prefix}-${Date.now()}-${Math.random()}`;
}

function StatCard({ label, value, hint, icon: Icon, tone }: { label: string; value: number | string; hint: string; icon: typeof Activity; tone: string }) {
  return <div className={cn('rounded-3xl border bg-[var(--bg-surface)] p-4 shadow-[var(--shadow-card)]', tone)}>
    <div className="flex items-start justify-between gap-3"><span className="text-xs font-bold text-[var(--text-muted)]">{label}</span><span className="rounded-2xl bg-current/10 p-2"><Icon className="h-5 w-5" /></span></div>
    <strong className="mt-3 block text-3xl font-black tracking-tight">{value}</strong>
    <p className="mt-1 text-[11px] text-[var(--text-muted)]">{hint}</p>
  </div>;
}

export default function WhatsAppAuditLogsView() {
  const { addToast } = useToast();
  const [logs, setLogs] = useState<AuditResponse>({ items: [], page: 1, pageSize: 50, total: 0, totalPages: 1 });
  const [stats, setStats] = useState<AuditStats>({ total: 0, last24h: 0, last7d: 0, actors: 0, byAction: [], byEntity: [], byDay: [] });
  const [loading, setLoading] = useState(true);
  const [statsLoading, setStatsLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [action, setAction] = useState('all');
  const [entityType, setEntityType] = useState('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [selected, setSelected] = useState<AuditItem | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [lastLiveEvent, setLastLiveEvent] = useState<string | null>(null);

  const queryString = useMemo(() => {
    const params = new URLSearchParams({ page: String(page), pageSize: '50' });
    if (search.trim()) params.set('search', search.trim());
    if (action !== 'all') params.set('action', action);
    if (entityType !== 'all') params.set('entityType', entityType);
    if (from) params.set('from', `${from}T00:00:00.000Z`);
    if (to) params.set('to', `${to}T23:59:59.999Z`);
    return params.toString();
  }, [page, search, action, entityType, from, to]);

  const statsQuery = useMemo(() => {
    const params = new URLSearchParams();
    if (search.trim()) params.set('search', search.trim());
    if (action !== 'all') params.set('action', action);
    if (entityType !== 'all') params.set('entityType', entityType);
    if (from) params.set('from', `${from}T00:00:00.000Z`);
    if (to) params.set('to', `${to}T23:59:59.999Z`);
    return params.toString();
  }, [search, action, entityType, from, to]);

  const loadLogs = useCallback(async () => {
    setLoading(true);
    try {
      const response = await authFetch(`${API}/whatsapp/join-automation/audit?${queryString}`);
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || 'تعذر تحميل Audit Logs');
      setLogs({ items: data.items || [], page: Number(data.page || page), pageSize: Number(data.pageSize || 50), total: Number(data.total || 0), totalPages: Math.max(1, Number(data.totalPages || 1)) });
    } catch (error: any) {
      addToast({ title: error?.message || 'تعذر تحميل Audit Logs', type: 'error' });
    } finally { setLoading(false); }
  }, [addToast, page, queryString]);

  const loadStats = useCallback(async () => {
    setStatsLoading(true);
    try {
      const response = await authFetch(`${API}/whatsapp/join-automation/audit/stats${statsQuery ? `?${statsQuery}` : ''}`);
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || 'تعذر تحميل إحصاءات التدقيق');
      setStats(data.stats || { total: 0, last24h: 0, last7d: 0, actors: 0, byAction: [], byEntity: [], byDay: [] });
    } catch (error: any) {
      addToast({ title: error?.message || 'تعذر تحميل إحصاءات التدقيق', type: 'error' });
    } finally { setStatsLoading(false); }
  }, [addToast, statsQuery]);

  const refresh = useCallback(() => { loadLogs(); loadStats(); }, [loadLogs, loadStats]);
  useEffect(() => { loadLogs(); }, [loadLogs]);
  useEffect(() => { loadStats(); }, [loadStats]);

  useEffect(() => {
    const socket = io(window.location.origin, { path: '/socket.io', transports: ['websocket', 'polling'] });
    const onAudit = (item: AuditItem) => {
      setLastLiveEvent(item.created_at || new Date().toISOString());
      loadLogs();
      loadStats();
    };
    socket.on('whatsapp:audit_log_created', onAudit);
    return () => { socket.off('whatsapp:audit_log_created', onAudit); socket.disconnect(); };
  }, [loadLogs, loadStats]);

  async function openDetail(item: AuditItem) {
    setSelected(item);
    setDetailLoading(true);
    try {
      const response = await authFetch(`${API}/whatsapp/join-automation/audit/${item.id}`);
      const data = await response.json();
      if (response.ok && data.success) setSelected(data.item);
    } catch { /* keep the row data as a useful fallback */ }
    finally { setDetailLoading(false); }
  }

  async function exportLogs() {
    const requestId = newRequestId('wa-audit-export');
    try {
      const suffix = statsQuery ? `?${statsQuery}` : '';
      const response = await authFetch(`${API}/whatsapp/join-automation/audit/export${suffix}`, { headers: { 'Idempotency-Key': requestId } });
      if (!response.ok) throw new Error('تعذر تصدير Audit Logs');
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'whatsapp-audit-logs.csv'; anchor.click(); URL.revokeObjectURL(url);
      addToast({ title: 'تم تصدير Audit Logs', type: 'success' });
    } catch (error: any) { addToast({ title: error?.message || 'تعذر التصدير', type: 'error' }); }
  }

  function resetFilters() { setSearch(''); setAction('all'); setEntityType('all'); setFrom(''); setTo(''); setPage(1); }
  const maxBar = Math.max(1, ...stats.byDay.map(item => Number(item.count || 0)));
  const maxAction = Math.max(1, ...stats.byAction.map(item => Number(item.count || 0)));

  return <main className="mx-auto w-full max-w-[1700px] space-y-5 p-4 pb-10 sm:p-6" dir="rtl">
    <header className="rounded-3xl border border-cyan-400/20 bg-gradient-to-br from-cyan-500/10 via-[var(--bg-surface)] to-violet-500/10 p-5 shadow-[var(--shadow-card)] sm:p-7">
      <div className="flex flex-wrap items-start justify-between gap-5">
        <div className="flex items-start gap-3"><div className="rounded-2xl bg-cyan-400/15 p-3 text-cyan-300"><FileSearch className="h-7 w-7" /></div><div><p className="text-xs font-bold uppercase tracking-[0.16em] text-cyan-300">WhatsApp / Audit Center</p><h1 className="mt-1 text-2xl font-black sm:text-3xl">مراقبة سجلات التدقيق</h1><p className="mt-2 max-w-3xl text-sm leading-6 text-[var(--text-muted)]">لوحة رسومية تقرأ سجل التدقيق الحقيقي لعمليات أتمتة الانضمام، وتعرض من نفّذ الإجراء، وما الكيان المتأثر، ومقارنة الحالة قبل وبعد، دون كشف أسرار الجلسات.</p></div></div>
        <div className="flex flex-wrap items-center gap-2"><a href="/whatsapp-join-automation" className="inline-flex items-center gap-2 rounded-xl border border-[var(--border-default)] px-3 py-2 text-xs font-bold text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"><ChevronRight className="h-4 w-4" />العودة للأتمتة</a><button type="button" onClick={refresh} disabled={loading || statsLoading} className="inline-flex items-center gap-2 rounded-xl bg-cyan-400 px-3 py-2 text-xs font-black text-slate-950 disabled:opacity-50"><RefreshCw className={cn('h-4 w-4', (loading || statsLoading) && 'animate-spin')} />تحديث الآن</button></div>
      </div>
      <div className="mt-5 flex flex-wrap items-center gap-3 text-xs text-[var(--text-muted)]"><span className="inline-flex items-center gap-2 rounded-full border border-emerald-400/25 bg-emerald-500/10 px-3 py-1.5 text-emerald-200"><span className="h-2 w-2 animate-pulse rounded-full bg-emerald-300" />تحديث حي</span><span>آخر حدث حي: {formatDate(lastLiveEvent || stats.lastEventAt)}</span><span>مصدر الحقيقة: PostgreSQL Audit Log</span></div>
    </header>

    <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <StatCard label="إجمالي السجلات" value={statsLoading ? '…' : stats.total} hint="ضمن الفلاتر الحالية" icon={BarChart3} tone="border-cyan-400/20 text-cyan-200" />
      <StatCard label="آخر 24 ساعة" value={statsLoading ? '…' : stats.last24h} hint="نشاط اليوم التشغيلي" icon={Zap} tone="border-emerald-400/20 text-emerald-200" />
      <StatCard label="آخر 7 أيام" value={statsLoading ? '…' : stats.last7d} hint="الاتجاه الأسبوعي" icon={CalendarDays} tone="border-violet-400/20 text-violet-200" />
      <StatCard label="المستخدمون المنفذون" value={statsLoading ? '…' : stats.actors} hint="حسابات فريدة في السجل" icon={UserRound} tone="border-amber-400/20 text-amber-200" />
    </section>

    <section className="rounded-3xl border border-[var(--border-default)] bg-[var(--bg-elevated)] p-4 shadow-[var(--shadow-card)] sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="flex items-center gap-2 text-lg font-black"><Filter className="h-5 w-5 text-cyan-300" />فلاتر السجل</h2><p className="mt-1 text-xs text-[var(--text-muted)]">يمكنك تضييق النتائج بالإجراء والكيان والتاريخ أو البحث داخل المعرفات والحالة اللاحقة.</p></div><div className="flex gap-2"><button type="button" onClick={resetFilters} className="rounded-xl border border-[var(--border-default)] px-3 py-2 text-xs font-bold text-[var(--text-muted)]">مسح الفلاتر</button><button type="button" onClick={exportLogs} className="inline-flex items-center gap-2 rounded-xl border border-cyan-400/25 px-3 py-2 text-xs font-bold text-cyan-200"><Download className="h-4 w-4" />تصدير CSV</button></div></div>
      <div className="mt-4 grid gap-3 md:grid-cols-2 lg:grid-cols-5"><label className="relative lg:col-span-2"><Search className="absolute right-3 top-2.5 h-4 w-4 text-[var(--text-muted)]" /><input value={search} onChange={event => { setSearch(event.target.value); setPage(1); }} placeholder="بحث بالإجراء أو المستخدم أو المعرف..." className="w-full rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] py-2.5 pr-9 pl-3 text-sm" /></label><select value={action} onChange={event => { setAction(event.target.value); setPage(1); }} className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] px-3 py-2 text-sm"><option value="all">كل الإجراءات</option>{Object.entries(actionLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select><select value={entityType} onChange={event => { setEntityType(event.target.value); setPage(1); }} className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] px-3 py-2 text-sm"><option value="all">كل الكيانات</option>{Object.entries(entityLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select><div className="grid grid-cols-2 gap-2"><label className="relative"><span className="sr-only">من تاريخ</span><input type="date" value={from} onChange={event => { setFrom(event.target.value); setPage(1); }} className="w-full rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] px-2 py-2 text-xs" /></label><label className="relative"><span className="sr-only">إلى تاريخ</span><input type="date" value={to} onChange={event => { setTo(event.target.value); setPage(1); }} className="w-full rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] px-2 py-2 text-xs" /></label></div></div>
    </section>

    <section className="grid gap-5 xl:grid-cols-[1.35fr_.65fr]">
      <div className="rounded-3xl border border-[var(--border-default)] bg-[var(--bg-elevated)] p-4 shadow-[var(--shadow-card)] sm:p-5"><div className="flex items-center justify-between gap-3"><div><h2 className="text-lg font-black">النشاط خلال آخر 14 يومًا</h2><p className="mt-1 text-xs text-[var(--text-muted)]">عدد أحداث التدقيق المسجلة لكل يوم ضمن الفلاتر الحالية.</p></div><Activity className="h-5 w-5 text-cyan-300" /></div><div className="mt-6 flex h-44 items-end gap-2 overflow-x-auto pb-6">{stats.byDay.length ? stats.byDay.map(item => <div key={item.day} className="flex min-w-8 flex-1 flex-col items-center justify-end gap-2"><span className="text-[10px] font-bold text-cyan-200">{item.count}</span><div className="w-full rounded-t-lg bg-gradient-to-t from-cyan-500/40 to-cyan-300 transition-all" style={{ height: `${Math.max(8, (Number(item.count) / maxBar) * 118)}px` }} title={`${item.day}: ${item.count}`} /><span className="rotate-[-45deg] whitespace-nowrap text-[9px] text-[var(--text-muted)]">{item.day.slice(5)}</span></div>) : <div className="flex w-full items-center justify-center text-sm text-[var(--text-muted)]">لا توجد بيانات في النطاق الحالي.</div>}</div></div>
      <div className="rounded-3xl border border-[var(--border-default)] bg-[var(--bg-elevated)] p-4 shadow-[var(--shadow-card)] sm:p-5"><div className="flex items-center justify-between gap-3"><div><h2 className="text-lg font-black">توزيع الإجراءات</h2><p className="mt-1 text-xs text-[var(--text-muted)]">أكثر العمليات ظهورًا في السجل.</p></div><BarChart3 className="h-5 w-5 text-violet-300" /></div><div className="mt-5 space-y-3">{stats.byAction.length ? stats.byAction.slice(0, 6).map(item => <div key={item.action}><div className="mb-1 flex items-center justify-between gap-3 text-xs"><span className="font-bold">{actionLabel(item.action)}</span><strong>{item.count}</strong></div><div className="h-2 overflow-hidden rounded-full bg-[var(--bg-surface)]"><div className="h-full rounded-full bg-gradient-to-l from-violet-400 to-cyan-400" style={{ width: `${Math.max(4, (Number(item.count) / maxAction) * 100)}%` }} /></div></div>) : <p className="py-8 text-center text-sm text-[var(--text-muted)]">لا توجد إجراءات.</p>}</div></div>
    </section>

    <section className="rounded-3xl border border-[var(--border-default)] bg-[var(--bg-elevated)] p-4 shadow-[var(--shadow-card)] sm:p-5"><div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="flex items-center gap-2 text-lg font-black"><Clock3 className="h-5 w-5 text-cyan-300" />الخط الزمني التفصيلي</h2><p className="mt-1 text-xs text-[var(--text-muted)]">{logs.total} سجل مطابق · انقر على أي سجل لعرض Before / After وبيانات الطلب.</p></div><span className="rounded-full border border-[var(--border-default)] bg-[var(--bg-surface)] px-3 py-1.5 text-xs text-[var(--text-muted)]">صفحة {logs.page} من {logs.totalPages}</span></div><div className="mt-4 overflow-x-auto rounded-2xl border border-[var(--border-default)]"><table className="w-full min-w-[900px] text-right text-xs"><thead className="bg-[var(--bg-surface)] text-[var(--text-muted)]"><tr><th className="p-3">الوقت</th><th className="p-3">المستخدم</th><th className="p-3">الإجراء</th><th className="p-3">الكيان</th><th className="p-3">المعرف</th><th className="p-3">النطاق</th><th className="p-3">التفاصيل</th></tr></thead><tbody>{loading ? <tr><td colSpan={7} className="p-12 text-center"><Loader2 className="mx-auto h-6 w-6 animate-spin text-cyan-300" /></td></tr> : logs.items.length ? logs.items.map(item => <tr key={String(item.id)} className="border-t border-[var(--border-default)] transition hover:bg-[var(--bg-hover)]"><td className="p-3 whitespace-nowrap"><span className="font-bold">{formatTime(item.created_at)}</span><span className="mt-1 block text-[10px] text-[var(--text-muted)]">{formatDate(item.created_at)}</span></td><td className="p-3"><span className="inline-flex items-center gap-2"><span className="rounded-lg bg-cyan-500/10 p-1.5 text-cyan-300"><UserRound className="h-3.5 w-3.5" /></span>{item.actor_username || 'مستخدم محذوف'}</span></td><td className="p-3"><span className={cn('inline-flex rounded-full border px-2.5 py-1 text-[10px] font-bold', toneClass(toneForAction(item.action)))}>{actionLabel(item.action)}</span></td><td className="p-3 text-[var(--text-secondary)]">{entityLabel(item.entity_type)}</td><td className="max-w-[150px] truncate p-3 font-mono text-[10px] text-cyan-200" dir="ltr">{item.entity_id || '—'}</td><td className="p-3"><span className="inline-flex items-center gap-1 text-[var(--text-muted)]"><ShieldCheck className="h-3.5 w-3.5 text-emerald-300" />محمي</span></td><td className="p-3"><button type="button" onClick={() => openDetail(item)} className="inline-flex items-center gap-1 rounded-lg border border-cyan-400/20 px-2 py-1.5 font-bold text-cyan-200 hover:bg-cyan-500/10"><Eye className="h-3.5 w-3.5" />عرض التفاصيل</button></td></tr>) : <tr><td colSpan={7} className="p-12 text-center text-sm text-[var(--text-muted)]">لا توجد سجلات مطابقة للفلاتر الحالية.</td></tr>}</tbody></table></div><div className="mt-4 flex items-center justify-between gap-3"><span className="text-xs text-[var(--text-muted)]">عرض {logs.items.length} من {logs.total}</span><div className="flex gap-2"><button type="button" disabled={logs.page <= 1 || loading} onClick={() => setPage(current => Math.max(1, current - 1))} className="inline-flex items-center gap-1 rounded-xl border border-[var(--border-default)] px-3 py-2 text-xs font-bold disabled:opacity-40"><ChevronRight className="h-4 w-4" />السابق</button><button type="button" disabled={logs.page >= logs.totalPages || loading} onClick={() => setPage(current => Math.min(logs.totalPages, current + 1))} className="inline-flex items-center gap-1 rounded-xl border border-[var(--border-default)] px-3 py-2 text-xs font-bold disabled:opacity-40">التالي<ChevronLeft className="h-4 w-4" /></button></div></div></section>

    {selected && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={() => setSelected(null)}><aside className="max-h-[90vh] w-full max-w-3xl overflow-auto rounded-3xl border border-[var(--border-strong)] bg-[var(--bg-surface)] p-5 shadow-2xl" onClick={event => event.stopPropagation()}><div className="flex items-start justify-between gap-3"><div><p className="text-xs font-bold text-cyan-300">سجل تدقيق #{selected.id}</p><h2 className="mt-1 text-xl font-black">{actionLabel(selected.action)}</h2><p className="mt-1 text-xs text-[var(--text-muted)]">{formatDate(selected.created_at)} · {selected.actor_username || 'مستخدم محذوف'}</p></div><button type="button" onClick={() => setSelected(null)} className="rounded-xl p-2 text-[var(--text-muted)] hover:bg-[var(--bg-hover)]"><X className="h-5 w-5" /></button></div>{detailLoading && <div className="mt-4 flex items-center gap-2 rounded-xl bg-cyan-500/5 p-3 text-xs text-cyan-200"><Loader2 className="h-4 w-4 animate-spin" />جارٍ تحميل التفاصيل الكاملة…</div>}<div className="mt-5 grid gap-3 sm:grid-cols-2"><div className="rounded-2xl bg-[var(--bg-elevated)] p-3"><span className="text-[11px] text-[var(--text-muted)]">المستخدم المنفذ</span><strong className="mt-1 block">{selected.actor_username || 'مستخدم محذوف'}</strong></div><div className="rounded-2xl bg-[var(--bg-elevated)] p-3"><span className="text-[11px] text-[var(--text-muted)]">الكيان المتأثر</span><strong className="mt-1 block">{entityLabel(selected.entity_type)} · <span className="font-mono text-xs" dir="ltr">{selected.entity_id || '—'}</span></strong></div><div className="rounded-2xl bg-[var(--bg-elevated)] p-3"><span className="text-[11px] text-[var(--text-muted)]">IP</span><strong className="mt-1 block font-mono text-xs" dir="ltr">{selected.ip || 'غير مسجل'}</strong></div><div className="rounded-2xl bg-[var(--bg-elevated)] p-3"><span className="text-[11px] text-[var(--text-muted)]">User Agent</span><strong className="mt-1 block truncate text-xs" dir="ltr">{selected.user_agent || 'غير مسجل'}</strong></div></div><div className="mt-4 grid gap-4 lg:grid-cols-2"><div><h3 className="mb-2 flex items-center gap-2 text-sm font-black text-amber-200"><AlertTriangle className="h-4 w-4" />الحالة قبل الإجراء</h3><pre className="min-h-40 overflow-auto rounded-2xl border border-amber-400/15 bg-slate-950/50 p-4 text-[11px] leading-5 text-amber-100" dir="ltr">{safeJson(selected.before_state)}</pre></div><div><h3 className="mb-2 flex items-center gap-2 text-sm font-black text-emerald-200"><ShieldCheck className="h-4 w-4" />الحالة بعد الإجراء</h3><pre className="min-h-40 overflow-auto rounded-2xl border border-emerald-400/15 bg-slate-950/50 p-4 text-[11px] leading-5 text-emerald-100" dir="ltr">{safeJson(selected.after_state)}</pre></div></div></aside></div>}
  </main>;
}

export { actionLabel, entityLabel };
