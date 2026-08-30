import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Search, Plus, Smartphone, Trash2,
  RotateCcw, Play, Square, RefreshCw, ChevronDown, Activity,
  Megaphone, Users, Eye, Ban, Settings, FileText, Wifi,
  BarChart2, Clock, Check, X, AlertTriangle, Play as PlayIcon, Square as StopIcon,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { StatCard } from '@/components/ui/stat-card';
import { EmptyState } from '@/components/ui/empty-state';
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent,
  DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip';
import { useToast } from '@/components/ui/ToastProvider';
import { API, authFetch } from '@/utils/api';
import { cn } from '@/utils/cn';
import { ConnectionMethodModal } from '@/components/ConnectionMethodModal';

const SOCKET_URL = API.replace('/api/v1', '');

// ── تعريف الأدوار ─────────────────────────────────────────────────────────────
// الألوان الآن مرتبطة بـ design tokens (نفس نمط الجولة 2/3) بدل درجات Tailwind الثابتة،
// مع الإبقاء على لون مميز لكل دور عبر hex ثابت يُغذّي color-mix في StatCard/الشارات.
const ROLES = [
  {
    id: 'publisher',
    label: 'ناشر',
    icon: Megaphone,
    swatch: '#4f8ef7', // brand-secondary-500
    description: 'ينشر الإعلانات في المجموعات',
  },
  {
    id: 'searcher',
    label: 'باحث',
    icon: Search,
    swatch: '#a855f7',
    description: 'يبحث ويفهرس روابط المجموعات',
  },
  {
    id: 'joiner',
    label: 'منضم',
    icon: Users,
    swatch: 'var(--warning)',
    description: 'ينضم للمجموعات تلقائياً',
  },
  {
    id: 'monitor',
    label: 'مراقب',
    icon: Eye,
    swatch: '#06b6d4',
    description: 'يراقب المجموعات ويكتشف الروابط',
  },
  {
    id: 'stopped',
    label: 'متوقف',
    icon: Ban,
    swatch: 'var(--text-muted)',
    description: 'موقوف مؤقتاً',
  },
];

function getRoleInfo(roleId: string) {
  return ROLES.find(r => r.id === roleId) || ROLES[ROLES.length - 1];
}

