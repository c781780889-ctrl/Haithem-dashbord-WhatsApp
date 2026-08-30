import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import {
  Activity, AlertTriangle, BarChart3, Bot, Calendar, Check, CheckCircle2, CheckSquare,
  ChevronDown, CircleDot, Clock3, CloudCog, Copy, Download, Eye, Filter, Gauge,
  Link2, ListChecks, Loader2, Pause, Play, Radio, RefreshCw, Search, Send,
  ServerCog, ShieldCheck, Signal, Square, TimerReset, Trash2, UserRound, Users, FileSearch,
  Wifi, WifiOff, Workflow, X, Zap,
} from 'lucide-react';
import { io } from 'socket.io-client';
import { API, authFetch, TOKEN_KEY, USER_KEY } from '../utils/api';
import { useToast } from '../components/ui/ToastProvider';
import JoinAutomationImportPanel from '../components/JoinAutomationImportPanel';
import { cn } from '@/utils/cn';

type LinkRow = {
  id: string;
  whatsapp_link: string;
  source_account_id?: string;
  source_account_name?: string;
  source_group?: string;
  discovered_at?: string;
  last_seen?: string;
  last_verified_at?: string;
  duplicate_count?: number;
  source_history?: Array<{ accountName?: string; group?: string; seenAt?: string }>;
  status?: string;
  processing_status?: string;
  joined?: boolean;
  next_operation?: string | null;
  last_operation_id?: string;
  notes?: string;
};

type SourceAccount = {
  id: string;
  name: string;
  phone_number?: string;
  status?: string;
  last_activity_at?: string;
  links_collected?: number;
  channels_monitored?: number;
  auth_required?: boolean;
  worker?: { status?: string; linksFound?: number; lastCheck?: string; error?: string } | null;
};

type JoinAccount = {
  id: string;
  name: string;
  phone_number?: string;
  status?: string;
  health_status?: string;
  task_status?: string;
  circuit_breaker_state?: string;
  protection_reason_code?: string | null;
  protection_reason?: string | null;
  consecutive_503?: number;
  deferred_count?: number;
  lock_collision_count?: number;
  recovery_count?: number;
  retry_count?: number;
  is_ready?: boolean;
  last_activity_at?: string;
};

type JoinCycle = {
  id: string;
  account_id: string;
  account_name?: string;
  account_phone?: string;
  cycle_number: number;
  cycle_start: string;
  cycle_end?: string | null;
  processed_count: number;
  success_count: number;
  request_count: number;
  failed_count: number;
  status: string;
  next_cycle_at?: string | null;
  next_run_at?: string | null;
  cycle_limit?: number;
  cycle_duration_minutes?: number;
  auto_resume?: boolean;
  circuit_breaker_state?: string;
  protection_reason_code?: string | null;
  protection_reason?: string | null;
  active_or_future_jobs?: number;
  consecutive_503?: number;
  deferred_count?: number;
  lock_collision_count?: number;
  recovery_count?: number;
  retry_count?: number;
};

type TaskDashboard = {
  task?: any;
  operations?: any[];
  cycles?: JoinCycle[];
  events?: any[];
  stats?: Record<string, number>;
  progress?: number;
};

type DiscoveryJob = { id: string; queue_job_id?: string; status: string; source_account_ids?: string[]; messages_scanned?: number; found_count?: number; error?: string | null; started_at?: string; completed_at?: string; created_at?: string; updated_at?: string };

async function readApiJson(response: Response): Promise<any> {
  const body = await response.text();
  try { return body ? JSON.parse(body) : {}; }
  catch { throw new Error(`استجابة غير صالحة من الخادم (HTTP ${response.status})`); }
}

type Dashboard = {
  links: LinkRow[];
  sources: SourceAccount[];
  joinAccounts: JoinAccount[];
  workers: any[];
  stats: { total: number; valid: number; processing: number; completed: number; failed: number; deferred: number; activeWorkers: number };
  latestTask?: any;
  latestDiscoveryJob?: DiscoveryJob | null;
  nextOperationAt?: string | null;
  cycleStates?: JoinCycle[];
  systemStatus: string;
  health?: { status?: string; checkedAt?: string; components?: Record<string, any> };
  pagination?: { page: number; pageSize: number; total: number; totalPages: number; sortBy?: string; sortDirection?: string };
};

type HealthAccount = {
  account_id: string;
  account_name?: string;
  account_phone?: string;
  account_status?: string;
  health_status?: string;
  worker_status?: string;
  last_heartbeat?: string;
  last_event_at?: string;
  last_error?: string;
  heartbeat_age_seconds?: number | null;
  heartbeat_fresh?: boolean;
  updated_at?: string;
};

type LiveMetricTone = 'cyan' | 'emerald' | 'amber' | 'rose' | 'violet' | 'sky';

type DatePreset = 'all' | 'today' | 'yesterday' | '7d' | '30d' | 'custom';
type AutomationSettings = { automation_enabled: boolean; min_delay_seconds: number; max_delay_seconds: number; max_concurrent_jobs: number; retry_count: number; retry_backoff_seconds: number; queue_priority: number; daily_operation_limit: number; daily_limit_protection_enabled: boolean; cycle_limit: number; cycle_duration_minutes: number; auto_resume: boolean; account_settings: Record<string, { enabled?: boolean; maxConcurrent?: number; pauseOnError?: boolean; healthThreshold?: number }> };

const initialStats = { total: 0, valid: 0, processing: 0, completed: 0, failed: 0, deferred: 0, activeWorkers: 0 };
const initialSettings: AutomationSettings = { automation_enabled: true, min_delay_seconds: 60, max_delay_seconds: 180, max_concurrent_jobs: 1, retry_count: 2, retry_backoff_seconds: 15, queue_priority: 5, daily_operation_limit: 10, daily_limit_protection_enabled: false, cycle_limit: 30, cycle_duration_minutes: 60, auto_resume: true, account_settings: {} };
const statusLabels: Record<string, string> = {
  new: 'صالح', valid: 'صالح', joined: 'مكتمل', completed: 'مكتمل', already_member: 'منضم مسبقًا', processing: 'قيد المعالجة', queued: 'مؤجل', pending: 'مؤجل', deferred: 'مؤجل', retry: 'إعادة محاولة', failed: 'فشل', review: 'يحتاج مراجعة', banned: 'محظور', invalid: 'غير صالح', unavailable: 'غير متاح',
};
const statusClasses: Record<string, string> = {
  new: 'bg-emerald-500/10 text-emerald-300 border-emerald-400/25', valid: 'bg-emerald-500/10 text-emerald-300 border-emerald-400/25', joined: 'bg-violet-500/10 text-violet-300 border-violet-400/25', already_member: 'bg-violet-500/10 text-violet-300 border-violet-400/25', completed: 'bg-violet-500/10 text-violet-300 border-violet-400/25', queued: 'bg-amber-500/10 text-amber-300 border-amber-400/25', processing: 'bg-sky-500/10 text-sky-300 border-sky-400/25', pending: 'bg-amber-500/10 text-amber-300 border-amber-400/25', deferred: 'bg-amber-500/10 text-amber-300 border-amber-400/25', failed: 'bg-rose-500/10 text-rose-300 border-rose-400/25', review: 'bg-orange-500/10 text-orange-300 border-orange-400/25', banned: 'bg-rose-600/20 text-rose-200 border-rose-400/50', invalid: 'bg-rose-500/10 text-rose-300 border-rose-400/25', unavailable: 'bg-slate-500/10 text-slate-300 border-slate-400/25',
};

