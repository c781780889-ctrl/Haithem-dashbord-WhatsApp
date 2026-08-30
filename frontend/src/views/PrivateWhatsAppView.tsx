import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  BarChart3,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Database,
  FileText,
  FolderKanban,
  Info,
  LayoutDashboard,
  MessageCircle,
  RefreshCw,
  Search,
  Send,
  Settings2,
  Smartphone,
  UserCheck,
  UserX,
  Users,
  UsersRound,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { authFetch, API } from '@/utils/api';
import { useToast } from '@/components/ui/ToastProvider';

type PanelId = 'overview' | 'contacts' | 'groups' | 'publishing' | 'inbox' | 'logs' | 'settings';
type ConsentStatus = 'OPTED_IN' | 'OPTED_OUT' | 'UNKNOWN';

type PrivateDashboard = {
  contacts?: { total?: number; optedIn?: number; optedOut?: number; unknown?: number };
  groupCount?: number;
  sourceAccountCount?: number;
  connectedSourceAccountCount?: number;
  publishingAccounts?: any[];
  publishingAccountsAvailable?: boolean;
  syncJobs?: any[];
};

type Contact = {
  id: string;
  normalized_phone: string;
  original_phone?: string;
  country_code?: string;
  consent_status: ConsentStatus;
  status: string;
  last_seen_at?: string;
  sources?: Array<{ groupName?: string; accountId?: string; role?: string }>;
};

type ContactResponse = {
  rows?: Contact[];
  total?: number;
  page?: number;
  limit?: number;
  pages?: number;
};

interface PrivateWhatsAppViewProps {
  accounts?: any[];
}

const panelItems: Array<{
  id: PanelId;
  label: string;
  description: string;
  icon: typeof LayoutDashboard;
  route?: string;
  available: boolean;
}> = [
  { id: 'overview', label: 'لوحة القسم', description: 'نظرة عامة على الوحدة', icon: LayoutDashboard, available: true },
  { id: 'groups', label: 'المجموعات', description: 'مصادر الجمع الحالية', icon: UsersRound, route: '/groups', available: true },
  { id: 'contacts', label: 'قاعدة الأرقام', description: 'قاعدة مركزية للمنظمين', icon: Database, available: true },
  { id: 'publishing', label: 'نشر واتس اب', description: 'الحملات وحسابات النشر', icon: Send, route: '/private-whatsapp/publishing', available: true },
  { id: 'inbox', label: 'الرد على «كلمني»', description: 'صندوق الرسائل الواردة', icon: MessageCircle, available: false },
  { id: 'logs', label: 'السجلات', description: 'سجل عمليات القسم', icon: FileText, available: true },
  { id: 'settings', label: 'الإعدادات', description: 'إعدادات الوحدة', icon: Settings2, route: '/private-whatsapp/settings', available: true },
];

function formatNumber(value: number | null | undefined) {
  return value === null || value === undefined ? 'غير متاح' : value.toLocaleString('ar');
}

function formatDate(value?: string) {
  if (!value) return 'غير متاح';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'غير متاح' : date.toLocaleString('ar');
}

function consentLabel(value: ConsentStatus) {
  return value === 'OPTED_IN' ? 'بموافقة' : value === 'OPTED_OUT' ? 'ممنوع' : 'غير محدد';
}