// ── بطاقة الحساب ─────────────────────────────────────────────────────────────
function AccountCard({
  account,
  selected,
  onSelect,
  onConnect,
  onReset,
  onDelete,
  onStart,
  onStop,
  onRestart,
  onRoleChange,
  onTest,
  onViewLogs,
  bulkChecked,
  onBulkToggle,
}: any) {
  const [loadingAction, setLoadingAction] = useState<string | null>(null);
  const role = getRoleInfo(account.role);
  const RoleIcon = role.icon;
  const isConnected = account.status === 'connected';
  const isRunning   = account.task_status === 'running';

  const action = async (fn: () => Promise<void>, key: string) => {
    setLoadingAction(key);
    try { await fn(); } finally { setLoadingAction(null); }
  };

  return (
    <Card className={cn(
      'relative overflow-hidden flex flex-col group transition-all duration-200',
      selected ? 'ring-2 ring-[var(--brand-primary)] shadow-[var(--shadow-lg)]' : 'hover:border-[var(--border-strong)]'
    )}>
      {/* شريط الدور (أعلى البطاقة) */}
      <div className="absolute top-0 left-0 w-full h-1" style={{ backgroundColor: role.swatch }} />

      <CardContent className="p-4 flex flex-col gap-3 pt-5">
        {/* رأس البطاقة */}
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-2.5">
            <Checkbox
              checked={bulkChecked}
              onCheckedChange={() => onBulkToggle(account.id)}
              aria-label={`تحديد ${account.name} للإجراء الجماعي`}
              className="mt-1 shrink-0"
            />
            <div className="relative">
              <div className="w-10 h-10 rounded-full bg-[var(--bg-elevated)] flex items-center justify-center border border-[var(--border-strong)]">
                <Smartphone className="w-5 h-5 text-[var(--text-primary)]" />
              </div>
              {/* مؤشر الاتصال */}
              <span
                className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-[var(--bg-surface)]"
                style={{ backgroundColor: isConnected ? 'var(--success)' : 'var(--danger)' }}
                aria-hidden="true"
              />
            </div>
            <div>
              <h3 className="font-bold text-[var(--text-primary)] text-sm leading-tight">{account.name}</h3>
              <p className="text-xs text-[var(--text-muted)] dir-ltr">
                {account.phone_number || 'لا يوجد رقم'}
              </p>
            </div>
          </div>

          {/* شارة الدور */}
          <Badge
            dot={isRunning}
            className="border"
            style={{
              backgroundColor: `color-mix(in srgb, ${role.swatch} 14%, transparent)`,
              color: role.swatch,
              borderColor: `color-mix(in srgb, ${role.swatch} 30%, transparent)`,
            }}
          >
            <RoleIcon className="w-3 h-3" />
            <span>{role.label}</span>
          </Badge>
        </div>

        {/* إحصائيات سريعة */}
        <div className="grid grid-cols-3 gap-1.5 bg-[var(--bg-app)] rounded-lg p-2 text-center">
          <div>
            <p className="text-[10px] text-[var(--text-muted)]">الرسائل</p>
            <p className="text-xs font-bold text-[var(--text-primary)]">
              {account.messages_sent_today || 0}
            </p>
          </div>
          <div className="border-r border-l border-[var(--border-default)]">
            <p className="text-[10px] text-[var(--text-muted)]">الحالة</p>
            <p className="text-xs font-bold" style={{ color: isConnected ? 'var(--success)' : 'var(--danger)' }}>
              {isConnected ? 'متصل' : 'مفصول'}
            </p>
          </div>
          <div>
            <p className="text-[10px] text-[var(--text-muted)]">نوع الربط</p>
            <p className="text-[10px] font-medium text-[var(--text-muted)] truncate">
              {account.connection_type === 'business_api' ? '🏢 API'
               : account.connection_type === 'pairing_code' ? '#️⃣ Pair'
               : '📱 QR'}
            </p>
          </div>
        </div>

        {/* أزرار التحكم الرئيسية */}
        <TooltipProvider delayDuration={300}>
          <div className="flex gap-1.5">
            <Button
              variant={selected ? 'default' : 'outline'}
              className="flex-1 text-xs h-8"
              onClick={() => onSelect(account.id)}
              aria-pressed={selected}
            >
              {selected && <Check className="w-3.5 h-3.5" />}
              {selected ? 'مُحدد' : 'تحديد'}
            </Button>

            {/* تشغيل/إيقاف المهام */}
            {isConnected && account.role !== 'stopped' && (
              isRunning ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="outline"
                      className="px-2 h-8"
                      style={{ color: 'var(--warning)', borderColor: 'color-mix(in srgb, var(--warning) 30%, transparent)' }}
                      onClick={() => action(() => onStop(account.id), 'stop')}
                      disabled={loadingAction === 'stop'}
                      aria-label="إيقاف المهام"
                    >
                      {loadingAction === 'stop'
                        ? <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                        : <Square className="w-3.5 h-3.5" />
                      }
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>إيقاف المهام</TooltipContent>
                </Tooltip>
              ) : (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="outline"
                      className="px-2 h-8"
                      style={{ color: 'var(--success)', borderColor: 'color-mix(in srgb, var(--success) 30%, transparent)' }}
                      onClick={() => action(() => onStart(account.id), 'start')}
                      disabled={loadingAction === 'start'}
                      aria-label="تشغيل المهام"
                    >
                      {loadingAction === 'start'
                        ? <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                        : <Play className="w-3.5 h-3.5" />
                      }
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>تشغيل المهام</TooltipContent>
                </Tooltip>
              )
            )}

            {/* إعادة تشغيل */}
            {isConnected && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    className="px-2 h-8 hover:text-[var(--info)]"
                    onClick={() => action(() => onRestart(account.id), 'restart')}
                    disabled={loadingAction === 'restart'}
                    aria-label="إعادة تشغيل"
                  >
                    <RotateCcw className={cn('w-3.5 h-3.5', loadingAction === 'restart' ? 'animate-spin' : '')} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>إعادة تشغيل</TooltipContent>
              </Tooltip>
            )}
          </div>

          {/* أزرار ثانوية */}
          <div className="flex gap-1.5">
            {/* تغيير الدور — DropdownMenu بدل div يدوي غير مُتاح بلوحة المفاتيح */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  className="flex-1 text-xs h-7 gap-1 justify-between"
                  aria-label={`تغيير دور الحساب، الدور الحالي ${role.label}`}
                >
                  <span className="flex items-center gap-1">
                    <Settings className="w-3 h-3" />
                    <span>الدور</span>
                  </span>
                  <ChevronDown className="w-3 h-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-64">
                <DropdownMenuLabel>اختر دور الحساب</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {ROLES.map(r => {
                  const RI = r.icon;
                  const isCurrent = account.role === r.id;
                  return (
                    <DropdownMenuItem
                      key={r.id}
                      onSelect={() => onRoleChange(account.id, r.id)}
                      className={isCurrent ? 'bg-[var(--bg-hover)]' : ''}
                    >
                      <RI className="w-3.5 h-3.5" style={{ color: r.swatch }} />
                      <span className="text-[var(--text-primary)]">{r.label}</span>
                      <span className="text-[var(--text-muted)] mr-auto text-xs">{r.description}</span>
                      {isCurrent && <Check className="w-3.5 h-3.5" style={{ color: 'var(--success)' }} />}
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>

            {/* ربط واتساب */}
            {!isConnected && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    className="px-2 h-7 hover:text-[var(--success)]"
                    onClick={() => onConnect(account.id)}
                    aria-label="ربط واتساب"
                  >
                    <Wifi className="w-3 h-3" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>ربط واتساب</TooltipContent>
              </Tooltip>
            )}

            {/* إعادة تهيئة الجلسة */}
            {!isConnected && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    className="px-2 h-7 hover:text-[var(--warning)]"
                    onClick={() => onReset(account.id)}
                    aria-label="إعادة تهيئة رمز QR"
                  >
                    <RotateCcw className="w-3 h-3" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>إعادة تهيئة QR</TooltipContent>
              </Tooltip>
            )}

            {/* اختبار الاتصال */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  className="px-2 h-7 hover:text-[var(--info)]"
                  onClick={() => onTest(account.id)}
                  aria-label="اختبار الاتصال"
                >
                  <Activity className="w-3 h-3" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>اختبار الاتصال</TooltipContent>
            </Tooltip>

            {/* السجلات */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  className="px-2 h-7 hover:text-[#a855f7]"
                  onClick={() => onViewLogs(account.id, account.name)}
                  aria-label="عرض السجلات"
                >
                  <FileText className="w-3 h-3" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>عرض السجلات</TooltipContent>
            </Tooltip>

            {/* حذف */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  className="px-2 h-7 text-[var(--danger)] hover:bg-[var(--danger-bg)] hover:text-[var(--danger)]"
                  onClick={() => onDelete(account.id)}
                  aria-label="حذف الحساب"
                >
                  <Trash2 className="w-3 h-3" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>حذف الحساب</TooltipContent>
            </Tooltip>
          </div>
        </TooltipProvider>

        {/* آخر نشاط */}
        {account.last_activity_at && (
          <p className="text-[10px] text-[var(--text-muted)] flex items-center gap-1">
            <Clock className="w-2.5 h-2.5" />
            {new Date(account.last_activity_at).toLocaleString('ar')}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// ── نافذة سجلات الحساب ───────────────────────────────────────────────────────
function LogsModal({ accountId, accountName, onClose }: any) {
  const [logs, setLogs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    authFetch(`${API}/accounts/${accountId}/logs?limit=50`)
      .then(r => r.json())
      .then(d => setLogs(d.logs || []))
      .catch(() => setLogs([]))
      .finally(() => setLoading(false));
  }, [accountId]);

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText className="w-4 h-4" />
            سجلات: {accountName}
          </DialogTitle>
        </DialogHeader>
        <div className="max-h-80 overflow-y-auto space-y-1">
          {loading ? (
            <div className="flex flex-col gap-2 py-2">
              {[1, 2, 3, 4].map(i => <Skeleton key={i} className="h-8 w-full rounded-lg" />)}
            </div>
          ) : logs.length === 0 ? (
            <EmptyState
              icon={FileText}
              title="لا توجد سجلات"
              description="لم يتم تسجيل أي أحداث لهذا الحساب بعد."
              className="py-8"
            />
          ) : logs.map((log, i) => (
            <div
              key={i}
              className="flex items-start gap-2 px-3 py-2 rounded-lg text-xs"
              style={{
                backgroundColor:
                  log.level === 'error' ? 'var(--danger-bg)' :
                  log.level === 'warn'  ? 'var(--warning-bg)' :
                  'var(--bg-elevated)',
                color:
                  log.level === 'error' ? 'var(--danger)' :
                  log.level === 'warn'  ? 'var(--warning)' :
                  'var(--text-secondary)',
              }}
            >
              <span className="text-[var(--text-muted)] whitespace-nowrap">
                {new Date(log.created_at).toLocaleTimeString('ar')}
              </span>
              <span>{log.message}</span>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── المكوّن الرئيسي ───────────────────────────────────────────────────────────
interface AccountsViewProps {
  accounts: any[];
  loading: boolean;
  fetchAccounts: () => void;
  selectedAccountId: string | null;
  setSelectedAccountId: (id: string | null) => void;
}

export default function AccountsView({
  accounts, loading, fetchAccounts, selectedAccountId, setSelectedAccountId
}: AccountsViewProps) {
  const [search, setSearch]           = useState('');
  const [filterRole, setFilterRole]   = useState('all');
  const [isAddOpen, setIsAddOpen]     = useState(false);
  const [newName, setNewName]         = useState('');
  const [summary, setSummary]         = useState<any>({});
  const [logsModal, setLogsModal]     = useState<{ id: string; name: string } | null>(null);
  // ── نافذة طرق الربط ────────────────────────────────────────────────────────
  const [connectModal, setConnectModal] = useState<{ id: string; name: string } | null>(null);
  // ── التحديد الجماعي (Bulk Actions) ────────────────────────────────────────
  const [bulkIds, setBulkIds]         = useState<Set<string>>(new Set());
  const [deleteTarget, setDeleteTarget] = useState<{ ids: string[]; names: string[] } | null>(null);
  const [bulkBusy, setBulkBusy]       = useState<string | null>(null);
  const { addToast } = useToast();

  // جلب الملخص
  const fetchSummary = useCallback(async () => {
    try {
      const r = await authFetch(`${API}/accounts/summary`);
      const d = await r.json();
      if (d.success) setSummary(d.summary);
    } catch {}
  }, []);

  useEffect(() => {
    fetchSummary();
    const iv = setInterval(fetchSummary, 30000);
    return () => clearInterval(iv);
  }, [fetchSummary]);

  // تصفية الحسابات
  const filtered = useMemo(() => accounts.filter(a => {
    const matchSearch = a.name.toLowerCase().includes(search.toLowerCase())
      || (a.phone_number || '').includes(search);
    const matchRole = filterRole === 'all' || a.role === filterRole;
    return matchSearch && matchRole;
  }), [accounts, search, filterRole]);

  // إفراغ التحديد الجماعي عند تغيير الفلترة/البحث كي لا يبقى تحديد لعناصر مخفية
  useEffect(() => { clearBulk(); }, [search, filterRole]);

  const filteredIds = useMemo(() => filtered.map(a => a.id), [filtered]);
  const allFilteredSelected = filteredIds.length > 0 && filteredIds.every(id => bulkIds.has(id));
  const someFilteredSelected = filteredIds.some(id => bulkIds.has(id));

  const toggleSelectAllFiltered = () => {
    setBulkIds(prev => {
      if (allFilteredSelected) return new Set();
      return new Set(filteredIds);
    });
  };

  // ── إضافة حساب ────────────────────────────────────────────────────────────
  const handleAdd = async () => {
    if (!newName.trim()) return;
    try {
      const res  = await authFetch(`${API}/accounts`, {
        method: 'POST',
        body: JSON.stringify({ name: newName.trim() }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        addToast({ title: 'تم الإنشاء', description: 'اختر طريقة ربط الحساب', type: 'success' });
        setIsAddOpen(false);
        setNewName('');
        fetchAccounts();
        fetchSummary();
        // افتح نافذة طرق الربط مباشرة
        setConnectModal({ id: data.account.id, name: data.account.name });
      } else {
        addToast({ title: 'خطأ', description: data.error || 'فشل الإنشاء', type: 'error' });
      }
    } catch {
      addToast({ title: 'خطأ', description: 'فشل إنشاء الحساب', type: 'error' });
    }
  };

  // ── فتح نافذة طرق الربط ───────────────────────────────────────────────────
  const handleConnect = (id: string) => {
    const account = accounts.find(a => a.id === id);
    setConnectModal({ id, name: account?.name || id });
  };

  // ── إعادة تهيئة الجلسة (QR جديد) ─────────────────────────────────────────
  const handleReset = async (id: string) => {
    try {
      await authFetch(`${API}/accounts/${id}/reset`, { method: 'POST' });
      addToast({ title: 'جارٍ الإعادة', description: 'اختر طريقة الربط من جديد', type: 'success' });
      // افتح نافذة طرق الربط بعد الإعادة
      const account = accounts.find(a => a.id === id);
      setConnectModal({ id, name: account?.name || id });
    } catch {
      addToast({ title: 'خطأ', description: 'فشلت إعادة تهيئة الجلسة', type: 'error' });
    }
  };

  // ── حذف الحساب (فردي) — يفتح نافذة تأكيد بدل window.confirm ────────────────
  const handleDelete = (id: string) => {
    const account = accounts.find(a => a.id === id);
    setDeleteTarget({ ids: [id], names: [account?.name || id] });
  };

  // ── تنفيذ الحذف الفعلي بعد التأكيد (فردي أو جماعي) ──────────────────────────
  const confirmDelete = async () => {
    if (!deleteTarget) return;
    const { ids } = deleteTarget;
    try {
      await Promise.all(ids.map(id => authFetch(`${API}/accounts/${id}`, { method: 'DELETE' })));
      addToast({
        title: ids.length > 1 ? `تم حذف ${ids.length} حسابات` : 'تم الحذف',
        type: 'success',
      });
      fetchAccounts();
      fetchSummary();
      if (selectedAccountId && ids.includes(selectedAccountId)) setSelectedAccountId(null);
      setBulkIds(prev => {
        const next = new Set(prev);
        ids.forEach(id => next.delete(id));
        return next;
      });
    } catch {
      addToast({ title: 'خطأ', description: 'فشل حذف بعض الحسابات', type: 'error' });
    } finally {
      setDeleteTarget(null);
    }
  };

  // ── تبديل تحديد حساب واحد في القائمة الجماعية ───────────────────────────────
  const toggleBulk = (id: string) => {
    setBulkIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const clearBulk = () => setBulkIds(new Set());

  // ── تشغيل/إيقاف جماعي ────────────────────────────────────────────────────
  const bulkSetRunning = async (start: boolean) => {
    const ids = Array.from(bulkIds);
    if (ids.length === 0) return;
    setBulkBusy(start ? 'start' : 'stop');
    try {
      const results = await Promise.allSettled(
        ids.map(id => authFetch(`${API}/accounts/${id}/${start ? 'start' : 'stop'}`, { method: 'POST' }))
      );
      const failed = results.filter(r => r.status === 'rejected').length;
      addToast({
        title: start ? 'تم تشغيل الحسابات المحددة' : 'تم إيقاف الحسابات المحددة',
        description: failed > 0 ? `فشل ${failed} من ${ids.length}` : undefined,
        type: failed > 0 ? 'error' : 'success',
      });
      fetchAccounts();
    } finally {
      setBulkBusy(null);
    }
  };

  // ── تغيير الدور ───────────────────────────────────────────────────────────
  const handleRoleChange = async (id: string, role: string) => {
    try {
      const res  = await authFetch(`${API}/accounts/${id}/role`, {
        method: 'PATCH',
        body: JSON.stringify({ role }),
      });
      const data = await res.json();
      if (data.success) {
        addToast({ title: 'تم التغيير', description: data.message, type: 'success' });
        fetchAccounts();
        fetchSummary();
      } else {
        addToast({ title: 'خطأ', description: data.error, type: 'error' });
      }
    } catch {
      addToast({ title: 'خطأ', description: 'فشل تغيير الدور', type: 'error' });
    }
  };

  // ── تشغيل المهام ──────────────────────────────────────────────────────────
  const handleStart = async (id: string) => {
    const res  = await authFetch(`${API}/accounts/${id}/start`, { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      addToast({ title: 'تم التشغيل ✓', description: data.message, type: 'success' });
      fetchAccounts();
    } else {
      addToast({ title: 'خطأ', description: data.error, type: 'error' });
    }
  };

  // ── إيقاف المهام ──────────────────────────────────────────────────────────
  const handleStop = async (id: string) => {
    const res  = await authFetch(`${API}/accounts/${id}/stop`, { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      addToast({ title: 'تم الإيقاف', description: data.message, type: 'success' });
      fetchAccounts();
    }
  };

  // ── إعادة التشغيل ─────────────────────────────────────────────────────────
  const handleRestart = async (id: string) => {
    const res  = await authFetch(`${API}/accounts/${id}/restart`, { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      addToast({ title: 'تمت الإعادة', description: data.message, type: 'success' });
      fetchAccounts();
    }
  };

  // ── اختبار الاتصال ────────────────────────────────────────────────────────
  const handleTest = async (id: string) => {
    const res  = await authFetch(`${API}/accounts/${id}/test`, { method: 'POST' });
    const data = await res.json();
    addToast({
      title: data.connected ? 'الاتصال سليم ✓' : 'الاتصال منقطع',
      description: data.connected
        ? `المستخدم: ${data.sessionUser || 'متصل'}`
        : 'يرجى إعادة ربط الحساب',
      type: data.connected ? 'success' : 'error',
    });
  };

  // ── عرض السجلات ───────────────────────────────────────────────────────────
  const handleViewLogs = (id: string, name: string) => {
    setLogsModal({ id, name });
  };

  const roleCount = (id: string) => accounts.filter(a => a.role === id).length;

  return (
    <div className="flex flex-col gap-5 animate-fade-in h-full">

      {/* ── ملخص الأدوار — StatCard الموحّد بدل بطاقات مكررة يدوياً ─────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <StatCard
          title="الكلي"
          value={summary.total || 0}
          icon={Smartphone}
          color="var(--brand-primary)"
        />
        <StatCard
          title="متصل"
          value={summary.connected || 0}
          icon={Wifi}
          color="var(--success)"
        />
        <StatCard
          title="ناشرون"
          value={summary.publishers || 0}
          icon={Megaphone}
          color="#4f8ef7"
        />
        <StatCard
          title="باحثون"
          value={summary.searchers || 0}
          icon={Search}
          color="#a855f7"
        />
        <StatCard
          title="منضمون"
          value={summary.joiners || 0}
          icon={Users}
          color="var(--warning)"
        />
        <StatCard
          title="مراقبون"
          value={summary.monitors || 0}
          icon={Eye}
          color="#06b6d4"
        />
      </div>

      {/* ── شريط الأدوات ─────────────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
        <div>
          <h1 className="text-heading-m font-bold text-[var(--text-primary)]">الحسابات</h1>
          <p className="text-body-s text-[var(--text-secondary)]">إدارة حسابات واتساب وأدوارها المستقلة</p>
        </div>
        <div className="flex items-center gap-2 w-full sm:w-auto">
          {filtered.length > 0 && (
            <TooltipProvider delayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
                <button
                  onClick={toggleSelectAllFiltered}
                  className="hidden sm:flex items-center justify-center w-9 h-9 rounded-lg border border-[var(--border-default)] hover:border-[var(--border-strong)] transition-colors shrink-0"
                  aria-label="تحديد كل الحسابات الظاهرة"
                >
                  <Checkbox
                    checked={allFilteredSelected ? true : someFilteredSelected ? 'indeterminate' : false}
                    onCheckedChange={toggleSelectAllFiltered}
                  />
                </button>
                </TooltipTrigger>
                <TooltipContent>تحديد الكل</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
          <div className="relative flex-1 sm:w-52">
            <Search className="absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--text-muted)]" />
            <input
              id="account-search"
              className="input pr-8 text-sm h-9"
              placeholder="بحث عن حساب..."
              aria-label="بحث عن حساب"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
          <Button size="sm" onClick={() => setIsAddOpen(true)}>
            <Plus className="w-3.5 h-3.5" />
            <span>إضافة</span>
          </Button>
        </div>
      </div>

      {/* ── شريط الإجراءات الجماعية (Bulk Actions) ──────────────────────── */}
      {bulkIds.size > 0 && (
        <div className="flex items-center justify-between gap-3 px-4 py-2.5 rounded-xl bg-[var(--brand-primary-light)] border border-[var(--brand-primary)]/25 animate-slide-up">
          <div className="flex items-center gap-2 text-sm font-medium text-[var(--brand-primary)]">
            <Check className="w-4 h-4" />
            <span>تم تحديد {bulkIds.size} حساب</span>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => bulkSetRunning(true)}
              disabled={bulkBusy !== null}
            >
              {bulkBusy === 'start' ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <PlayIcon className="w-3.5 h-3.5" />}
              <span>تشغيل</span>
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => bulkSetRunning(false)}
              disabled={bulkBusy !== null}
            >
              {bulkBusy === 'stop' ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <StopIcon className="w-3.5 h-3.5" />}
              <span>إيقاف</span>
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="text-[var(--danger)] hover:bg-[var(--danger-bg)]"
              onClick={() => {
                const ids = Array.from(bulkIds);
                const names = accounts.filter(a => ids.includes(a.id)).map(a => a.name);
                setDeleteTarget({ ids, names });
              }}
              disabled={bulkBusy !== null}
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>حذف</span>
            </Button>
            <Button size="sm" variant="ghost" onClick={clearBulk} aria-label="إلغاء التحديد">
              <X className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>
      )}

      {/* ── تبويبات الفلترة ──────────────────────────────────────────────── */}
      <div className="flex gap-1.5 overflow-x-auto pb-1 flex-wrap" role="tablist" aria-label="تصفية الحسابات حسب الدور">
        <button
          role="tab"
          aria-selected={filterRole === 'all'}
          onClick={() => setFilterRole('all')}
          className={cn(
            'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-all whitespace-nowrap',
            filterRole === 'all'
              ? 'bg-[var(--brand-primary)] text-[var(--text-on-brand)] border-[var(--brand-primary)]'
              : 'bg-[var(--bg-surface)] text-[var(--text-secondary)] border-[var(--border-default)] hover:border-[var(--border-strong)]'
          )}
        >
          <BarChart2 className="w-3 h-3" />
          <span>الكل</span>
        </button>
        {ROLES.map(r => {
          const RI = r.icon;
          const isActive = filterRole === r.id;
          return (
            <button
              key={r.id}
              role="tab"
              aria-selected={isActive}
              onClick={() => setFilterRole(r.id)}
              className={cn(
                'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-all whitespace-nowrap',
                isActive
                  ? 'bg-[var(--brand-primary)] text-[var(--text-on-brand)] border-[var(--brand-primary)]'
                  : 'bg-[var(--bg-surface)] text-[var(--text-secondary)] border-[var(--border-default)] hover:border-[var(--border-strong)]'
              )}
            >
              <RI className="w-3 h-3" />
              <span>{r.label}</span>
              <span className="opacity-60">({roleCount(r.id)})</span>
            </button>
          );
        })}
      </div>

      {/* ── قائمة الحسابات ──────────────────────────────────────────────── */}
      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1, 2, 3].map(i => <Skeleton key={i} className="h-56 w-full rounded-xl" />)}
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={Smartphone}
          title={filterRole === 'all' ? 'لا توجد حسابات' : `لا توجد حسابات بدور "${getRoleInfo(filterRole).label}"`}
          description={
            filterRole === 'all'
              ? 'أضف حساباً جديداً لتبدأ في النشر والإدارة.'
              : 'قم بتعيين هذا الدور لحساب موجود أو أضف حساباً جديداً.'
          }
          actionLabel={filterRole === 'all' ? 'إضافة حساب' : undefined}
          onAction={filterRole === 'all' ? () => setIsAddOpen(true) : undefined}
          className="flex-1 border-2 border-dashed border-[var(--border-default)] rounded-2xl"
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 overflow-y-auto pb-8">
          {filtered.map(account => (
            <AccountCard
              key={account.id}
              account={account}
              selected={selectedAccountId === account.id}
              onSelect={setSelectedAccountId}
              onConnect={handleConnect}
              onReset={handleReset}
              onDelete={handleDelete}
              onStart={handleStart}
              onStop={handleStop}
              onRestart={handleRestart}
              onRoleChange={handleRoleChange}
              onTest={handleTest}
              onViewLogs={handleViewLogs}
              bulkChecked={bulkIds.has(account.id)}
              onBulkToggle={toggleBulk}
            />
          ))}
        </div>
      )}

      {/* ── نافذة إضافة حساب ─────────────────────────────────────────────── */}
      <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>إضافة حساب واتساب جديد</DialogTitle>
          </DialogHeader>
          <div className="py-4 flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <label htmlFor="new-account-name" className="text-sm font-medium text-[var(--text-primary)]">
                اسم الحساب
              </label>
              <input
                id="new-account-name"
                className="input"
                placeholder="مثال: حساب النشر الأول"
                value={newName}
                onChange={e => setNewName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleAdd()}
              />
            </div>
            <div className="bg-[var(--bg-elevated)] rounded-lg p-3 text-xs text-[var(--text-muted)] border border-[var(--border-default)]">
              <p className="font-medium text-[var(--text-secondary)] mb-1">بعد الإضافة:</p>
              <p>• ستختار طريقة الربط بعد الإنشاء (QR / Pairing / Business API)</p>
              <p>• حدد دور الحساب (ناشر / باحث / منضم / مراقب)</p>
              <p>• اضغط تشغيل لبدء المهام التلقائية</p>
            </div>
            <Button
              onClick={handleAdd}
              disabled={!newName.trim()}
              className="w-full"
            >
              إنشاء ومتابعة
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── نافذة طرق الربط (QR / Pairing / Business API) ─────────────── */}
      {connectModal && (
        <ConnectionMethodModal
          accountId={connectModal.id}
          accountName={connectModal.name}
          open={!!connectModal}
          onClose={() => setConnectModal(null)}
          onConnected={() => {
            setConnectModal(null);
            fetchAccounts();
            fetchSummary();
          }}
          showToast={addToast}
        />
      )}

      {/* ── نافذة السجلات ────────────────────────────────────────────────── */}
      {logsModal && (
        <LogsModal
          accountId={logsModal.id}
          accountName={logsModal.name}
          onClose={() => setLogsModal(null)}
        />
      )}

      {/* ── نافذة تأكيد الحذف (فردي أو جماعي) ────────────────────────────── */}
      <Dialog open={!!deleteTarget} onOpenChange={(v) => !v && setDeleteTarget(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-[var(--danger)]">
              <AlertTriangle className="w-5 h-5" />
              {deleteTarget && deleteTarget.ids.length > 1
                ? `حذف ${deleteTarget.ids.length} حسابات`
                : 'حذف الحساب'}
            </DialogTitle>
            <DialogDescription>
              هذا الإجراء لا يمكن التراجع عنه. سيتم حذف جميع البيانات المرتبطة نهائياً.
            </DialogDescription>
          </DialogHeader>
          {deleteTarget && (
            <div className="max-h-40 overflow-y-auto flex flex-col gap-1.5 py-1">
              {deleteTarget.names.map((n, i) => (
                <div key={i} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--bg-elevated)] text-sm text-[var(--text-primary)]">
                  <Smartphone className="w-3.5 h-3.5 text-[var(--text-muted)] shrink-0" />
                  <span className="truncate">{n}</span>
                </div>
              ))}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>إلغاء</Button>
            <Button
              className="bg-[var(--danger)] hover:bg-[var(--danger)]/90 text-white"
              onClick={confirmDelete}
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>{deleteTarget && deleteTarget.ids.length > 1 ? 'حذف الكل' : 'حذف'}</span>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