function formatDate(value?: string | null) {
  if (!value) return '—';
  try { return new Date(value).toLocaleString('ar-SA', { dateStyle: 'short', timeStyle: 'short' }); } catch { return '—'; }
}
function formatCountdown(value?: string | null) {
  if (!value) return 'لا توجد عملية مجدولة';
  const diff = new Date(value).getTime() - Date.now();
  if (diff <= 0) return 'قريبًا';
  const seconds = Math.ceil(diff / 1000);
  if (seconds < 60) return `${seconds} ث`; 
  if (seconds < 3600) return `${Math.ceil(seconds / 60)} د`;
  return `${Math.ceil(seconds / 3600)} س`;
}
function formatDuration(from?: string | null, to?: string | null) {
  if (!from) return '—';
  const seconds = Math.max(0, Math.floor((new Date(to || Date.now()).getTime() - new Date(from).getTime()) / 1000));
  if (seconds < 60) return `${seconds} ث`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} د ${seconds % 60} ث`;
  return `${Math.floor(seconds / 3600)} س ${Math.floor((seconds % 3600) / 60)} د`;
}
function timeAgo(value?: string | null) {
  if (!value) return 'لا توجد إشارة';
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return `منذ ${seconds} ث`;
  if (seconds < 3600) return `منذ ${Math.floor(seconds / 60)} د`;
  return `منذ ${Math.floor(seconds / 3600)} س`;
}
function toneClasses(tone: LiveMetricTone) {
  return {
    cyan: 'border-cyan-400/25 bg-cyan-400/10 text-cyan-200',
    emerald: 'border-emerald-400/25 bg-emerald-400/10 text-emerald-200',
    amber: 'border-amber-400/25 bg-amber-400/10 text-amber-200',
    rose: 'border-rose-400/25 bg-rose-400/10 text-rose-200',
    violet: 'border-violet-400/25 bg-violet-400/10 text-violet-200',
    sky: 'border-sky-400/25 bg-sky-400/10 text-sky-200',
  }[tone];
}
function toSeconds(value: number, unit: string) {
  const n = Math.max(0, Number(value) || 0);
  return unit === 'minutes' ? n * 60 : unit === 'hours' ? n * 3600 : n;
}
function isEligibleJoinAccount(account: JoinAccount) {
  return account.status === 'connected' && account.is_ready !== false && account.circuit_breaker_state !== 'OPEN' && !['blocked', 'protected', 'stopped'].includes(account.health_status || '') && account.task_status !== 'stopped';
}
function protectionLabel(account: JoinAccount) {
  if (account.status === 'banned' || account.protection_reason_code === 'ACCOUNT_BANNED') return 'حظر 403 من WhatsApp';
  if (account.protection_reason_code === 'CONNECTION_503_STORM') return 'تكرار انقطاع 503';
  if (account.circuit_breaker_state === 'OPEN') return account.protection_reason_code || 'Circuit Breaker مفتوح';
  if (['blocked', 'protected'].includes(account.health_status || '') || account.task_status === 'stopped') return 'الحساب محمي أو موقوف';
  return null;
}
function discoveryStatusLabel(status?: string) {
  return status === 'queued' ? 'في الطابور' : status === 'running' ? 'قيد التنفيذ' : status === 'completed' ? 'اكتمل' : status === 'stopped' ? 'متوقف' : status === 'failed' ? 'فشل' : status || 'غير معروف';
}

function StatCard({ label, value, sub, icon: Icon, tone }: { label: string; value: string | number; sub?: string; icon: any; tone: string }) {
  return <div className="rounded-2xl border border-[var(--border-default)] bg-[var(--bg-surface)] p-4 shadow-sm">
    <div className="flex items-start justify-between gap-3"><div><p className="text-xs text-[var(--text-muted)]">{label}</p><p className="mt-2 text-2xl font-black text-[var(--text-primary)]">{value}</p>{sub && <p className="mt-1 text-[11px] text-[var(--text-muted)]">{sub}</p>}</div><div className={cn('rounded-xl p-2.5', tone)}><Icon className="h-5 w-5" /></div></div>
  </div>;
}
function StatusBadge({ value }: { value?: string }) {
  const key = value || 'new';
  return <span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[11px] font-bold', statusClasses[key] || statusClasses.new)}><span className="h-1.5 w-1.5 rounded-full bg-current" />{statusLabels[key] || key}</span>;
}
function SectionTitle({ icon: Icon, title, description, action }: { icon: any; title: string; description?: string; action?: React.ReactNode }) {
  return <div className="mb-4 flex flex-wrap items-start justify-between gap-3"><div className="flex items-start gap-3"><div className="rounded-xl bg-cyan-500/10 p-2 text-cyan-300"><Icon className="h-5 w-5" /></div><div><h2 className="text-base font-black">{title}</h2>{description && <p className="mt-1 text-xs leading-5 text-[var(--text-muted)]">{description}</p>}</div></div>{action}</div>;
}

export default function JoinAutomationView() {
  const { addToast } = useToast();
  const [dashboard, setDashboard] = useState<Dashboard>({ links: [], sources: [], joinAccounts: [], workers: [], stats: initialStats, systemStatus: 'stopped' });
  const [taskDashboard, setTaskDashboard] = useState<TaskDashboard | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [searching, setSearching] = useState(false);
  const [searchJobId, setSearchJobId] = useState<string | null>(null);
  const [searchJobStatus, setSearchJobStatus] = useState<string | null>(null);
  const [selectedSourceIds, setSelectedSourceIds] = useState<Set<string>>(new Set());
  const [selectedJoinAccountIds, setSelectedJoinAccountIds] = useState<Set<string>>(new Set());
  const [selectedLinkIds, setSelectedLinkIds] = useState<Set<string>>(new Set());
  const [allLinksSelected, setAllLinksSelected] = useState(false);
  const [selectionLoading, setSelectionLoading] = useState(false);
  const [filterAccountIds, setFilterAccountIds] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [sourceFilter, setSourceFilter] = useState('all');
  const [datePreset, setDatePreset] = useState<DatePreset>('all');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [applyAll, setApplyAll] = useState(true);
  const [minDelay, setMinDelay] = useState(60);
  const [maxDelay, setMaxDelay] = useState(180);
  const [delayUnit, setDelayUnit] = useState('seconds');
  const [reviewOpen, setReviewOpen] = useState(false);
  const [detailsLink, setDetailsLink] = useState<LinkRow | null>(null);
  const [detailsData, setDetailsData] = useState<any>(null);
  const [notifications, setNotifications] = useState<Array<{ id: number; text: string; tone: 'success' | 'warning' | 'error' | 'info' }>>([]);
  const [showCompleted, setShowCompleted] = useState(false);
  const [sortBy, setSortBy] = useState<'discovered_at' | 'last_verified_at' | 'status'>('discovered_at');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(1);
  const pageSize = 50;
  const [settings, setSettings] = useState<AutomationSettings>(initialSettings);
  const sourceSelectionInitialized = useRef(false);
  const taskRequestIdRef = useRef<string | null>(null);
  const searchRequestIdRef = useRef<string | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);
  const [revalidatingAccountId, setRevalidatingAccountId] = useState<string | null>(null);

  const notify = useCallback((text: string, tone: 'success' | 'warning' | 'error' | 'info' = 'info') => {
    setNotifications(current => [{ id: Date.now() + Math.random(), text, tone }, ...current].slice(0, 12));
    addToast({ title: text, type: tone === 'error' ? 'error' : tone === 'warning' ? 'warning' : 'success' });
  }, [addToast]);

  const fetchDashboard = useCallback(async () => {
    try {
      const response = await authFetch(`${API}/whatsapp/join-automation/dashboard?page=${page}&pageSize=${pageSize}&sortBy=${sortBy}&sortDirection=${sortDirection}`);
      const data = await readApiJson(response);
      if (!response.ok || !data.success) throw new Error(data.error || 'تعذر تحميل بيانات الأتمتة');
      setDashboard(data);
      if (data.latestDiscoveryJob) {
        setSearchJobId(String(data.latestDiscoveryJob.id));
        setSearchJobStatus(String(data.latestDiscoveryJob.status || ''));
      }
      const sourceIds = new Set<string>((data.sources || []).map((source: SourceAccount) => String(source.id)));
      if (!sourceSelectionInitialized.current) {
        setSelectedSourceIds(sourceIds);
        sourceSelectionInitialized.current = true;
      } else {
        setSelectedSourceIds(previous => new Set([...previous].filter(id => sourceIds.has(String(id)))));
      }
      setSelectedJoinAccountIds(previous => previous.size ? previous : new Set());
      if (!taskId && data.latestTask?.id) setTaskId(data.latestTask.id);
    } catch (error: any) {
      notify(error.message || 'فشل تحميل لوحة الأتمتة', 'error');
    } finally { setLoading(false); }
  }, [notify, taskId, page, pageSize, sortBy, sortDirection]);

  const fetchSettings = useCallback(async () => {
    try { const response = await authFetch(`${API}/whatsapp/join-automation/settings`); const data = await readApiJson(response); if (response.ok && data.success) { setSettings(data.settings); setMinDelay(Math.max(1, Math.floor(Number(data.settings.min_delay_seconds || 60)))); setMaxDelay(Math.max(1, Math.floor(Number(data.settings.max_delay_seconds || 180)))); } }
    catch { /* the dashboard remains usable with defaults */ }
  }, []);

  const fetchTask = useCallback(async () => {
    if (!taskId) { setTaskDashboard(null); return; }
    try {
      const response = await authFetch(`${API}/whatsapp/link-import/tasks/${taskId}`);
      const data = await readApiJson(response);
      if (response.ok && data.success) setTaskDashboard(data);
    } catch { /* refresh loop will retry */ }
  }, [taskId]);

  useEffect(() => { fetchDashboard(); fetchTask(); fetchSettings(); const interval = window.setInterval(() => { fetchDashboard(); fetchTask(); }, 8000); return () => window.clearInterval(interval); }, [fetchDashboard, fetchTask, fetchSettings]);

  useEffect(() => {
    const token = localStorage.getItem(TOKEN_KEY);
    let userId: string | null = null;
    try { userId = JSON.parse(localStorage.getItem(USER_KEY) || 'null')?.id || null; } catch { /* ignore */ }
    const socket = io();
    if (userId) socket.emit('join_user', { userId, token });
    const refresh = () => { fetchDashboard(); fetchTask(); };
    const onNewLink = () => { notify('تم اكتشاف رابط جديد وإضافته إلى القائمة', 'success'); refresh(); };
    const onDuplicate = () => { notify('تم تحديث رابط مكرر وإضافة مصدر الاكتشاف', 'info'); refresh(); };
    const onWorker = () => { refresh(); };
    const onEvent = (event: any) => { if (event?.eventType) { const type = String(event.eventType); const payload = event.payload || {}; const labels: Record<string, string> = { queue_outbox_created: 'تم حفظ العملية في Outbox بانتظار الإرسال', queue_enqueued: 'تم إرسال العملية إلى Queue بانتظار العامل', job_received: 'استلم العامل العملية', job_started: 'بدأ العامل تنفيذ العملية', account_selected: 'تم اختيار الحساب للعملية', link_resolved: 'تم استخراج كود دعوة الرابط', join_started: 'بدأ طلب الانضمام إلى المجموعة', join_request_started: 'أُرسل طلب الانضمام إلى WhatsApp', join_result_received: payload.success ? 'أعاد WhatsApp نتيجة الانضمام' : `رفض WhatsApp الانضمام: ${payload.error || payload.status || 'سبب غير محدد'}`, join_completed: 'تم تأكيد الانضمام داخل بيانات المجموعة', join_request_sent: 'تم إرسال طلب الانضمام وتسجيله ضمن الدورة', cycle_started: 'بدأت دورة جديدة للحساب', cycle_resting: 'انتهت دورة الحساب ودخلت فترة الاستراحة', account_pacing_wait: `تأجيل العملية لحماية الفاصل الزمني: ${payload.delaySeconds || 0} ثانية`, operation_completed: 'اكتملت عملية الانضمام', operation_failed: `فشلت العملية: ${payload.error || payload.message || 'راجع تفاصيل العملية'}`, account_unavailable: `الحساب غير متاح: ${payload.reason || 'راجع حالة الحساب'}`, account_protection_triggered: `تم تفعيل حماية الحساب: ${payload.reason || 'إشارة تقييد من WhatsApp'}`, account_protected: `تم فتح حماية الحساب وإيقاف التشغيل: ${payload.reason || 'سبب تشغيلي'}`, outbox_blocked: 'تم منع Outbox لأن الحساب محمي أو محظور', reschedule_blocked: 'تم منع إعادة الجدولة بسبب حالة الحساب', recovery_blocked: 'تم منع Recovery لأن الحساب محمي أو محظور', operation_paused: `تم إيقاف العملية مؤقتًا: ${payload.reason || 'إيقاف يدوي'}`, emergency_stop: 'تم إيقاف أتمتة الانضمام بالكامل بالطوارئ', account_manual_stop: 'تم إيقاف الحساب يدويًا', lock_deferred: `تأجيل بسبب قفل الحساب: ${payload.delaySeconds || 0} ثانية`, retry_scheduled: `تمت جدولة إعادة المحاولة: ${payload.delaySeconds || 0} ثانية`, join_retry: `ستُعاد المحاولة لاحقًا: ${payload.error || 'خطأ مؤقت'}`, paused_at_stage: 'تم إيقاف العملية مؤقتًا', stopped_at_stage: 'تم إيقاف العملية' }; const message = labels[type] || `تحديث العملية: ${type}`; notify(message, type.includes('failed') || type === 'account_protection_triggered' || type === 'account_protected' || type === 'account_manual_stop' || type === 'emergency_stop' || type === 'outbox_blocked' || type === 'recovery_blocked' || type === 'account_unavailable' || (type === 'join_result_received' && payload.success === false) ? 'warning' : type === 'operation_completed' || type === 'join_completed' ? 'success' : 'info'); } refresh(); };
    const onSearchStarted = (event: any) => { setSearchJobId(String(event?.discoveryJobId || '')); setSearchJobStatus('running'); refresh(); };
    const onSearchComplete = (event: any) => { setSearchJobId(String(event?.discoveryJobId || '')); setSearchJobStatus(String(event?.status || 'completed')); notify(`اكتمل بحث الروابط؛ تمت مراجعة ${Number(event?.foundCount || 0)} رابط`, 'success'); refresh(); };
    const onSearchFailed = (event: any) => { setSearchJobId(String(event?.discoveryJobId || '')); setSearchJobStatus('failed'); notify(event?.error || 'فشل Job البحث الحقيقي', 'error'); refresh(); };
    const onAccountBanned = (event: any) => { notify(`تم إيقاف الحساب ${event?.accountId || ''} بعد إشارة منع من WhatsApp؛ راجع الحساب رسميًا قبل أي إعادة تشغيل.`, 'error'); refresh(); };
    socket.on('whatsapp:new_link', onNewLink);
    socket.on('whatsapp:link_duplicate', onDuplicate);
    socket.on('link_import:event', onEvent);
    socket.on('join_automation:search_started', onSearchStarted);
    socket.on('join_automation:search_complete', onSearchComplete);
    socket.on('join_automation:search_failed', onSearchFailed);
    socket.on('account_banned', onAccountBanned);
    return () => { socket.off(); socket.disconnect(); };
  }, [fetchDashboard, fetchTask, notify]);

  const sourceNames = useMemo(() => [...new Set(dashboard.links.map(link => link.source_group).filter(Boolean) as string[])], [dashboard.links]);
  const filteredLinks = useMemo(() => {
    const now = new Date();
    const from = datePreset === 'today' ? new Date(now.getFullYear(), now.getMonth(), now.getDate()) : datePreset === 'yesterday' ? new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1) : datePreset === '7d' ? new Date(Date.now() - 7 * 86400000) : datePreset === '30d' ? new Date(Date.now() - 30 * 86400000) : customFrom ? new Date(`${customFrom}T00:00:00`) : null;
    const to = datePreset === 'yesterday' ? new Date(now.getFullYear(), now.getMonth(), now.getDate()) : customTo ? new Date(`${customTo}T23:59:59`) : null;
    return dashboard.links.filter(link => {
      const status = link.processing_status || link.status || 'new';
      const matchesSearch = !search || `${link.whatsapp_link} ${link.source_group || ''} ${link.source_account_name || ''}`.toLowerCase().includes(search.toLowerCase());
      const matchesAccount = !filterAccountIds.length || filterAccountIds.includes(String(link.source_account_id || ''));
      const matchesSource = sourceFilter === 'all' || link.source_group === sourceFilter;
      const matchesStatus = statusFilter === 'all' || status === statusFilter || link.status === statusFilter;
      const discovered = link.discovered_at ? new Date(link.discovered_at) : null;
      const matchesDate = !from || !discovered || (discovered >= from && (!to || discovered <= to));
      const matchesCompleted = showCompleted || !['completed', 'joined', 'success'].includes(status);
      return matchesSearch && matchesAccount && matchesSource && matchesStatus && matchesDate && matchesCompleted;
    });
  }, [dashboard.links, search, filterAccountIds, sourceFilter, statusFilter, datePreset, customFrom, customTo, showCompleted]);
  const sortedLinks = useMemo(() => [...filteredLinks].sort((left, right) => { const l = sortBy === 'status' ? (left.processing_status || left.status || '') : (left[sortBy] || ''); const r = sortBy === 'status' ? (right.processing_status || right.status || '') : (right[sortBy] || ''); const comparison = String(l).localeCompare(String(r)); return sortDirection === 'asc' ? comparison : -comparison; }), [filteredLinks, sortBy, sortDirection]);
  const pageCount = dashboard.pagination?.totalPages || Math.max(1, Math.ceil(sortedLinks.length / pageSize));
  const paginatedLinks = dashboard.pagination ? sortedLinks : sortedLinks.slice((page - 1) * pageSize, page * pageSize);
  useEffect(() => {
    setPage(1);
    setSelectedLinkIds(new Set());
    setAllLinksSelected(false);
  }, [search, filterAccountIds, sourceFilter, statusFilter, datePreset, customFrom, customTo, showCompleted, sortBy, sortDirection]);

  const selectedLinks = dashboard.links.filter(link => selectedLinkIds.has(link.id));
  const selectedLinksCount = allLinksSelected ? selectedLinkIds.size : selectedLinks.length;
  const validSelectedLinks = selectedLinks.filter(link => !['invalid', 'unavailable'].includes(link.status || link.processing_status || ''));
  const validSelectedLinksCount = allLinksSelected ? selectedLinkIds.size : validSelectedLinks.length;
  const selectedJoinAccounts = dashboard.joinAccounts.filter(account => selectedJoinAccountIds.has(account.id));
  const selectedSources = dashboard.sources.filter(source => selectedSourceIds.has(source.id));
  const accountOperationStats = useMemo(() => {
    const stats: Record<string, { operations: number; errors: number; links: number }> = {};
    (taskDashboard?.operations || []).forEach((operation: any) => {
      const key = String(operation.account_id || operation.accountId || '');
      if (!key) return;
      stats[key] ||= { operations: 0, errors: 0, links: 0 };
      stats[key].operations += 1;
      stats[key].links += 1;
      if (['failed', 'review'].includes(operation.status)) stats[key].errors += 1;
    });
    return stats;
  }, [taskDashboard?.operations]);
  const cycleByAccount = useMemo(() => new Map((dashboard.cycleStates || []).map(cycle => [String(cycle.account_id), cycle])), [dashboard.cycleStates]);
  const taskProgress = taskDashboard?.progress ?? (dashboard.latestTask?.completed_operations && dashboard.latestTask?.total_operations ? Math.round((dashboard.latestTask.completed_operations / dashboard.latestTask.total_operations) * 100) : 0);
  const taskStatus = taskDashboard?.task?.status || dashboard.latestTask?.status || 'stopped';
  const healthAccounts = useMemo<HealthAccount[]>(() => (dashboard.health?.components?.accounts?.details || []) as HealthAccount[], [dashboard.health]);
  const queueHealth = dashboard.health?.components?.queue || {};
  const queueStats = queueHealth.stats || {};
  const joinQueueStats = queueStats['wa-link-imports'] || queueStats['wa-link-import'] || {};
  const latestOperation = useMemo(() => {
    const operations = taskDashboard?.operations || [];
    return [...operations].sort((a, b) => new Date(b.updated_at || b.created_at || 0).getTime() - new Date(a.updated_at || a.created_at || 0).getTime())[0];
  }, [taskDashboard?.operations]);
  const activeOperation = useMemo(() => (taskDashboard?.operations || []).find(item => ['processing', 'retry'].includes(item.status)) || latestOperation, [taskDashboard?.operations, latestOperation]);
  const latestEvent = taskDashboard?.events?.[0];
  const heartbeatFreshCount = healthAccounts.filter(account => account.heartbeat_fresh).length;
  const activeWorkersCount = Number(dashboard.health?.components?.workers?.active || 0);
  const lastActivityAt = latestOperation?.updated_at || latestEvent?.created_at || dashboard.latestTask?.updated_at;
  const activityFresh = Boolean(lastActivityAt && (Date.now() - new Date(lastActivityAt).getTime()) <= 120000);
  const activeTask = Boolean(taskId && !['completed', 'stopped'].includes(taskStatus));
  const queueActive = Boolean(queueHealth.running) && !queueHealth.error;
  const heartbeatEvidence = healthAccounts.length > 0 && heartbeatFreshCount > 0;
  const liveEvidence = queueActive && activeWorkersCount > 0 && heartbeatEvidence && activityFresh;
  const liveLabel = !queueActive ? 'الخدمة غير متاحة' : activeTask && !liveEvidence ? 'لا يوجد نشاط حالي — جارٍ التحقق' : liveEvidence ? 'الأتمتة تعمل الآن' : 'جاهز للتشغيل';
  const liveTone: LiveMetricTone = !queueActive ? 'rose' : activeTask && !liveEvidence ? 'amber' : liveEvidence ? 'emerald' : 'cyan';
  const terminalCount = Number(taskDashboard?.stats?.success || 0) + Number(taskDashboard?.stats?.failed || 0) + Number(taskDashboard?.stats?.skipped || 0) + Number(taskDashboard?.stats?.review || 0);
  const totalOperations = Number(taskDashboard?.stats?.total || taskDashboard?.task?.total_operations || dashboard.latestTask?.total_operations || 0);
  const processedCount = totalOperations ? terminalCount : 0;
  const liveProgress = totalOperations ? Math.min(100, Math.round((processedCount / totalOperations) * 100)) : taskProgress;
  const liveCurrentAccount = activeOperation?.account_name || activeOperation?.account_phone || 'بانتظار حساب';
  const liveCurrentLink = activeOperation?.url || 'لا يوجد رابط قيد المعالجة';
  const liveLastResult = latestOperation?.status === 'success' ? 'تمت المعالجة بنجاح' : latestOperation?.last_error || (latestEvent?.event_type || 'بانتظار أول عملية');
  const eventLabel = (event: any) => ({ task_created: 'تم إنشاء المهمة', operation_started: 'بدأت عملية جديدة', operation_completed: 'اكتملت العملية', operation_failed: 'فشلت العملية', wait_started: 'بدأ الانتظار المجدول', account_pacing_wait: 'تم تأجيل الانضمام لحماية الفاصل الزمني للحساب', paused_at_stage: 'تم إيقاف المهمة مؤقتًا', stopped_at_stage: 'تم إيقاف العملية', task_completed: 'اكتملت المهمة' } as Record<string, string>)[event?.event_type] || event?.event_type || 'تحديث من العامل';

  function toggleSet(setter: Dispatch<SetStateAction<Set<string>>>, id: string) { setter(previous => { const next = new Set(previous); next.has(id) ? next.delete(id) : next.add(id); return next; }); }
  async function selectAllLinks() {
    if (selectionLoading) return;
    if (allLinksSelected || (selectedLinkIds.size > 0 && selectedLinkIds.size === Number(dashboard.pagination?.total || 0))) {
      setSelectedLinkIds(new Set());
      setAllLinksSelected(false);
      return;
    }
    setSelectionLoading(true);
    try {
      const params = new URLSearchParams({ search, status: statusFilter, source: sourceFilter, accountIds: filterAccountIds.join(','), showCompleted: String(showCompleted) });
      const now = new Date();
      const from = datePreset === 'today' ? new Date(now.getFullYear(), now.getMonth(), now.getDate()) : datePreset === 'yesterday' ? new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1) : datePreset === '7d' ? new Date(Date.now() - 7 * 86400000) : datePreset === '30d' ? new Date(Date.now() - 30 * 86400000) : customFrom ? new Date(`${customFrom}T00:00:00`) : null;
      const to = datePreset === 'yesterday' ? new Date(now.getFullYear(), now.getMonth(), now.getDate()) : customTo ? new Date(`${customTo}T23:59:59`) : null;
      if (from) params.set('dateFrom', from.toISOString());
      if (to) params.set('dateTo', to.toISOString());
      const response = await authFetch(`${API}/whatsapp/join-automation/links/selection?${params.toString()}`);
      const data = await readApiJson(response);
      if (!response.ok || !data.success) throw new Error(data.error || 'تعذر تحديد جميع الروابط');
      setSelectedLinkIds(new Set((data.ids || []).map(String)));
      setAllLinksSelected(true);
      notify(`تم تحديد ${Number(data.total || 0)} رابط مطابق للفلاتر`, 'success');
    } catch (error: any) { notify(error.message || 'تعذر تحديد جميع الروابط', 'error'); }
    finally { setSelectionLoading(false); }
  }
  function selectAllSources() { setSelectedSourceIds(current => current.size === dashboard.sources.length ? new Set() : new Set(dashboard.sources.map(source => source.id))); }
  function selectAllJoinAccounts() { const eligible = dashboard.joinAccounts.filter(isEligibleJoinAccount).map(account => account.id); setSelectedJoinAccountIds(current => current.size === eligible.length ? new Set() : new Set(eligible)); }

  async function startSearch() {
    if (!selectedSourceIds.size) return notify('حدد مصدرًا واحدًا على الأقل لبدء البحث', 'warning');
    setSearching(true);
    try {
      const requestId = searchRequestIdRef.current || globalThis.crypto?.randomUUID?.() || `wa-search-${Date.now()}-${Math.random()}`;
      searchRequestIdRef.current = requestId;
      const response = await authFetch(`${API}/whatsapp/join-automation/search/start`, { method: 'POST', headers: { 'Idempotency-Key': requestId }, body: JSON.stringify({ accountIds: [...selectedSourceIds] }) });
      const data = await readApiJson(response);
      if (!response.ok || !data.success) throw new Error(data.error || 'فشل وضع البحث في الطابور');
      setSearchJobId(String(data.discoveryJobId));
      setSearchJobStatus(String(data.status || 'queued'));
      searchRequestIdRef.current = null;
      notify(`تم تشغيل Job البحث الحقيقي ووضعه في الطابور (${data.jobId})`, 'info');
      fetchDashboard();
    } catch (error: any) { notify(error.message || 'فشل بدء البحث', 'error'); }
    finally { setSearching(false); }
  }

  async function stopSearch() {
      try { await authFetch(`${API}/whatsapp/join-automation/search/stop`, { method: 'POST', body: JSON.stringify({ accountIds: [...selectedSourceIds] }) }); notify('تم إيقاف البحث للحسابات المحددة', 'info'); fetchDashboard(); }
    catch (error: any) { notify(error.message || 'فشل إيقاف البحث', 'error'); }
  }

  function requestAutomation() {
    if (!selectedJoinAccountIds.size) return notify('حدد حساب واتساب واحدًا على الأقل', 'warning');
    if (!selectedLinkIds.size) return notify('حدد رابطًا واحدًا على الأقل', 'warning');
    if (!validSelectedLinksCount) return notify('لا توجد روابط صالحة ضمن التحديد الحالي', 'warning');
    if (minDelay > maxDelay) return notify('الحد الأدنى يجب ألا يتجاوز الحد الأقصى', 'warning');
    const dailyLimit = Number(settings.daily_operation_limit);
    if (!Number.isInteger(dailyLimit) || dailyLimit < 1 || dailyLimit > 5000) return notify('حدد الحد اليومي لكل حساب بين 1 و5000 عملية ثم احفظ الإعدادات', 'warning');
    setReviewOpen(true);
  }

  async function confirmAutomation() {
    setBusy(true);
    try {
      const taskSettings = { minDelaySeconds: toSeconds(minDelay, delayUnit), maxDelaySeconds: toSeconds(maxDelay, delayUnit), cycleLimit: settings.cycle_limit || 30, cycleDurationMinutes: settings.cycle_duration_minutes || 60, autoResume: settings.auto_resume !== false, maxRetries: settings.retry_count, retryBackoffSeconds: settings.retry_backoff_seconds, queuePriority: settings.queue_priority, dailyOperationLimit: Number(settings.daily_operation_limit || 10), daily_operation_limit: Number(settings.daily_operation_limit || 10), dailyLimitProtectionEnabled: settings.daily_limit_protection_enabled, daily_limit_protection_enabled: settings.daily_limit_protection_enabled, applyAllLinksToAllAccounts: applyAll, discoveredLinkIds: [...selectedLinkIds] };
      const requestId = taskRequestIdRef.current || globalThis.crypto?.randomUUID?.() || `wa-task-${Date.now()}-${Math.random()}`;
      taskRequestIdRef.current = requestId;
      const response = await authFetch(`${API}/whatsapp/link-import/tasks`, { method: 'POST', headers: { 'Idempotency-Key': requestId }, body: JSON.stringify({ accountIds: [...selectedJoinAccountIds], linkIds: [], settings: taskSettings }) });
      const data = await readApiJson(response);
      if (!response.ok || !data.success) throw new Error(data.error || 'فشل إنشاء مهمة الأتمتة');
      setTaskId(data.task?.id || null); taskRequestIdRef.current = null; setReviewOpen(false); notify(data.idempotent ? 'الطلب مكرر؛ تمت إعادة نفس المهمة بأمان' : `تمت إضافة ${data.totalOperations || 0} عملية إلى Queue`, data.idempotent ? 'info' : 'success'); fetchDashboard(); fetchTask();
    } catch (error: any) { notify(error.message || 'فشل بدء الأتمتة', 'error'); }
    finally { setBusy(false); }
  }

  async function emergencyStop() {
    if (!window.confirm('سيتم إيقاف أتمتة الانضمام بالكامل وإلغاء الأعمال المستقبلية مع الاحتفاظ بالسجل. هل تريد المتابعة؟')) return;
    try {
      const response = await authFetch(`${API}/whatsapp/join-automation/emergency-stop`, { method: 'POST' });
      const data = await readApiJson(response);
      if (!response.ok || !data.success) throw new Error(data.error || 'تعذر تنفيذ الإيقاف الطارئ');
      notify(`تم الإيقاف الطارئ: أُلغي ${data.cancelledJobs || 0} Job وأُوقفت ${data.pausedOperations || 0} عملية`, 'warning');
      await fetchDashboard();
      await fetchTask();
      await fetchSettings();
    } catch (error: any) { notify(error.message || 'تعذر تنفيذ الإيقاف الطارئ', 'error'); }
  }
  async function stopAccountAutomation(account: JoinAccount) {
    if (!window.confirm(`سيتم إيقاف أتمتة الحساب ${account.name} وإلغاء أعماله المستقبلية. هل تريد المتابعة؟`)) return;
    try {
      const response = await authFetch(`${API}/whatsapp/join-automation/accounts/${account.id}/stop`, { method: 'POST' });
      const data = await readApiJson(response);
      if (!response.ok || !data.success) throw new Error(data.error || 'تعذر إيقاف الحساب');
      notify(`تم إيقاف ${account.name} وإيقاف ${data.stoppedOperations || 0} عملية`, 'warning');
      await fetchDashboard();
      await fetchTask();
    } catch (error: any) { notify(error.message || 'تعذر إيقاف الحساب', 'error'); }
  }

  async function saveSettings() {
    setSavingSettings(true);
    try {
      const response = await authFetch(`${API}/whatsapp/join-automation/settings`, { method: 'PUT', body: JSON.stringify({ ...settings, minDelaySeconds: toSeconds(minDelay, delayUnit), maxDelaySeconds: toSeconds(maxDelay, delayUnit), dailyOperationLimit: settings.daily_operation_limit, dailyLimitProtectionEnabled: settings.daily_limit_protection_enabled, daily_limit_protection_enabled: settings.daily_limit_protection_enabled, accountSettings: settings.account_settings }) });
      const data = await readApiJson(response);
      if (!response.ok || !data.success) throw new Error(data.error || 'تعذر حفظ الإعدادات');
      setSettings(data.settings); notify('تم حفظ إعدادات أتمتة الانضمام', 'success');
    } catch (error: any) { notify(error.message || 'فشل حفظ الإعدادات', 'error'); }
    finally { setSavingSettings(false); }
  }
  function updateAccountSetting(accountId: string, patch: Record<string, unknown>) { setSettings(current => ({ ...current, account_settings: { ...current.account_settings, [accountId]: { ...current.account_settings[accountId], ...patch } } })); }

  async function revalidateJoinAccount(account: JoinAccount) {
    setRevalidatingAccountId(account.id);
    try {
      const response = await authFetch(`${API}/whatsapp/join-automation/accounts/${account.id}/revalidate`, { method: 'POST' });
      const data = await readApiJson(response);
      if (!response.ok || !data.success) throw new Error(data.error || 'تعذر إعادة فحص الحساب');
      notify(`تمت إعادة فحص الحساب ${account.name}. يمكنك اختياره الآن إذا بقي متصلًا.`, 'success');
      await fetchDashboard();
    } catch (error: any) { notify(error.message || 'تعذر إعادة فحص الحساب', 'error'); }
    finally { setRevalidatingAccountId(null); }
  }

  async function revalidateConnectedJoinAccounts() {
    const candidates = dashboard.joinAccounts.filter(account => account.status === 'connected' && !isEligibleJoinAccount(account));
    if (!candidates.length) return notify('لا توجد حسابات متصلة تحتاج إعادة فحص', 'info');
    setRevalidatingAccountId('all');
    try {
      const results = await Promise.all(candidates.map(async account => {
        const response = await authFetch(`${API}/whatsapp/join-automation/accounts/${account.id}/revalidate`, { method: 'POST' });
        const data = await readApiJson(response);
        return { account, ok: response.ok && data.success, error: data.error };
      }));
      const successful = results.filter(result => result.ok).length;
      const rejected = results.filter(result => !result.ok);
      notify(`تمت إعادة فحص ${successful} حسابًا متصلًا${rejected.length ? `، وتعذر فحص ${rejected.length} بسبب عدم الجاهزية` : ''}.`, rejected.length ? 'warning' : 'success');
      await fetchDashboard();
    } catch (error: any) { notify(error.message || 'تعذر إعادة فحص الحسابات', 'error'); }
    finally { setRevalidatingAccountId(null); }
  }

  async function controlTask(status: 'paused' | 'pending' | 'stopped') {
    if (!taskId) return notify('لا توجد مهمة نشطة', 'warning');
    try {
      const response = await authFetch(`${API}/whatsapp/link-import/tasks/${taskId}`, { method: 'PATCH', body: JSON.stringify({ status }) });
      const data = await readApiJson(response);
      if (!response.ok || !data.success) throw new Error(data.error || 'تعذر تحديث المهمة');
      notify(status === 'paused' ? 'تم إيقاف المهمة مؤقتًا' : status === 'pending' ? 'تم استئناف المهمة' : 'تم إيقاف المهمة بالكامل', status === 'stopped' ? 'warning' : 'info');
      fetchDashboard(); fetchTask();
    } catch (error: any) { notify(error.message || 'فشل تحديث المهمة', 'error'); }
  }

  async function openLinkDetails(link: LinkRow) {
    setDetailsLink(link); setDetailsData(null);
    try { const response = await authFetch(`${API}/whatsapp/join-automation/links/${link.id}/details`); const data = await readApiJson(response); if (!response.ok || !data.success) throw new Error(data.error || 'تعذر تحميل تفاصيل الرابط'); setDetailsData(data); }
    catch (error: any) { notify(error.message || 'تعذر تحميل تفاصيل الرابط', 'error'); }
  }
  async function archiveLink(id: string) {
    if (!window.confirm('سيتم إخفاء الرابط من التشغيل مع الاحتفاظ بسجله. هل تريد المتابعة؟')) return;
    try { const response = await authFetch(`${API}/whatsapp/join-automation/links/${id}/archive`, { method: 'PATCH', body: JSON.stringify({}) }); const data = await readApiJson(response); if (!response.ok || !data.success) throw new Error(data.error || 'فشل الأرشفة'); notify('تمت أرشفة الرابط دون حذف سجله', 'success'); setDetailsLink(null); setDetailsData(null); fetchDashboard(); }
    catch (error: any) { notify(error.message || 'فشل أرشفة الرابط', 'error'); }
  }

  async function revalidateLink(id: string) {
    try { const response = await authFetch(`${API}/whatsapp/join-automation/links/${id}/revalidate`, { method: 'POST', body: JSON.stringify({}) }); const data = await readApiJson(response); if (!response.ok || !data.success) throw new Error(data.error || 'فشل إعادة التحقق'); notify(data.valid ? 'تم التحقق من صيغة الرابط' : 'الرابط غير صالح', data.valid ? 'success' : 'warning'); fetchDashboard(); }
    catch (error: any) { notify(error.message || 'فشل إعادة التحقق', 'error'); }
  }

  async function deduplicate() {
    try { const response = await authFetch(`${API}/whatsapp/join-automation/links/deduplicate`, { method: 'POST', body: JSON.stringify({}) }); const data = await readApiJson(response); if (!response.ok || !data.success) throw new Error(data.error || 'فشل إزالة المكررات'); notify(`تمت إزالة ${data.removed || 0} سجل مكرر`, 'success'); fetchDashboard(); }
    catch (error: any) { notify(error.message || 'فشل إزالة المكررات', 'error'); }
  }

  async function exportLinks() {
    try { const response = await authFetch(`${API}/whatsapp/links/export`); if (!response.ok) throw new Error('فشل تصدير الروابط'); const blob = await response.blob(); const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'join-automation-links.csv'; anchor.click(); URL.revokeObjectURL(url); notify('تم تصدير قائمة الروابط', 'success'); }
    catch (error: any) { notify(error.message || 'فشل التصدير', 'error'); }
  }
  async function exportOperationLog() {
    try { const suffix = taskId ? `?taskId=${encodeURIComponent(taskId)}` : ''; const response = await authFetch(`${API}/whatsapp/join-automation/logs/export${suffix}`); if (!response.ok) throw new Error('لا يوجد سجل عمليات بعد'); const blob = await response.blob(); const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'join-automation-operation-log.csv'; anchor.click(); URL.revokeObjectURL(url); notify('تم تصدير سجل العمليات', 'success'); }
    catch (error: any) { notify(error.message || 'فشل تصدير سجل العمليات', 'error'); }
  }

  function toggleFilterAccount(id: string) { setFilterAccountIds(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id]); }

  return <main className="mx-auto w-full max-w-[1600px] space-y-5 p-4 pb-10 sm:p-6" dir="rtl">
    <header className="rounded-3xl border border-cyan-400/15 bg-gradient-to-br from-cyan-500/10 via-[var(--bg-surface)] to-violet-500/10 p-5 shadow-[var(--shadow-card)] sm:p-7">
      <div className="flex flex-wrap items-start justify-between gap-4"><div className="flex items-start gap-3"><div className="rounded-2xl bg-cyan-400/15 p-3 text-cyan-300"><Bot className="h-7 w-7" /></div><div><p className="text-xs font-bold text-cyan-300">الروابط / التشغيل الآمن</p><h1 className="mt-1 text-2xl font-black sm:text-3xl">أتمتة الانضمام</h1><p className="mt-2 max-w-3xl text-sm leading-6 text-[var(--text-muted)]">إدارة روابط الدعوات المكتشفة من المصادر المصرح بها، والتحقق منها وتشغيل الانضمام عبر Queue مستقرة دون الاعتماد على بقاء الصفحة مفتوحة.</p></div></div><div className="flex flex-wrap items-center gap-2"><a href="/whatsapp-join-automation/audit" className="inline-flex items-center gap-2 rounded-full border border-cyan-400/25 bg-cyan-500/10 px-3 py-2 text-xs font-bold text-cyan-200"><FileSearch className="h-4 w-4" />Audit Logs</a><a href="/join-automation/reports" className="inline-flex items-center gap-2 rounded-full border border-violet-400/25 bg-violet-500/10 px-3 py-2 text-xs font-bold text-violet-200"><BarChart3 className="h-4 w-4" />التقارير</a><div className="flex items-center gap-2 rounded-full border border-[var(--border-default)] bg-[var(--bg-surface)] px-3 py-2 text-xs"><span className={cn('h-2.5 w-2.5 rounded-full', dashboard.systemStatus === 'needs_intervention' ? 'bg-rose-400' : dashboard.systemStatus === 'running' ? 'bg-emerald-400' : 'bg-slate-400')} />{dashboard.systemStatus === 'needs_intervention' ? 'يحتاج تدخل' : dashboard.systemStatus === 'running' ? 'يعمل' : 'متوقف'}</div><div title={dashboard.health?.checkedAt ? `آخر فحص: ${formatDate(dashboard.health.checkedAt)}` : undefined} className={cn('flex items-center gap-2 rounded-full border px-3 py-2 text-xs', dashboard.health?.status === 'critical' ? 'border-rose-400/25 bg-rose-500/10 text-rose-200' : dashboard.health?.status === 'degraded' ? 'border-amber-400/25 bg-amber-500/10 text-amber-200' : 'border-emerald-400/25 bg-emerald-500/10 text-emerald-200')}><span className="h-2.5 w-2.5 rounded-full bg-current" />الصحة: {dashboard.health?.status === 'critical' ? 'حرجة' : dashboard.health?.status === 'degraded' ? 'متدهورة' : 'سليمة'}</div></div></div>
    </header>

    <section className="grid gap-4 xl:grid-cols-[1.35fr_.65fr]">
      <div className={cn('relative overflow-hidden rounded-3xl border p-5 shadow-[var(--shadow-card)] sm:p-6', toneClasses(liveTone))}>
        <div className="pointer-events-none absolute -left-16 -top-16 h-44 w-44 rounded-full bg-current opacity-[0.07] blur-3xl" />
        <div className="relative flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.16em] opacity-80"><Radio className="h-4 w-4" />مراقبة التشغيل المباشر</div>
            <h2 className="mt-2 flex items-center gap-2 text-2xl font-black sm:text-3xl"><span className={cn('h-3 w-3 rounded-full', liveTone === 'emerald' ? 'animate-pulse bg-emerald-300' : liveTone === 'amber' ? 'bg-amber-300' : liveTone === 'rose' ? 'bg-rose-300' : 'bg-cyan-300')} />{liveLabel}</h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 opacity-80">الحالة المعروضة مبنية على نبضات الخادم، اتصال الـ Queue، وآخر نشاط مسجل للمهمة؛ لا تعتمد على مؤقت داخل المتصفح.</p>
          </div>
          <button type="button" onClick={() => { fetchDashboard(); fetchTask(); }} className="inline-flex items-center gap-2 rounded-xl border border-current/20 bg-black/10 px-3 py-2 text-xs font-bold transition hover:bg-black/20 active:scale-95"><RefreshCw className="h-4 w-4" />فحص الآن</button>
        </div>
        <div className="relative mt-6 grid gap-3 sm:grid-cols-3">
          {[
            { label: 'Worker', value: activeWorkersCount > 0 && heartbeatEvidence ? 'يعمل فعليًا' : 'لا توجد إشارة', sub: `${activeWorkersCount} حساب نشط · ${heartbeatFreshCount} نبضة حديثة`, icon: ServerCog },
            { label: 'Queue', value: queueActive ? 'متصلة وتستقبل' : 'غير متاحة', sub: `${Number(joinQueueStats.active || 0)} قيد التنفيذ · ${Number(joinQueueStats.waiting || 0)} انتظار`, icon: Workflow },
            { label: 'الخادم', value: dashboard.health?.components?.database?.status === 'healthy' ? 'متصل' : 'يحتاج تحقق', sub: `آخر فحص ${timeAgo(dashboard.health?.checkedAt)}`, icon: CloudCog },
          ].map(item => <div key={item.label} className="rounded-2xl border border-current/15 bg-black/10 p-3 backdrop-blur-sm"><div className="flex items-center justify-between gap-2"><span className="text-xs opacity-75">{item.label}</span><item.icon className="h-4 w-4 opacity-80" /></div><p className="mt-2 text-sm font-black">{item.value}</p><p className="mt-1 text-[11px] opacity-70">{item.sub}</p></div>)}
        </div>
        <div className="relative mt-3 grid gap-3 rounded-2xl border border-current/15 bg-black/10 p-4 sm:grid-cols-[1fr_auto] sm:items-center">
          <div className="min-w-0"><div className="flex items-center gap-2 text-xs font-bold"><CircleDot className="h-4 w-4" />العملية الحالية</div><p className="mt-2 truncate text-sm font-black">{liveCurrentAccount}</p><p className="mt-1 truncate font-mono text-xs opacity-75" dir="ltr">{liveCurrentLink}</p><p className="mt-2 text-xs opacity-80">{activeOperation?.current_stage || 'بانتظار العملية التالية'} · {liveLastResult}</p></div><div className="min-w-[150px] sm:text-left"><div className="flex items-center justify-between text-[11px] opacity-75"><span>التقدم</span><strong>{liveProgress}%</strong></div><div className="mt-2 h-2 overflow-hidden rounded-full bg-black/20"><div className="h-full rounded-full bg-current transition-all duration-300" style={{ width: `${liveProgress}%` }} /></div><p className="mt-2 text-[11px] opacity-75">{processedCount} من {totalOperations || '—'} عملية</p></div>
        </div>
      </div>
      <div className="rounded-3xl border border-[var(--border-default)] bg-[var(--bg-surface)] p-5 shadow-[var(--shadow-card)] sm:p-6">
        <div className="flex items-start justify-between gap-3"><div><p className="text-xs font-bold uppercase tracking-[0.16em] text-[var(--text-muted)]">دليل النشاط الحقيقي</p><h2 className="mt-2 text-lg font-black">بيانات لحظية من الخادم</h2></div><div className="rounded-2xl bg-cyan-500/10 p-3 text-cyan-300"><Gauge className="h-5 w-5" /></div></div>
        <div className="mt-5 space-y-3">
          {[
            { label: 'آخر Heartbeat', value: timeAgo(healthAccounts.find(account => account.heartbeat_fresh)?.last_heartbeat || healthAccounts[0]?.last_heartbeat), icon: Signal, tone: healthAccounts.length && heartbeatFreshCount === 0 ? 'rose' as LiveMetricTone : 'emerald' as LiveMetricTone },
            { label: 'آخر عملية حقيقية', value: timeAgo(lastActivityAt), icon: Activity, tone: !activityFresh ? 'amber' as LiveMetricTone : activeOperation?.status === 'failed' ? 'rose' as LiveMetricTone : 'cyan' as LiveMetricTone },
            { label: 'مدة المهمة', value: formatDuration(taskDashboard?.task?.created_at || dashboard.latestTask?.created_at, taskDashboard?.task?.completed_at || dashboard.latestTask?.completed_at), icon: TimerReset, tone: 'violet' as LiveMetricTone },
            { label: 'Job ID', value: taskId ? taskId.slice(0, 18) + '…' : 'لا توجد مهمة', icon: ListChecks, tone: 'amber' as LiveMetricTone },
          ].map(item => <div key={item.label} className="flex items-center gap-3 rounded-2xl border border-[var(--border-default)] bg-[var(--bg-elevated)] p-3"><div className={cn('rounded-xl border p-2', toneClasses(item.tone))}><item.icon className="h-4 w-4" /></div><div className="min-w-0 flex-1"><p className="text-[11px] text-[var(--text-muted)]">{item.label}</p><p className="mt-1 truncate text-sm font-bold" dir={item.label === 'Job ID' ? 'ltr' : undefined}>{item.value}</p></div></div>)}
        </div>
      </div>
    </section>

    <section className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
      <StatCard label="إجمالي الروابط" value={dashboard.stats.total} icon={Link2} tone="bg-cyan-500/10 text-cyan-300" />
      <StatCard label="روابط صالحة" value={dashboard.stats.valid} icon={CheckCircle2} tone="bg-emerald-500/10 text-emerald-300" />
      <StatCard label="قيد المعالجة" value={dashboard.stats.processing} icon={Activity} tone="bg-sky-500/10 text-sky-300" />
      <StatCard label="مكتملة" value={dashboard.stats.completed} icon={Check} tone="bg-violet-500/10 text-violet-300" />
      <StatCard label="فاشلة" value={dashboard.stats.failed} icon={AlertTriangle} tone="bg-rose-500/10 text-rose-300" />
      <StatCard label="مؤجلة" value={dashboard.stats.deferred} icon={Clock3} tone="bg-amber-500/10 text-amber-300" />
      <StatCard label="الحسابات النشطة" value={dashboard.stats.activeWorkers} icon={Users} tone="bg-indigo-500/10 text-indigo-300" />
      <StatCard label="العملية التالية" value={formatCountdown(dashboard.nextOperationAt)} icon={Zap} tone="bg-orange-500/10 text-orange-300" />
    </section>

    <section className="grid gap-4 xl:grid-cols-[1.15fr_.85fr]">
      <div className="rounded-3xl border border-[var(--border-default)] bg-[var(--bg-elevated)] p-5 shadow-[var(--shadow-card)]">
        <SectionTitle icon={Users} title="الحسابات المراقبة لحظيًا" description="حالة الاتصال والنبضات والعمليات مبنية على آخر بيانات وصلت من الخادم." action={<span className="inline-flex items-center gap-2 rounded-full border border-emerald-400/20 bg-emerald-400/10 px-3 py-1.5 text-[11px] font-bold text-emerald-200"><span className="h-2 w-2 animate-pulse rounded-full bg-emerald-300" />تحديث تلقائي</span>} />
        <div className="grid gap-3 md:grid-cols-2">
          {dashboard.joinAccounts.length ? dashboard.joinAccounts.map(account => {
            const health = healthAccounts.find(item => String(item.account_id) === String(account.id));
    const accountStats = accountOperationStats[account.id] || { operations: 0, errors: 0, links: 0 };
            const cycle = cycleByAccount.get(String(account.id));
            const breakerOpen = account.circuit_breaker_state === 'OPEN' || account.status === 'banned';
            const accountLive = !breakerOpen && health?.heartbeat_fresh && ['connected', 'ready'].includes(String(health.worker_status || account.status));
            return <div key={account.id} className="rounded-2xl border border-[var(--border-default)] bg-[var(--bg-surface)] p-4 transition hover:-translate-y-0.5 hover:border-cyan-400/25">
              <div className="flex items-start justify-between gap-3"><div className="flex min-w-0 items-center gap-3"><div className={cn('rounded-xl p-2.5', accountLive ? 'bg-emerald-400/10 text-emerald-300' : 'bg-amber-400/10 text-amber-300')}>{accountLive ? <Wifi className="h-5 w-5" /> : <WifiOff className="h-5 w-5" />}</div><div className="min-w-0"><p className="truncate text-sm font-black">{account.name}</p><p className="mt-1 truncate font-mono text-[11px] text-[var(--text-muted)]" dir="ltr">{account.phone_number || 'بدون رقم ظاهر'}</p></div></div><span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[10px] font-bold', accountLive ? 'border-emerald-400/25 bg-emerald-400/10 text-emerald-200' : 'border-amber-400/25 bg-amber-400/10 text-amber-200')}><span className="h-1.5 w-1.5 rounded-full bg-current" />{accountLive ? 'متصل ويعمل' : 'بانتظار الإشارة'}</span></div>
              <div className="mt-4 grid grid-cols-2 gap-2 text-[11px]"><div className="rounded-xl bg-[var(--bg-elevated)] p-2.5"><span className="text-[var(--text-muted)]">العمليات</span><strong className="mt-1 block text-sm">{accountStats.operations}</strong></div><div className="rounded-xl bg-[var(--bg-elevated)] p-2.5"><span className="text-[var(--text-muted)]">الأخطاء</span><strong className={cn('mt-1 block text-sm', accountStats.errors ? 'text-rose-300' : 'text-emerald-300')}>{accountStats.errors}</strong></div></div>
              {breakerOpen && <div className="mt-3 rounded-xl border border-rose-400/25 bg-rose-500/5 p-3 text-[10px] leading-5 text-rose-200"><strong className="block">Hard Stop / Circuit Breaker</strong><span>{protectionLabel(account) || 'تم إيقاف الحساب للحماية'}</span>{account.protection_reason && <span className="mt-1 block opacity-80">{account.protection_reason}</span>}<span className="mt-1 block opacity-80">503: {account.consecutive_503 || 0} · تأجيل: {account.deferred_count || 0} · تعارض قفل: {account.lock_collision_count || 0}</span></div>}
              {cycle && <div className="mt-3 rounded-xl border border-cyan-400/15 bg-cyan-500/5 p-3"><div className="flex items-center justify-between gap-2 text-[11px]"><span className="font-bold text-cyan-200">الدورة {cycle.cycle_number}</span><span className={cn('rounded-full px-2 py-1 font-bold', cycle.status === 'RESTING' ? 'bg-amber-400/10 text-amber-200' : 'bg-emerald-400/10 text-emerald-200')}>{cycle.status === 'RESTING' ? 'RESTING · استراحة' : 'RUNNING · تعمل'}</span></div><div className="mt-2 flex items-end justify-between"><strong className="text-lg text-[var(--text-primary)]">{cycle.processed_count} / {cycle.cycle_limit || 30}</strong><span className="text-[10px] text-[var(--text-muted)]">تمت المعالجة</span></div><div className="mt-2 grid grid-cols-3 gap-1 text-[10px]"><span className="rounded-lg bg-emerald-400/10 px-2 py-1 text-emerald-200">JOINED {cycle.success_count}</span><span className="rounded-lg bg-amber-400/10 px-2 py-1 text-amber-200">REQUEST {cycle.request_count}</span><span className="rounded-lg bg-rose-400/10 px-2 py-1 text-rose-200">FAILED {cycle.failed_count}</span></div><p className="mt-2 text-[10px] text-[var(--text-muted)]">{cycle.status === 'RESTING' ? `الدورة التالية: ${formatDate(cycle.next_cycle_at)}` : `العملية القادمة: ${cycle.next_run_at ? formatDate(cycle.next_run_at) : 'قيد الجدولة'}`}</p></div>}
              <div className="mt-3 flex items-center justify-between border-t border-[var(--border-default)] pt-3 text-[11px] text-[var(--text-muted)]"><span className="inline-flex items-center gap-1"><Signal className="h-3.5 w-3.5" />Heartbeat {timeAgo(health?.last_heartbeat)}</span><span>{health?.last_error ? 'يحتاج مراجعة' : 'سليم'}</span></div>
            </div>;
          }) : <div className="rounded-2xl border border-dashed border-[var(--border-default)] p-8 text-center text-sm text-[var(--text-muted)] md:col-span-2">لا توجد حسابات مرتبطة بعد.</div>}
        </div>
      </div>
      <div className="rounded-3xl border border-[var(--border-default)] bg-[var(--bg-elevated)] p-5 shadow-[var(--shadow-card)]">
        <SectionTitle icon={Activity} title="النشاط المباشر" description="آخر الأحداث المسجلة من العامل والـQueue." action={<span className="text-[11px] text-[var(--text-muted)]">{latestEvent ? timeAgo(latestEvent.created_at) : 'بانتظار الأحداث'}</span>} />
        <div className="max-h-[248px] space-y-2 overflow-auto pr-1">
          {taskDashboard?.events?.length ? taskDashboard.events.slice(0, 8).map((event: any, index: number) => <div key={event.id || `${event.created_at}-${index}`} className="flex items-start gap-3 rounded-2xl border border-[var(--border-default)] bg-[var(--bg-surface)] p-3"><span className={cn('mt-0.5 rounded-lg p-1.5', event.event_type?.includes('failed') ? 'bg-rose-400/10 text-rose-300' : event.event_type?.includes('completed') ? 'bg-emerald-400/10 text-emerald-300' : 'bg-cyan-400/10 text-cyan-300')}><CircleDot className="h-3.5 w-3.5" /></span><div className="min-w-0 flex-1"><p className="truncate text-xs font-bold">{eventLabel(event)}</p><p className="mt-1 text-[10px] text-[var(--text-muted)]">{formatDate(event.created_at || event.at)} · {event.payload?.stage || 'Queue'}</p></div></div>) : <div className="flex h-48 flex-col items-center justify-center rounded-2xl border border-dashed border-[var(--border-default)] text-center"><Radio className="h-7 w-7 text-[var(--text-muted)]" /><p className="mt-3 text-sm font-bold">لا توجد أحداث حديثة</p><p className="mt-1 text-xs text-[var(--text-muted)]">ستظهر هنا فور بدء مهمة حقيقية.</p></div>}
        </div>
      </div>
    </section>

    <section className="rounded-2xl border border-[var(--border-default)] bg-[var(--bg-elevated)] p-4 sm:p-5">
      <SectionTitle icon={Search} title="البحث الحقيقي عن روابط واتساب" description="اختر حسابات واتساب المتصلة أو التي لديها سجل محفوظ؛ يبحث النظام داخل المحادثات الخاصة والمجموعات التي استقبلتها الحسابات ويحفظ مصدر الرابط ووقت اكتشافه دون تكرار." action={<div className="flex flex-wrap gap-2"><button type="button" onClick={startSearch} disabled={searching || !selectedSourceIds.size} className="inline-flex items-center gap-2 rounded-xl bg-cyan-500 px-4 py-2.5 text-sm font-black text-slate-950 transition active:scale-95 disabled:opacity-50">{searching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}بدء البحث</button><button type="button" onClick={stopSearch} className="inline-flex items-center gap-2 rounded-xl border border-rose-400/25 px-4 py-2.5 text-sm font-bold text-rose-300 transition active:scale-95"><Square className="h-4 w-4" />إيقاف البحث</button></div>} />
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{dashboard.sources.map(source => <label key={source.id} className={cn('flex cursor-pointer items-center gap-3 rounded-2xl border p-3 transition', selectedSourceIds.has(source.id) ? 'border-cyan-400/35 bg-cyan-400/5' : 'border-[var(--border-default)] bg-[var(--bg-surface)]')}><input type="checkbox" checked={selectedSourceIds.has(source.id)} onChange={() => toggleSet(setSelectedSourceIds, source.id)} className="h-4 w-4 accent-cyan-500" /><span className="rounded-xl bg-[var(--bg-elevated)] p-2 text-cyan-300">{source.worker?.status === 'connected' || source.status === 'connected' ? <Wifi className="h-4 w-4" /> : <WifiOff className="h-4 w-4" />}</span><span className="min-w-0 flex-1"><span className="block truncate text-sm font-bold">{source.name}</span><span className="mt-1 block truncate text-[11px] text-[var(--text-muted)]">{source.links_collected || 0} رابط · {source.channels_monitored || 0} مصدر · آخر نشاط {formatDate(source.last_activity_at)}</span></span><StatusBadge value={source.worker?.status === 'error' || source.status === 'error' ? 'failed' : source.worker?.status === 'connected' || source.status === 'connected' ? 'valid' : 'unavailable'} /></label>)}</div>
      <div className="mt-3 flex flex-wrap items-center gap-3 text-xs"><button type="button" onClick={selectAllSources} className="text-cyan-300">{selectedSourceIds.size === dashboard.sources.length ? 'مسح الحسابات' : 'تحديد جميع الحسابات'}</button><span className="text-[var(--text-muted)]">{selectedSources.length} حساب محدد</span><span className="text-[var(--text-muted)]">يمكنك إلغاء تحديد أي حساب؛ سيبقى اختيارك ثابتًا أثناء التحديثات.</span></div>
      {searchJobId && <div className="mt-3 flex flex-wrap items-center gap-3 rounded-xl border border-cyan-400/20 bg-cyan-500/5 px-3 py-2 text-xs"><span className="font-bold text-cyan-200">Job البحث: <span className="font-mono">{searchJobId}</span></span><span className="text-cyan-100">الحالة: {discoveryStatusLabel(searchJobStatus || dashboard.latestDiscoveryJob?.status)}</span>{dashboard.latestDiscoveryJob?.messages_scanned !== undefined && <span className="text-[var(--text-muted)]">الرسائل المفحوصة: {dashboard.latestDiscoveryJob.messages_scanned}</span>}{dashboard.latestDiscoveryJob?.found_count !== undefined && <span className="text-[var(--text-muted)]">الروابط المكتشفة: {dashboard.latestDiscoveryJob.found_count}</span>}{dashboard.latestDiscoveryJob?.error && <span className="text-rose-300">{dashboard.latestDiscoveryJob.error}</span>}</div>}
    </section>

    <JoinAutomationImportPanel onSaved={fetchDashboard} />

    <section className="rounded-2xl border border-[var(--border-default)] bg-[var(--bg-elevated)] p-4 sm:p-5">
      <SectionTitle icon={Filter} title="فلترة الروابط المكتشفة" description="ابحث عن رابط محدد أو صفِّ النتائج بالحساب والمصدر والتاريخ والحالة." action={<div className="flex flex-wrap gap-2"><button type="button" onClick={deduplicate} className="inline-flex items-center gap-2 rounded-xl border border-amber-400/25 px-3 py-2 text-xs font-bold text-amber-300"><Trash2 className="h-4 w-4" />إزالة المكررات</button><button type="button" onClick={exportLinks} className="inline-flex items-center gap-2 rounded-xl border border-cyan-400/25 px-3 py-2 text-xs font-bold text-cyan-300"><Download className="h-4 w-4" />تصدير الروابط</button></div>} />
      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6"><label className="relative xl:col-span-2"><Search className="absolute right-3 top-2.5 h-4 w-4 text-[var(--text-muted)]" /><input value={search} onChange={event => setSearch(event.target.value)} placeholder="البحث عن رابط أو مصدر..." className="w-full rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] py-2.5 pr-9 pl-3 text-sm" dir="ltr" /></label><select multiple value={filterAccountIds} onChange={event => setFilterAccountIds([...event.target.selectedOptions].map(option => option.value))} className="min-h-11 rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] px-3 py-2 text-xs"><option value="" disabled>الحساب (يمكن اختيار عدة)</option>{dashboard.sources.map(source => <option key={source.id} value={source.id}>{source.name}</option>)}</select><select value={datePreset} onChange={event => setDatePreset(event.target.value as DatePreset)} className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] px-3 py-2 text-sm"><option value="all">كل التواريخ</option><option value="today">اليوم</option><option value="yesterday">أمس</option><option value="7d">آخر 7 أيام</option><option value="30d">آخر 30 يومًا</option><option value="custom">نطاق مخصص</option></select><select value={statusFilter} onChange={event => setStatusFilter(event.target.value)} className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] px-3 py-2 text-sm"><option value="all">كل الحالات</option><option value="new">صالح</option><option value="invalid">غير صالح</option><option value="processing">قيد المعالجة</option><option value="completed">مكتمل</option><option value="deferred">مؤجل</option><option value="failed">فشل</option></select><select value={sourceFilter} onChange={event => setSourceFilter(event.target.value)} className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] px-3 py-2 text-sm"><option value="all">كل المصادر</option>{sourceNames.map(source => <option key={source} value={source}>{source}</option>)}</select></div>
      {datePreset === 'custom' && <div className="mt-3 grid gap-3 sm:grid-cols-2"><input type="date" value={customFrom} onChange={event => setCustomFrom(event.target.value)} className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] px-3 py-2 text-sm" /><input type="date" value={customTo} onChange={event => setCustomTo(event.target.value)} className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] px-3 py-2 text-sm" /></div>}
    </section>

    <section className="rounded-2xl border border-[var(--border-default)] bg-[var(--bg-elevated)] p-4 sm:p-5">
      <SectionTitle icon={Link2} title="الروابط المكتشفة" description="تُحفظ الروابط الحقيقية مع مصدر الاكتشاف والحساب والتاريخ وحالة المعالجة." action={<div className="flex flex-wrap items-center gap-3"><button type="button" onClick={selectAllLinks} disabled={selectionLoading} className="inline-flex items-center gap-2 rounded-xl border border-cyan-400/25 px-3 py-2 text-xs font-bold text-cyan-300 disabled:opacity-60">{selectionLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckSquare className="h-4 w-4" />}{allLinksSelected ? 'مسح التحديد' : `تحديد كل ${Number(dashboard.pagination?.total || filteredLinks.length)}`}</button><label className="flex items-center gap-2 text-xs text-[var(--text-muted)]"><input type="checkbox" checked={showCompleted} onChange={event => setShowCompleted(event.target.checked)} className="h-4 w-4 accent-cyan-500" />إظهار المكتملة</label><span className="text-xs text-[var(--text-muted)]">{selectedLinksCount} محدد / {Number(dashboard.pagination?.total || filteredLinks.length)} رابط مطابق</span><select value={sortBy} onChange={event => setSortBy(event.target.value as typeof sortBy)} className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] px-2 py-2 text-xs"><option value="discovered_at">فرز: الاكتشاف</option><option value="last_verified_at">فرز: آخر تحقق</option><option value="status">فرز: الحالة</option></select><button type="button" onClick={() => setSortDirection(value => value === 'asc' ? 'desc' : 'asc')} className="rounded-xl border border-[var(--border-default)] px-3 py-2 text-xs">{sortDirection === 'asc' ? 'تصاعدي' : 'تنازلي'}</button></div>} />
      <div className="overflow-x-auto rounded-2xl border border-[var(--border-default)]"><table className="w-full min-w-[950px] text-right text-xs"><thead className="bg-[var(--bg-surface)] text-[var(--text-muted)]"><tr><th className="p-3"><input type="checkbox" checked={Boolean(allLinksSelected || (paginatedLinks.length && paginatedLinks.every(link => selectedLinkIds.has(link.id))))} onChange={selectAllLinks} disabled={selectionLoading} className="h-4 w-4 accent-cyan-500" /></th><th className="p-3">الحالة</th><th className="p-3">الرابط</th><th className="p-3">المصدر</th><th className="p-3">الحساب</th><th className="p-3">الاكتشاف</th><th className="p-3">آخر تحقق</th><th className="p-3">العملية التالية</th><th className="p-3">إجراءات</th></tr></thead><tbody>{loading ? <tr><td colSpan={9} className="p-10 text-center"><Loader2 className="mx-auto h-6 w-6 animate-spin text-cyan-300" /></td></tr> : filteredLinks.length ? paginatedLinks.map(link => <tr key={link.id} className="border-t border-[var(--border-default)]"><td className="p-3"><input type="checkbox" checked={selectedLinkIds.has(link.id)} onChange={() => { setAllLinksSelected(false); toggleSet(setSelectedLinkIds, link.id); }} className="h-4 w-4 accent-cyan-500" /></td><td className="p-3"><StatusBadge value={link.processing_status || link.status} /></td><td className="max-w-[270px] p-3"><a href={link.whatsapp_link} target="_blank" rel="noreferrer" className="block truncate font-mono text-cyan-300 hover:underline" dir="ltr">{link.whatsapp_link}</a><span className="mt-1 block text-[10px] text-[var(--text-muted)]">{link.duplicate_count || 0} تكرار</span></td><td className="p-3">{link.source_group || 'غير محدد'}</td><td className="p-3">{link.source_account_name || '—'}</td><td className="p-3 whitespace-nowrap">{formatDate(link.discovered_at)}</td><td className="p-3 whitespace-nowrap">{formatDate(link.last_verified_at)}</td><td className="p-3">{formatDate(link.next_operation)}</td><td className="p-3"><div className="flex items-center gap-1"><button type="button" title="التفاصيل" aria-label="التفاصيل" onClick={() => openLinkDetails(link)} className="rounded-lg p-2 text-cyan-300 hover:bg-cyan-500/10"><Eye className="h-4 w-4" /></button><button type="button" title="نسخ الرابط" aria-label="نسخ الرابط" onClick={() => { navigator.clipboard?.writeText(link.whatsapp_link); notify('تم نسخ الرابط', 'success'); }} className="rounded-lg p-2 text-slate-300 hover:bg-slate-500/10"><Copy className="h-4 w-4" /></button><button type="button" title="إعادة التحقق" aria-label="إعادة التحقق" onClick={() => revalidateLink(link.id)} className="rounded-lg p-2 text-amber-300 hover:bg-amber-500/10"><RefreshCw className="h-4 w-4" /></button><button type="button" title="أرشفة الرابط" aria-label="أرشفة الرابط" onClick={() => archiveLink(link.id)} className="rounded-lg p-2 text-rose-300 hover:bg-rose-500/10"><Trash2 className="h-4 w-4" /></button></div></td></tr>) : <tr><td colSpan={9} className="p-12 text-center text-sm text-[var(--text-muted)]">لا توجد روابط مطابقة للفلاتر الحالية.</td></tr>}</tbody></table></div><div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--text-muted)]"><span>صفحة {Math.min(page, pageCount)} من {pageCount} · {Number(dashboard.pagination?.total || sortedLinks.length)} نتيجة</span><div className="flex gap-2"><button type="button" disabled={page <= 1} onClick={() => setPage(current => Math.max(1, current - 1))} className="rounded-lg border border-[var(--border-default)] px-3 py-1.5 disabled:opacity-40">السابق</button><button type="button" disabled={page >= pageCount} onClick={() => setPage(current => Math.min(pageCount, current + 1))} className="rounded-lg border border-[var(--border-default)] px-3 py-1.5 disabled:opacity-40">التالي</button></div></div>
    </section>

    <section className="grid gap-5 xl:grid-cols-[1.15fr_.85fr]">
      <div className="rounded-2xl border border-[var(--border-default)] bg-[var(--bg-elevated)] p-4 sm:p-5"><SectionTitle icon={UserRound} title="حسابات واتساب للتشغيل" description="اختر حسابًا واحدًا أو عدة حسابات متصلة. الحسابات المقيدة أو المتوقفة لا تدخل Queue." action={<div className="flex flex-wrap gap-2"><button type="button" onClick={revalidateConnectedJoinAccounts} disabled={revalidatingAccountId === 'all'} className="inline-flex items-center gap-1 rounded-lg border border-amber-300/25 px-2.5 py-1.5 text-xs font-bold text-amber-200 disabled:opacity-50">{revalidatingAccountId === 'all' ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}إعادة فحص المتصل</button><button type="button" onClick={selectAllJoinAccounts} className="text-xs font-bold text-cyan-300">تحديد المؤهل</button></div>} /><div className="grid gap-3 md:grid-cols-2">{dashboard.joinAccounts.map(account => { const eligible = isEligibleJoinAccount(account);         const bannedAccount = account.status === 'banned';
            const breakerOpen = account.circuit_breaker_state === 'OPEN';
            const protectedAccount = bannedAccount || breakerOpen || ['blocked', 'protected'].includes(account.health_status || '') || account.task_status === 'stopped';
        const notReady = account.status === 'connected' && account.is_ready === false; return <div key={account.id} className="space-y-2"><label className={cn('flex items-center gap-3 rounded-2xl border p-3 transition', eligible ? 'cursor-pointer' : 'cursor-not-allowed opacity-75', selectedJoinAccountIds.has(account.id) ? 'border-emerald-400/35 bg-emerald-500/5' : 'border-[var(--border-default)] bg-[var(--bg-surface)]')}><input type="checkbox" disabled={!eligible} checked={selectedJoinAccountIds.has(account.id)} onChange={() => toggleSet(setSelectedJoinAccountIds, account.id)} aria-label={`اختيار الحساب ${account.name}`} className="h-4 w-4 accent-emerald-500" /><span className="rounded-xl bg-[var(--bg-elevated)] p-2 text-emerald-300"><UserRound className="h-4 w-4" /></span><span className="min-w-0 flex-1"><span className="block truncate text-sm font-bold">{account.name}</span><span className="mt-1 block text-[11px] text-[var(--text-muted)]">{account.phone_number || 'بدون رقم ظاهر'} · آخر نشاط {formatDate(account.last_activity_at)}</span><span className="mt-1 block text-[10px] text-[var(--text-muted)]">روابط: {accountOperationStats[account.id]?.links || 0} · عمليات: {accountOperationStats[account.id]?.operations || 0} · أخطاء: {accountOperationStats[account.id]?.errors || 0}</span></span><StatusBadge value={bannedAccount ? 'banned' : eligible ? 'valid' : protectedAccount ? 'review' : 'unavailable'} /></label>              {bannedAccount && <div className="rounded-xl border border-rose-400/25 bg-rose-500/5 px-3 py-2 text-[10px] leading-5 text-rose-200">تم إيقاف الحساب نهائيًا من الأتمتة بعد إبلاغ WhatsApp عن منع/حظر. لا تحاول إعادة الاتصال آليًا؛ استخدم طلب المراجعة الرسمي داخل تطبيق WhatsApp أولًا.</div>}
              {breakerOpen && !bannedAccount && <div className="rounded-xl border border-rose-400/25 bg-rose-500/5 px-3 py-2 text-[10px] leading-5 text-rose-200">تم فتح Circuit Breaker وإيقاف التشغيل بسبب {protectionLabel(account) || 'إشارة حماية'}. لا تُعاد الجدولة حتى إعادة الفحص اليدوي.</div>}{protectedAccount && !bannedAccount && account.status === 'connected' && <div className="flex items-center justify-between gap-2 rounded-xl border border-amber-400/20 bg-amber-400/5 px-3 py-2 text-[10px] text-amber-200"><span>الجلسة متصلة، لكن الحماية تمنع التشغيل حتى إعادة الفحص.</span><button type="button" onClick={() => revalidateJoinAccount(account)} disabled={revalidatingAccountId === account.id} className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-amber-300/30 px-2 py-1 font-bold text-amber-100 transition hover:bg-amber-300/10 disabled:opacity-50" aria-label={`إعادة فحص الحساب ${account.name}`}>{revalidatingAccountId === account.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}إعادة التحقق</button></div>}{notReady && <div className="rounded-xl border border-rose-400/20 bg-rose-400/5 px-3 py-2 text-[10px] text-rose-200">الحساب ظاهر كمتصل في قاعدة البيانات، لكن جلسة WhatsApp غير جاهزة حاليًا. أعد الاتصال من قسم الحسابات.</div>}</div>; })}</div><div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-[var(--text-muted)]"><span>{selectedJoinAccounts.length} حساب محدد</span><span>الحسابات المؤهلة تُستخرج من جدول الحسابات الفعلي.</span></div></div>

      <div className="rounded-2xl border border-[var(--border-default)] bg-[var(--bg-elevated)] p-4 sm:p-5"><SectionTitle icon={Clock3} title="الفاصل الزمني بين عمليات الانضمام" description="يُختار فاصل عشوائي داخل النطاق لتوزيع الحمل، وليس للتحايل على حدود الخدمة." /><div className="grid gap-3 sm:grid-cols-3"><label className="text-xs text-[var(--text-muted)]">الحد الأدنى<input type="number" min={1} value={minDelay} onChange={event => setMinDelay(Number(event.target.value))} className="mt-2 w-full rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] px-3 py-2 text-sm text-[var(--text-primary)]" /></label><label className="text-xs text-[var(--text-muted)]">الحد الأقصى<input type="number" min={1} value={maxDelay} onChange={event => setMaxDelay(Number(event.target.value))} className="mt-2 w-full rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] px-3 py-2 text-sm text-[var(--text-primary)]" /></label><label className="text-xs text-[var(--text-muted)]">الوحدة<select value={delayUnit} onChange={event => setDelayUnit(event.target.value)} className="mt-2 w-full rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] px-3 py-2 text-sm"><option value="seconds">ثوانٍ</option><option value="minutes">دقائق</option><option value="hours">ساعات</option></select></label></div><p className="mt-3 rounded-xl bg-amber-500/5 p-3 text-xs leading-5 text-amber-200">سيختار العامل وقتًا مختلفًا داخل النطاق لكل عملية، مع إعادة المحاولة المحدودة والإيقاف عند وجود حالة تتطلب تدخلًا.</p></div>
    </section>

    <section className="rounded-2xl border border-[var(--border-default)] bg-[var(--bg-elevated)] p-4 sm:p-5"><SectionTitle icon={ShieldCheck} title="إعدادات الأتمتة" description="راجع نطاق التشغيل قبل إنشاء المهمة. لا يتم تنفيذ أي عملية مباشرة من المتصفح." /><label className="flex cursor-pointer items-start gap-3 rounded-2xl border border-cyan-400/25 bg-cyan-500/5 p-4"><input type="checkbox" checked={applyAll} onChange={event => setApplyAll(event.target.checked)} className="mt-1 h-4 w-4 accent-cyan-500" /><span><span className="block text-sm font-black">تطبيق جميع الروابط على جميع الحسابات المحددة</span><span className="mt-1 block text-xs leading-5 text-[var(--text-muted)]">عند التفعيل، ينشئ النظام عملية لكل علاقة حساب × رابط. قد يؤدي ذلك إلى تكرار كبير؛ لا تفعّل الخيار إلا للحسابات والمصادر التي تملك صلاحية استخدامها.</span></span></label><div className="mt-4 flex flex-wrap gap-2 text-xs text-[var(--text-muted)]"><span className="rounded-full bg-[var(--bg-surface)] px-3 py-1.5">محاولات الإعادة: 2 كحد أقصى</span><span className="rounded-full bg-[var(--bg-surface)] px-3 py-1.5">قفل موزع ومنع Duplicate Jobs</span><span className="rounded-full bg-[var(--bg-surface)] px-3 py-1.5">توقف تلقائي عند التقييد</span></div></section>

    <section className="rounded-2xl border border-[var(--border-default)] bg-[var(--bg-elevated)] p-4 sm:p-5"><SectionTitle icon={Bot} title="إعدادات الأتمتة" description="إعدادات محفوظة لكل مستخدم، مع إعدادات مستقلة للحسابات." action={<div className="flex flex-wrap gap-2"><button type="button" onClick={emergencyStop} className="inline-flex items-center gap-2 rounded-xl border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-xs font-black text-rose-200"><Square className="h-4 w-4" />إيقاف طارئ كامل</button><button type="button" onClick={saveSettings} disabled={savingSettings} className="inline-flex items-center gap-2 rounded-xl bg-cyan-500 px-4 py-2.5 text-xs font-black text-slate-950 disabled:opacity-50">{savingSettings ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}حفظ الإعدادات</button></div>} /><div className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4"><span className="rounded-xl border border-cyan-400/15 bg-cyan-500/5 p-3 text-xs text-cyan-100">حد الدورة: <strong>{settings.cycle_limit || 30} رابطًا</strong></span><span className="rounded-xl border border-cyan-400/15 bg-cyan-500/5 p-3 text-xs text-cyan-100">مدة الدورة: <strong>{settings.cycle_duration_minutes || 60} دقيقة</strong></span><span className="rounded-xl border border-emerald-400/15 bg-emerald-500/5 p-3 text-xs text-emerald-100">التشغيل بالخلفية: <strong>مفعل</strong></span><span className="rounded-xl border border-violet-400/15 bg-violet-500/5 p-3 text-xs text-violet-100">الاستئناف التلقائي: <strong>{settings.auto_resume !== false ? 'مفعل' : 'متوقف'}</strong></span></div><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6"><label className="flex items-center gap-2 rounded-xl bg-[var(--bg-surface)] p-3 text-xs"><input type="checkbox" checked={settings.automation_enabled} onChange={event => setSettings(current => ({ ...current, automation_enabled: event.target.checked }))} className="h-4 w-4 accent-cyan-500" />تفعيل الأتمتة</label><label className="flex items-start gap-2 rounded-xl border border-amber-400/20 bg-amber-500/5 p-3 text-xs"><input type="checkbox" checked={settings.daily_limit_protection_enabled} onChange={event => setSettings(current => ({ ...current, daily_limit_protection_enabled: event.target.checked }))} className="mt-0.5 h-4 w-4 accent-amber-500" /><span><strong className="block text-amber-100">إيقاف المهمة عند تجاوز الحد اليومي</strong><span className="mt-1 block text-[10px] leading-4 text-amber-200/80">عند التعطيل، لن يمنع الحد اليومي إنشاء المهمة. تبقى حماية الحظر وRate Limit وForbidden فعالة دائمًا.</span></span></label><label className="text-xs text-[var(--text-muted)]">حد التزامن<input type="number" min={1} max={10} value={settings.max_concurrent_jobs} onChange={event => setSettings(current => ({ ...current, max_concurrent_jobs: Number(event.target.value) }))} className="mt-2 w-full rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] px-3 py-2 text-sm" /></label><label className="text-xs text-[var(--text-muted)]">عدد الإعادات<input type="number" min={0} max={5} value={settings.retry_count} onChange={event => setSettings(current => ({ ...current, retry_count: Number(event.target.value) }))} className="mt-2 w-full rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] px-3 py-2 text-sm" /></label><label className="text-xs text-[var(--text-muted)]">Backoff بالثواني<input type="number" min={1} max={3600} value={settings.retry_backoff_seconds} onChange={event => setSettings(current => ({ ...current, retry_backoff_seconds: Number(event.target.value) }))} className="mt-2 w-full rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] px-3 py-2 text-sm" /></label><label className="text-xs text-[var(--text-muted)]">أولوية Queue<input type="number" min={1} max={10} value={settings.queue_priority} onChange={event => setSettings(current => ({ ...current, queue_priority: Number(event.target.value) }))} className="mt-2 w-full rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] px-3 py-2 text-sm" /></label><label className="text-xs text-[var(--text-muted)]">الحد اليومي لكل حساب<input type="number" min={1} max={5000} step={1} value={settings.daily_operation_limit} onChange={event => setSettings(current => ({ ...current, daily_operation_limit: Number(event.target.value) }))} className="mt-2 w-full rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] px-3 py-2 text-sm" /><span className="mt-1 block text-[10px] text-amber-200">القيمة الحالية ستُطبق على المهمة الجديدة بعد الحفظ أو عند البدء.</span></label></div><div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">{dashboard.joinAccounts.map(account => { const accountSetting = settings.account_settings[account.id] || {}; return <div key={account.id} className="rounded-2xl border border-[var(--border-default)] bg-[var(--bg-surface)] p-3"><div className="flex items-center justify-between gap-2"><span className="truncate text-sm font-bold">{account.name}</span><label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={accountSetting.enabled !== false} onChange={event => updateAccountSetting(account.id, { enabled: event.target.checked })} className="h-4 w-4 accent-emerald-500" />مفعل</label></div><div className="mt-3 grid grid-cols-2 gap-2"><label className="text-[11px] text-[var(--text-muted)]">Max Concurrent<input type="number" min={1} max={3} value={accountSetting.maxConcurrent || 1} onChange={event => updateAccountSetting(account.id, { maxConcurrent: Number(event.target.value) })} className="mt-1 w-full rounded-lg border border-[var(--border-default)] bg-[var(--bg-elevated)] px-2 py-1.5 text-xs" /></label><label className="flex items-center gap-2 pt-5 text-[11px] text-[var(--text-muted)]"><input type="checkbox" checked={accountSetting.pauseOnError !== false} onChange={event => updateAccountSetting(account.id, { pauseOnError: event.target.checked })} className="h-4 w-4 accent-amber-500" />إيقاف عند الخطأ</label></div><button type="button" onClick={() => stopAccountAutomation(account)} className="mt-3 inline-flex items-center gap-1 rounded-lg border border-rose-400/25 px-2 py-1.5 text-[10px] font-bold text-rose-200"><Square className="h-3 w-3" />إيقاف هذا الحساب</button></div>; })}</div></section>

    <section className="rounded-2xl border border-cyan-400/25 bg-gradient-to-br from-cyan-500/10 to-[var(--bg-elevated)] p-5"><div className="flex flex-wrap items-center justify-between gap-4"><div><h2 className="text-lg font-black">جاهز لبدء أتمتة الانضمام؟</h2><p className="mt-1 text-xs text-[var(--text-muted)]">{selectedJoinAccounts.length} حساب · {validSelectedLinksCount} رابط صالح · {applyAll ? selectedJoinAccounts.length * validSelectedLinksCount : validSelectedLinksCount} عملية متوقعة</p>{!settings.automation_enabled && <p className="mt-2 text-xs font-bold text-amber-300">الأتمتة متوقفة من الإعدادات العامة.</p>}</div><button type="button" onClick={requestAutomation} disabled={busy || !settings.automation_enabled || !selectedJoinAccounts.length || !validSelectedLinksCount} className="inline-flex items-center gap-2 rounded-2xl bg-emerald-500 px-5 py-3 text-sm font-black text-slate-950 shadow-lg transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"><Play className="h-5 w-5" />بدء أتمتة الانضمام</button></div></section>

    <section className="rounded-2xl border border-[var(--border-default)] bg-[var(--bg-elevated)] p-4 sm:p-5"><SectionTitle icon={Activity} title="متابعة العملية" description="تستمر المهمة في الخلفية عبر Queue حتى عند إغلاق Dashboard." action={<div className="flex flex-wrap gap-2"><button type="button" onClick={() => controlTask('paused')} disabled={!taskId || taskStatus !== 'pending'} className="inline-flex items-center gap-1.5 rounded-xl border border-amber-400/25 px-3 py-2 text-xs font-bold text-amber-300 disabled:opacity-40"><Pause className="h-4 w-4" />إيقاف مؤقت</button><button type="button" onClick={() => controlTask('pending')} disabled={!taskId || taskStatus !== 'paused'} className="inline-flex items-center gap-1.5 rounded-xl border border-emerald-400/25 px-3 py-2 text-xs font-bold text-emerald-300 disabled:opacity-40"><Play className="h-4 w-4" />استئناف</button><button type="button" onClick={() => controlTask('stopped')} disabled={!taskId || ['stopped', 'completed'].includes(taskStatus)} className="inline-flex items-center gap-1.5 rounded-xl border border-rose-400/25 px-3 py-2 text-xs font-bold text-rose-300 disabled:opacity-40"><Square className="h-4 w-4" />إيقاف الكل</button></div>} />{taskId ? <><div className="mb-4 flex flex-wrap items-center justify-between gap-3"><div className="text-xs text-[var(--text-muted)]">المهمة: <span className="font-mono text-cyan-300">{taskId}</span> · الحالة: <StatusBadge value={taskStatus === 'pending' ? 'queued' : taskStatus} /></div><div className="text-sm font-black text-cyan-300">{taskProgress}%</div></div><div className="h-3 overflow-hidden rounded-full bg-[var(--bg-surface)]"><div className="h-full rounded-full bg-gradient-to-l from-cyan-400 to-emerald-400 transition-all" style={{ width: `${taskProgress}%` }} /></div><div className="mt-3 grid grid-cols-2 gap-3 text-xs sm:grid-cols-5">{Object.entries(taskDashboard?.stats || {}).filter(([key]) => ['total', 'processing', 'success', 'failed', 'review'].includes(key)).map(([key, value]) => <div key={key} className="rounded-xl bg-[var(--bg-surface)] p-3"><span className="block text-[var(--text-muted)]">{key === 'total' ? 'الإجمالي' : key === 'processing' ? 'قيد التنفيذ' : key === 'success' ? 'نجاح' : key === 'failed' ? 'فشل' : 'مراجعة'}</span><strong className="mt-1 block text-base">{value}</strong></div>)}</div><div className="mt-4 overflow-hidden rounded-2xl border border-[var(--border-default)]"><div className="grid grid-cols-[1.1fr_1.5fr_.7fr_.9fr] gap-3 bg-[var(--bg-surface)] px-3 py-2 text-[10px] font-bold text-[var(--text-muted)]"><span>الحساب</span><span>الرابط</span><span>المرحلة</span><span>الحالة</span></div><div className="max-h-64 divide-y divide-[var(--border-default)] overflow-auto">{(taskDashboard?.operations || []).slice(0, 12).map((operation: any) => <div key={operation.id} className="grid grid-cols-[1.1fr_1.5fr_.7fr_.9fr] items-center gap-3 px-3 py-3 text-[11px]"><span className="truncate font-bold">{operation.account_name || 'حساب'}</span><span className="truncate font-mono text-cyan-300" dir="ltr">{operation.url || '—'}</span><span className="truncate text-[var(--text-muted)]">{operation.current_stage || '—'}</span><StatusBadge value={operation.membership_state === 'ALREADY_MEMBER' ? 'already_member' : operation.status} /></div>)}</div></div></> : <div className="rounded-2xl border border-dashed border-[var(--border-default)] p-8 text-center text-sm text-[var(--text-muted)]">لم تبدأ مهمة بعد. اختر الحسابات والروابط ثم راجع العملية قبل البدء.</div>}</section>

    <section className="grid gap-5 xl:grid-cols-[1.2fr_.8fr]"><div className="rounded-2xl border border-[var(--border-default)] bg-[var(--bg-elevated)] p-4 sm:p-5"><SectionTitle icon={Activity} title="سجل العمليات" description="آخر الأحداث المسجلة من العامل والـ Queue." action={<button type="button" onClick={exportOperationLog} className="inline-flex items-center gap-2 rounded-xl border border-cyan-400/25 px-3 py-2 text-xs font-bold text-cyan-300"><Download className="h-4 w-4" />تصدير السجل</button>} />{taskDashboard?.events?.length ? <div className="max-h-80 space-y-2 overflow-auto">{taskDashboard.events.map((event: any) => <div key={event.id} className="flex items-start gap-3 rounded-xl bg-[var(--bg-surface)] p-3 text-xs"><span className="mt-0.5 rounded-full bg-cyan-500/10 p-1.5 text-cyan-300"><Activity className="h-3.5 w-3.5" /></span><div className="min-w-0 flex-1"><p className="font-bold">{event.event_type || event.eventType || 'تحديث'}</p><p className="mt-1 text-[var(--text-muted)]">{formatDate(event.created_at || event.at)}</p></div></div>)}</div> : <div className="rounded-2xl border border-dashed border-[var(--border-default)] p-8 text-center text-sm text-[var(--text-muted)]">ستظهر الأحداث هنا عند بدء مهمة حقيقية.</div>}</div><div className="rounded-2xl border border-[var(--border-default)] bg-[var(--bg-elevated)] p-4 sm:p-5"><SectionTitle icon={AlertTriangle} title="الإشعارات والتنبيهات" description="تنبيهات مباشرة لا تكشف Tokens أو أسرار الجلسات." />{notifications.length ? <div className="max-h-80 space-y-2 overflow-auto">{notifications.map(item => <div key={item.id} className={cn('rounded-xl border p-3 text-xs', item.tone === 'error' ? 'border-rose-400/25 bg-rose-500/5 text-rose-200' : item.tone === 'warning' ? 'border-amber-400/25 bg-amber-500/5 text-amber-200' : item.tone === 'success' ? 'border-emerald-400/25 bg-emerald-500/5 text-emerald-200' : 'border-cyan-400/25 bg-cyan-500/5 text-cyan-200')}>{item.text}</div>)}</div> : <div className="rounded-2xl border border-dashed border-[var(--border-default)] p-8 text-center text-sm text-[var(--text-muted)]">لا توجد تنبيهات جديدة.</div>}</div></section>

    {detailsLink && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => { setDetailsLink(null); setDetailsData(null); }}><div className="w-full max-w-xl rounded-2xl border border-[var(--border-strong)] bg-[var(--bg-surface)] p-5 shadow-2xl" onClick={event => event.stopPropagation()}><div className="flex items-center justify-between"><h3 className="text-lg font-black">تفاصيل الرابط</h3><button type="button" onClick={() => { setDetailsLink(null); setDetailsData(null); }} className="rounded-lg p-2 text-[var(--text-muted)] hover:bg-[var(--bg-hover)]"><X className="h-4 w-4" /></button></div><a href={detailsLink.whatsapp_link} target="_blank" rel="noreferrer" className="mt-4 block break-all rounded-xl bg-[var(--bg-elevated)] p-3 font-mono text-sm text-cyan-300" dir="ltr">{detailsLink.whatsapp_link}</a><div className="mt-4 grid grid-cols-2 gap-3 text-xs"><div className="rounded-xl bg-[var(--bg-elevated)] p-3"><span className="text-[var(--text-muted)]">المصدر</span><strong className="mt-1 block">{detailsLink.source_group || '—'}</strong></div><div className="rounded-xl bg-[var(--bg-elevated)] p-3"><span className="text-[var(--text-muted)]">الحساب</span><strong className="mt-1 block">{detailsLink.source_account_name || '—'}</strong></div><div className="rounded-xl bg-[var(--bg-elevated)] p-3"><span className="text-[var(--text-muted)]">عدد التكرارات</span><strong className="mt-1 block">{detailsLink.duplicate_count || 0}</strong></div><div className="rounded-xl bg-[var(--bg-elevated)] p-3"><span className="text-[var(--text-muted)]">آخر ظهور</span><strong className="mt-1 block">{formatDate(detailsLink.last_seen)}</strong></div></div>{detailsLink.source_history?.length ? <div className="mt-4"><p className="mb-2 text-xs font-bold">تاريخ المصادر</p><div className="max-h-32 space-y-1 overflow-auto">{detailsLink.source_history.map((item, index) => <p key={`${item.seenAt}-${index}`} className="rounded-lg bg-[var(--bg-elevated)] p-2 text-xs text-[var(--text-muted)]">{item.accountName || 'حساب'} · {item.group || 'مصدر'} · {formatDate(item.seenAt)}</p>)}</div></div> : null}{detailsData ? <><div className="mt-4 grid gap-2 text-xs"><div className="rounded-xl bg-[var(--bg-elevated)] p-3"><span className="text-[var(--text-muted)]">الرابط الأصلي</span><p className="mt-1 break-all font-mono" dir="ltr">{detailsData.link?.original_url || detailsLink.whatsapp_link}</p></div><div className="rounded-xl bg-[var(--bg-elevated)] p-3"><span className="text-[var(--text-muted)]">الرابط المطبّع</span><p className="mt-1 break-all font-mono text-cyan-300" dir="ltr">{detailsData.link?.normalized_url || detailsLink.whatsapp_link}</p></div></div><div className="mt-4"><p className="mb-2 text-xs font-bold">المهام والعمليات المرتبطة ({detailsData.operations?.length || 0})</p><div className="max-h-36 space-y-1 overflow-auto">{detailsData.operations?.length ? detailsData.operations.map((operation: any) => <p key={operation.id} className="rounded-lg bg-[var(--bg-elevated)] p-2 text-xs">{operation.account_id?.slice?.(0, 8) || 'حساب'} · <StatusBadge value={operation.status} /> · {formatDate(operation.created_at)}{operation.last_error ? ` · ${operation.last_error}` : ''}</p>) : <span className="text-xs text-[var(--text-muted)]">لا توجد عمليات بعد.</span>}</div></div><div className="mt-4"><p className="mb-2 text-xs font-bold">الخط الزمني ({detailsData.events?.length || 0})</p><div className="max-h-36 space-y-1 overflow-auto">{detailsData.events?.length ? detailsData.events.map((event: any) => <p key={event.id} className="rounded-lg bg-[var(--bg-elevated)] p-2 text-xs">{event.event_type} · {formatDate(event.created_at)}</p>) : <span className="text-xs text-[var(--text-muted)]">لا توجد أحداث بعد.</span>}</div></div></> : <div className="mt-4 rounded-xl bg-[var(--bg-elevated)] p-3 text-center text-xs text-[var(--text-muted)]"><Loader2 className="mx-auto mb-2 h-4 w-4 animate-spin" />جارٍ تحميل العمليات المرتبطة…</div>}<div className="mt-5 flex justify-end"><button type="button" onClick={() => archiveLink(detailsLink.id)} className="inline-flex items-center gap-2 rounded-xl border border-rose-400/25 px-3 py-2 text-xs font-bold text-rose-300"><Trash2 className="h-4 w-4" />أرشفة الرابط</button></div></div></div>}

    {reviewOpen && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={() => !busy && setReviewOpen(false)}><div className="w-full max-w-lg rounded-3xl border border-cyan-400/25 bg-[var(--bg-surface)] p-5 shadow-2xl" onClick={event => event.stopPropagation()}><div className="flex items-center gap-3"><div className="rounded-xl bg-cyan-500/10 p-2 text-cyan-300"><ShieldCheck className="h-5 w-5" /></div><div><h3 className="text-lg font-black">مراجعة العملية</h3><p className="text-xs text-[var(--text-muted)]">لن تبدأ العملية قبل تأكيدك.</p></div></div><div className="mt-5 grid grid-cols-2 gap-3 text-sm"><div className="rounded-xl bg-[var(--bg-elevated)] p-3"><span className="text-xs text-[var(--text-muted)]">الحسابات المحددة</span><strong className="mt-1 block text-xl">{selectedJoinAccounts.length}</strong></div><div className="rounded-xl bg-[var(--bg-elevated)] p-3"><span className="text-xs text-[var(--text-muted)]">الروابط المحددة</span><strong className="mt-1 block text-xl">{selectedLinksCount}</strong></div><div className="rounded-xl bg-[var(--bg-elevated)] p-3"><span className="text-xs text-[var(--text-muted)]">الروابط الصالحة</span><strong className="mt-1 block text-xl text-emerald-300">{validSelectedLinksCount}</strong></div><div className="rounded-xl bg-[var(--bg-elevated)] p-3"><span className="text-xs text-[var(--text-muted)]">التكرارات</span><strong className="mt-1 block text-xl text-amber-300">{selectedLinks.reduce((sum, link) => sum + Number(link.duplicate_count || 0), 0)}</strong></div></div><div className="mt-4 rounded-xl border border-amber-400/25 bg-amber-500/5 p-3 text-xs leading-5 text-amber-200">الفاصل الزمني: {minDelay}–{maxDelay} {delayUnit === 'seconds' ? 'ثانية' : delayUnit === 'minutes' ? 'دقيقة' : 'ساعة'}. الحد اليومي الفعلي لكل حساب: <strong>{settings.daily_operation_limit}</strong> عملية. {applyAll ? 'سيتم تطبيق جميع الروابط على جميع الحسابات المحددة.' : 'سيتم توزيع الروابط بالتتابع على الحسابات المحددة.'}</div><div className="mt-4 flex items-start gap-2 rounded-xl bg-[var(--bg-elevated)] p-3 text-xs leading-5 text-[var(--text-muted)]"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />سيتم تنفيذ العمليات وفق الحدود والسياسات المسموح بها للخدمة. إذا ظهر تقييد أو خطأ متكرر، يتوقف الحساب وتحتاج العملية إلى تدخل المستخدم.</div><div className="mt-5 flex justify-end gap-2"><button type="button" onClick={() => setReviewOpen(false)} disabled={busy} className="rounded-xl border border-[var(--border-default)] px-4 py-2.5 text-sm">إلغاء</button><button type="button" onClick={confirmAutomation} disabled={busy} className="inline-flex items-center gap-2 rounded-xl bg-emerald-500 px-4 py-2.5 text-sm font-black text-slate-950">{busy && <Loader2 className="h-4 w-4 animate-spin" />}تأكيد وبدء</button></div></div></div>}
  </main>;
}