export default function PrivateWhatsAppView({ accounts = [] }: PrivateWhatsAppViewProps) {
  const navigate = useNavigate();
  const { addToast } = useToast();
  const [activePanel, setActivePanel] = useState<PanelId>('overview');
  const [dashboard, setDashboard] = useState<PrivateDashboard | null>(null);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [contactTotal, setContactTotal] = useState(0);
  const [contactPage, setContactPage] = useState(1);
  const [contactPages, setContactPages] = useState(1);
  const [contactSearch, setContactSearch] = useState('');
  const [consentFilter, setConsentFilter] = useState('');
  const [logs, setLogs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [contactsLoading, setContactsLoading] = useState(false);
  const [logsLoading, setLogsLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [countryCode, setCountryCode] = useState('');
  const [consentUpdating, setConsentUpdating] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const connectedAccounts = useMemo(
    () => accounts.filter(account => account.status === 'connected').length,
    [accounts],
  );

  const loadDashboard = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const response = await authFetch(`${API}/private-whatsapp/dashboard`);
      if (!response.ok) throw new Error('تعذر تحميل لوحة قسم خاص واتس اب');
      const data = await response.json();
      if (!data?.success) throw new Error(data?.error || 'استجابة غير متوقعة من الخادم');
      setDashboard(data.dashboard || null);
      setLastUpdated(new Date());
    } catch (error: any) {
      setDashboard(null);
      setLoadError(error?.message || 'تعذر تحميل البيانات');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadContacts = useCallback(async (page = 1) => {
    setContactsLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), limit: '20' });
      if (contactSearch.trim()) params.set('search', contactSearch.trim());
      if (consentFilter) params.set('consentStatus', consentFilter);
      const response = await authFetch(`${API}/private-whatsapp/contacts?${params.toString()}`);
      const data: ContactResponse = await response.json();
      if (!response.ok || !(data as any)?.success) throw new Error((data as any)?.error || 'تعذر تحميل قاعدة الأرقام');
      setContacts(data.rows || []);
      setContactTotal(Number(data.total || 0));
      setContactPage(Number(data.page || page));
      setContactPages(Math.max(1, Number(data.pages || 1)));
    } catch (error: any) {
      addToast({ type: 'error', title: 'تعذر تحميل الأرقام', description: error?.message || 'حدث خطأ غير متوقع.' });
    } finally {
      setContactsLoading(false);
    }
  }, [addToast, consentFilter, contactSearch]);

  const loadLogs = useCallback(async () => {
    setLogsLoading(true);
    try {
      const response = await authFetch(`${API}/private-whatsapp/logs?limit=25`);
      const data = await response.json();
      if (!response.ok || !data?.success) throw new Error(data?.error || 'تعذر تحميل السجلات');
      setLogs(data.logs || []);
    } catch (error: any) {
      addToast({ type: 'error', title: 'تعذر تحميل السجلات', description: error?.message || 'حدث خطأ غير متوقع.' });
    } finally {
      setLogsLoading(false);
    }
  }, [addToast]);

  useEffect(() => {
    loadDashboard();
    const interval = window.setInterval(loadDashboard, 30_000);
    return () => window.clearInterval(interval);
  }, [loadDashboard]);

  useEffect(() => {
    if (activePanel === 'contacts') loadContacts(1);
    if (activePanel === 'logs') loadLogs();
    // Search and consent filters are applied only after the user submits the form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePanel]);

  const startSync = useCallback(async () => {
    setSyncing(true);
    try {
      const response = await authFetch(`${API}/private-whatsapp/sync`, {
        method: 'POST',
        body: JSON.stringify({ defaultCountryCode: countryCode }),
      });
      const data = await response.json();
      if (!response.ok || !data?.success) throw new Error(data?.error || 'تعذر بدء المزامنة');
      addToast({ type: 'success', title: 'تمت جدولة المزامنة', description: 'ستعمل المزامنة في الخلفية ويمكن متابعة تقدمها من لوحة القسم.' });
      await loadDashboard();
    } catch (error: any) {
      addToast({ type: 'error', title: 'تعذر بدء المزامنة', description: error?.message || 'حدث خطأ غير متوقع.' });
    } finally {
      setSyncing(false);
    }
  }, [countryCode, loadDashboard]);

  const updateConsent = async (contact: Contact, consentStatus: ConsentStatus) => {
    setConsentUpdating(contact.id);
    try {
      const response = await authFetch(`${API}/private-whatsapp/contacts/${contact.id}/consent`, {
        method: 'PATCH',
        body: JSON.stringify({ consentStatus }),
      });
      const data = await response.json();
      if (!response.ok || !data?.success) throw new Error(data?.error || 'تعذر تحديث حالة الموافقة');
      setContacts(current => current.map(item => item.id === contact.id ? { ...item, ...data.contact } : item));
      addToast({ type: 'success', title: 'تم تحديث الموافقة', description: `${contact.normalized_phone} — ${consentLabel(consentStatus)}` });
      await loadDashboard();
    } catch (error: any) {
      addToast({ type: 'error', title: 'تعذر تحديث الموافقة', description: error?.message || 'حدث خطأ غير متوقع.' });
    } finally {
      setConsentUpdating(null);
    }
  };

  const openPanel = (item: (typeof panelItems)[number]) => {
    setActivePanel(item.id);
    if (item.route) {
      navigate(item.route);
      return;
    }
    if (!item.available) {
      addToast({ type: 'info', title: 'القسم قيد التجهيز', description: `واجهة «${item.label}» تحتاج خدمات خلفية إضافية لم تُفعّل بعد.` });
    }
  };

  const stats = [
    { label: 'الأرقام المركزية', value: dashboard?.contacts?.total, icon: Database, tone: 'text-cyan-300', note: `${formatNumber(dashboard?.contacts?.optedIn ?? 0)} بموافقة صريحة` },
    { label: 'المجموعات المتاحة', value: dashboard?.groupCount, icon: UsersRound, tone: 'text-emerald-300', note: 'من الحسابات العامة' },
    { label: 'حسابات الجمع العامة', value: dashboard?.sourceAccountCount ?? accounts.length, icon: Smartphone, tone: 'text-violet-300', note: `${formatNumber(dashboard?.connectedSourceAccountCount ?? connectedAccounts)} متصل` },
    { label: 'حسابات النشر الخاصة', value: dashboard?.publishingAccountsAvailable ? (dashboard.publishingAccounts?.length ?? 0) : null, icon: Send, tone: 'text-amber-300', note: 'منفصلة عن الحسابات العامة' },
  ];

  const latestSync = dashboard?.syncJobs?.[0];

  return (
    <div className="flex flex-col gap-6 animate-fade-in" dir="rtl">
      <section className="relative overflow-hidden rounded-3xl border border-[rgba(34,211,238,0.24)] bg-gradient-to-br from-[rgba(8,47,73,0.78)] via-[var(--bg-surface)] to-[var(--bg-surface)] p-6 md:p-8">
        <div className="pointer-events-none absolute -left-16 -top-20 h-52 w-52 rounded-full bg-cyan-400/10 blur-3xl" />
        <div className="relative flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-3xl">
            <div className="mb-4 flex flex-wrap items-center gap-2"><Badge variant="info" dot>وحدة مستقلة</Badge><span className="rounded-full border border-[var(--border-default)] bg-[var(--bg-elevated)] px-3 py-1 text-xs text-[var(--text-muted)]">PrivateWhatsApp</span></div>
            <div className="flex items-start gap-4"><div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border border-cyan-300/25 bg-cyan-300/10 text-cyan-200 shadow-[0_0_24px_rgba(34,211,238,0.14)]"><Smartphone className="h-7 w-7" /></div><div><h1 className="text-heading-xl text-primary">قسم خاص واتس اب</h1><p className="mt-2 max-w-2xl text-body-m leading-7 text-secondary">إدارة قاعدة أرقام مركزية ومزامنة آمنة من حسابات واتساب العامة، مع فصل واضح عن حسابات النشر الخاصة.</p></div></div>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end"><label className="text-right text-[11px] font-bold text-cyan-100/80">رمز الدولة للأرقام المحلية<input value={countryCode} onChange={event => setCountryCode(event.target.value.replace(/[^0-9]/g, '').slice(0, 3))} inputMode="numeric" dir="ltr" placeholder="مثال: 967" className="mt-1 w-full rounded-xl border border-cyan-200/20 bg-slate-950/30 px-3 py-2 text-sm text-white outline-none placeholder:text-white/35 focus:border-cyan-200/50 sm:w-32" /></label><button type="button" onClick={startSync} disabled={syncing} className="inline-flex items-center justify-center gap-2 rounded-xl bg-cyan-400 px-4 py-3 text-sm font-bold text-slate-950 shadow-[0_0_24px_rgba(34,211,238,0.22)] transition-all duration-200 hover:bg-cyan-300 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-60"><RefreshCw className={`h-4 w-4 ${syncing ? 'animate-spin' : ''}`} />{syncing ? 'جاري الجدولة…' : 'مزامنة الآن'}</button></div>
        </div>
      </section>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        {stats.map(stat => { const Icon = stat.icon; return <Card key={stat.label} className="border-[var(--border-default)] bg-[var(--bg-surface)] transition-colors hover:border-cyan-300/25"><CardContent className="p-5"><div className="flex items-start justify-between gap-3"><div><p className="text-xs font-medium text-muted">{stat.label}</p><p className="mt-3 text-2xl font-black text-primary">{loading ? '…' : formatNumber(stat.value)}</p></div><div className={`rounded-xl bg-[var(--bg-elevated)] p-3 ${stat.tone}`}><Icon className="h-5 w-5" /></div></div><p className="mt-3 text-xs text-muted">{stat.note}</p></CardContent></Card>; })}
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1.45fr)_minmax(320px,0.85fr)]">
        <Card className="overflow-hidden"><CardContent className="p-0"><div className="border-b border-[var(--border-default)] p-5 md:p-6"><div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-heading-s text-primary">مكوّنات القسم</h2><p className="mt-1 text-sm text-secondary">افتح قاعدة الأرقام أو السجلات من داخل الوحدة نفسها.</p></div><button type="button" onClick={loadDashboard} disabled={loading} className="inline-flex items-center gap-2 rounded-lg border border-[var(--border-default)] px-3 py-2 text-xs font-bold text-secondary transition-colors hover:border-cyan-300/40 hover:text-primary disabled:opacity-60"><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />تحديث الحالة</button></div></div><div className="grid gap-3 p-5 md:grid-cols-2 md:p-6">{panelItems.map(item => { const Icon = item.icon; const isActive = activePanel === item.id; return <button key={item.id} type="button" onClick={() => openPanel(item)} className={`group flex items-center gap-3 rounded-2xl border p-4 text-right transition-all duration-200 active:scale-[0.98] ${isActive ? 'border-cyan-300/45 bg-cyan-300/10' : 'border-[var(--border-default)] bg-[var(--bg-elevated)] hover:border-cyan-300/30 hover:bg-cyan-300/5'}`}><span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${isActive ? 'bg-cyan-300/20 text-cyan-200' : 'bg-[var(--bg-surface)] text-[var(--text-muted)] group-hover:text-cyan-200'}`}><Icon className="h-5 w-5" /></span><span className="min-w-0 flex-1"><span className="block text-sm font-bold text-primary">{item.label}</span><span className="mt-1 block truncate text-xs text-muted">{item.description}</span></span>{item.available ? <ChevronLeft className="h-4 w-4 shrink-0 text-muted" /> : <span className="shrink-0 rounded-full border border-amber-300/20 px-2 py-1 text-[10px] font-bold text-amber-200">قريبًا</span>}</button>; })}</div></CardContent></Card>

        <div className="flex flex-col gap-6"><Card><CardContent className="p-5 md:p-6"><div className="mb-5 flex items-center justify-between gap-3"><div><h2 className="text-heading-s text-primary">فصل الحسابات</h2><p className="mt-1 text-xs text-muted">الجمع لا يستخدم حسابات النشر</p></div><CheckCircle2 className="h-5 w-5 text-emerald-300" /></div><div className="space-y-3 text-sm"><div className="flex items-start gap-3 rounded-xl bg-emerald-300/5 p-3"><Users className="mt-0.5 h-4 w-4 shrink-0 text-emerald-300" /><div><p className="font-bold text-primary">حسابات الجمع العامة</p><p className="mt-1 text-xs leading-5 text-muted">{formatNumber(dashboard?.sourceAccountCount ?? accounts.length)} حساب ضمن مصدر البيانات الحالي.</p></div></div><div className="flex items-start gap-3 rounded-xl bg-amber-300/5 p-3"><Send className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" /><div><p className="font-bold text-primary">حسابات النشر الخاصة</p><p className="mt-1 text-xs leading-5 text-muted">تُدار كمورد منفصل ولا تدخل في عمليات الجمع.</p></div></div></div></CardContent></Card>
          <Card><CardContent className="p-5 md:p-6"><div className="flex items-center gap-3"><Activity className="h-5 w-5 text-cyan-300" /><div><h2 className="text-heading-s text-primary">آخر مزامنة</h2><p className="mt-1 text-xs text-muted">الحالة من قاعدة البيانات والـQueue</p></div></div>{latestSync ? <div className="mt-5 space-y-3"><div className="flex items-center justify-between"><span className="text-xs text-muted">الحالة</span><Badge variant={latestSync.status === 'COMPLETED' ? 'success' : latestSync.status === 'FAILED' ? 'danger' : 'info'} dot>{latestSync.status}</Badge></div><div className="grid grid-cols-2 gap-3 text-xs"><div className="rounded-xl bg-[var(--bg-elevated)] p-3"><span className="text-muted">المكتشف</span><strong className="mt-1 block text-primary">{formatNumber(latestSync.discovered_count)}</strong></div><div className="rounded-xl bg-[var(--bg-elevated)] p-3"><span className="text-muted">الجديد</span><strong className="mt-1 block text-primary">{formatNumber(latestSync.new_contacts_count)}</strong></div></div><p className="text-xs text-muted">بدأت في {formatDate(latestSync.created_at)}</p></div> : <p className="mt-5 rounded-xl bg-[var(--bg-elevated)] p-4 text-center text-xs text-muted">لا توجد مزامنة مسجلة بعد.</p>}</CardContent></Card>
        </div>
      </div>

      {activePanel === 'contacts' && <ContactsPanel contacts={contacts} total={contactTotal} page={contactPage} pages={contactPages} loading={contactsLoading} search={contactSearch} consentFilter={consentFilter} updating={consentUpdating} onSearch={value => { setContactSearch(value); setContactPage(1); }} onConsentFilter={value => { setConsentFilter(value); setContactPage(1); }} onSearchSubmit={() => loadContacts(1)} onPageChange={loadContacts} onConsent={updateConsent} />}
      {activePanel === 'logs' && <LogsPanel logs={logs} loading={logsLoading} onRefresh={loadLogs} />}

      {loadError && <div className="flex items-start gap-3 rounded-2xl border border-rose-300/20 bg-rose-300/5 p-4 text-xs leading-6 text-rose-100"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />{loadError}</div>}
      <div className="flex items-start gap-3 rounded-2xl border border-cyan-300/15 bg-cyan-300/5 p-4 text-xs leading-6 text-secondary"><Info className="mt-0.5 h-4 w-4 shrink-0 text-cyan-200" /><p>تظهر الأرقام غير المتاحة بصيغة «غير متاح». تبدأ جهات الاتصال بحالة موافقة UNKNOWN ولا تدخل في أي إرسال تلقائي قبل تسجيل موافقة صريحة.</p></div>
      <p className="flex items-center gap-2 text-[11px] text-muted"><Clock3 className="h-3.5 w-3.5" />آخر تحديث للوحة: {lastUpdated ? lastUpdated.toLocaleTimeString('ar') : 'غير متاح'}</p>
    </div>
  );
}

function ContactsPanel({ contacts, total, page, pages, loading, search, consentFilter, updating, onSearch, onConsentFilter, onSearchSubmit, onPageChange, onConsent }: { contacts: Contact[]; total: number; page: number; pages: number; loading: boolean; search: string; consentFilter: string; updating: string | null; onSearch: (value: string) => void; onConsentFilter: (value: string) => void; onSearchSubmit: () => void; onPageChange: (page: number) => void; onConsent: (contact: Contact, status: ConsentStatus) => void; }) {
  return <Card className="overflow-hidden"><CardContent className="p-0"><div className="border-b border-[var(--border-default)] p-5 md:p-6"><div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-heading-s text-primary">قاعدة الأرقام المركزية</h2><p className="mt-1 text-sm text-secondary">{formatNumber(total)} سجل وفق البيانات المتاحة في الخادم.</p></div><Badge variant="info" dot>مصدر مركزي</Badge></div><div className="mt-5 flex flex-col gap-3 sm:flex-row"><div className="relative flex-1"><Search className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" /><input value={search} onChange={event => onSearch(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') onSearchSubmit(); }} placeholder="ابحث بالرقم…" className="w-full rounded-xl border border-[var(--border-default)] bg-[var(--bg-elevated)] py-2.5 pr-10 pl-3 text-sm text-primary outline-none transition-colors focus:border-cyan-300/45" /></div><select value={consentFilter} onChange={event => onConsentFilter(event.target.value)} className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-elevated)] px-3 py-2 text-sm text-primary outline-none"><option value="">كل حالات الموافقة</option><option value="OPTED_IN">بموافقة</option><option value="OPTED_OUT">ممنوع</option><option value="UNKNOWN">غير محدد</option></select><button type="button" onClick={onSearchSubmit} className="inline-flex items-center justify-center gap-2 rounded-xl bg-cyan-400 px-4 py-2.5 text-sm font-bold text-slate-950 transition-colors hover:bg-cyan-300"><Search className="h-4 w-4" />بحث</button></div></div><div className="overflow-x-auto">{loading ? <div className="p-10 text-center text-sm text-muted">جارٍ تحميل قاعدة الأرقام…</div> : contacts.length === 0 ? <div className="p-10 text-center text-sm text-muted">لا توجد جهات اتصال مطابقة للفلاتر الحالية.</div> : <table className="w-full min-w-[760px] text-right text-sm"><thead className="bg-[var(--bg-elevated)] text-xs text-muted"><tr><th className="px-5 py-3 font-medium">الرقم</th><th className="px-5 py-3 font-medium">الحالة</th><th className="px-5 py-3 font-medium">المصادر</th><th className="px-5 py-3 font-medium">آخر ظهور</th><th className="px-5 py-3 font-medium">إجراء</th></tr></thead><tbody>{contacts.map(contact => <tr key={contact.id} className="border-t border-[var(--border-default)]"><td className="px-5 py-4 font-mono text-xs text-primary" dir="ltr">{contact.normalized_phone}</td><td className="px-5 py-4"><span className={`inline-flex rounded-full px-2.5 py-1 text-[11px] font-bold ${contact.consent_status === 'OPTED_IN' ? 'bg-emerald-300/10 text-emerald-200' : contact.consent_status === 'OPTED_OUT' ? 'bg-rose-300/10 text-rose-200' : 'bg-amber-300/10 text-amber-200'}`}>{consentLabel(contact.consent_status)}</span></td><td className="max-w-[230px] px-5 py-4 text-xs text-muted">{contact.sources?.length ? contact.sources.slice(0, 2).map(source => source.groupName || source.groupId || 'مصدر').join('، ') : 'غير متاح'}</td><td className="px-5 py-4 text-xs text-muted">{formatDate(contact.last_seen_at)}</td><td className="px-5 py-4"><div className="flex items-center gap-2">{contact.consent_status !== 'OPTED_IN' && <button type="button" disabled={updating === contact.id} onClick={() => onConsent(contact, 'OPTED_IN')} title="تسجيل موافقة صريحة" className="rounded-lg p-2 text-emerald-300 transition-colors hover:bg-emerald-300/10 disabled:opacity-50"><UserCheck className="h-4 w-4" /></button>}{contact.consent_status !== 'OPTED_OUT' && <button type="button" disabled={updating === contact.id} onClick={() => onConsent(contact, 'OPTED_OUT')} title="منع التواصل" className="rounded-lg p-2 text-rose-300 transition-colors hover:bg-rose-300/10 disabled:opacity-50"><UserX className="h-4 w-4" /></button>}</div></td></tr>)}</tbody></table>}</div><div className="flex items-center justify-between border-t border-[var(--border-default)] p-4 text-xs text-muted"><span>صفحة {formatNumber(page)} من {formatNumber(pages)}</span><div className="flex items-center gap-2"><button type="button" disabled={page <= 1 || loading} onClick={() => onPageChange(page - 1)} className="rounded-lg border border-[var(--border-default)] p-2 hover:border-cyan-300/40 disabled:opacity-40"><ChevronRight className="h-4 w-4" /></button><button type="button" disabled={page >= pages || loading} onClick={() => onPageChange(page + 1)} className="rounded-lg border border-[var(--border-default)] p-2 hover:border-cyan-300/40 disabled:opacity-40"><ChevronLeft className="h-4 w-4" /></button></div></div></CardContent></Card>;
}

function LogsPanel({ logs, loading, onRefresh }: { logs: any[]; loading: boolean; onRefresh: () => void }) {
  return <Card><CardContent className="p-0"><div className="flex items-center justify-between border-b border-[var(--border-default)] p-5"><div><h2 className="text-heading-s text-primary">سجلات القسم</h2><p className="mt-1 text-xs text-muted">آخر العمليات المسجلة في Private WhatsApp.</p></div><button type="button" onClick={onRefresh} disabled={loading} className="inline-flex items-center gap-2 rounded-lg border border-[var(--border-default)] px-3 py-2 text-xs font-bold text-secondary hover:border-cyan-300/40 disabled:opacity-50"><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />تحديث</button></div>{loading ? <div className="p-10 text-center text-sm text-muted">جارٍ تحميل السجلات…</div> : logs.length === 0 ? <div className="p-10 text-center text-sm text-muted">لا توجد سجلات بعد.</div> : <div className="divide-y divide-[var(--border-default)]">{logs.map(log => <div key={log.id} className="flex flex-wrap items-center justify-between gap-3 p-4"><div><p className="text-sm font-bold text-primary">{log.action}</p><p className="mt-1 text-xs text-muted">{log.entity_type} · {formatDate(log.created_at)}</p></div><span className="rounded-lg bg-[var(--bg-elevated)] px-3 py-2 text-[11px] text-secondary">تم التسجيل</span></div>)}</div>}</CardContent></Card>;
}
