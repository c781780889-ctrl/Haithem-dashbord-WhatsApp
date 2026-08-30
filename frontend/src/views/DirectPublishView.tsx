import { useCallback, useEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import DirectPublishSection, { type DirectPublishConfig } from '@/components/DirectPublishSection';
import { API, authFetch, TOKEN_KEY } from '@/utils/api';
import { useToast } from '@/components/ui/ToastProvider';

type LinkItem = { id: string; canonical_url: string; last_status?: string; last_error?: string };
type Account = { id: string; name: string; phone_number?: string; status?: string; health_status?: string };
type Operation = { id: string; account_id: string; account_name: string; link_id: string; url: string; status: string; last_error?: string; attempt_count?: number };
type Dashboard = { task: any; operations: Operation[]; events: any[]; stats: Record<string, number>; progress: number };

export default function DirectPublishView() {
  const { addToast } = useToast();
  const socketRef = useRef<Socket | null>(null);
  const [links, setLinks] = useState<LinkItem[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedLinks, setSelectedLinks] = useState<Set<string>>(new Set());
  const [selectedAccounts, setSelectedAccounts] = useState<Set<string>>(new Set());
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dailyOperationLimit, setDailyOperationLimit] = useState(10);


  const load = useCallback(async () => {
    const [linksResponse, accountsResponse, settingsResponse] = await Promise.all([
      authFetch(`${API}/telegram/link-import/links`),
      authFetch(`${API}/accounts`),
      authFetch(`${API}/whatsapp/join-automation/settings`),
    ]);
    const linksData = await linksResponse.json();
    const accountsData = await accountsResponse.json();
    const settingsData = await settingsResponse.json();
    if (linksData.success) setLinks(linksData.links || []);
    if (accountsData.success) setAccounts(accountsData.accounts || []);
    if (settingsData.success) setDailyOperationLimit(Number(settingsData.settings?.daily_operation_limit || 10));
  }, []);

  const refreshDashboard = useCallback(async (id: string) => {
    const response = await authFetch(`${API}/telegram/link-import/tasks/${id}`);
    const data = await response.json();
    if (data.success) setDashboard(data);
  }, []);

  useEffect(() => {
    load().catch(() => addToast({ title: 'تعذر تحميل بيانات قسم الانضمام والنشر', type: 'error' }));
  }, [load, addToast]);

  useEffect(() => {
    const socket = io(window.location.origin, { path: '/socket.io', transports: ['websocket', 'polling'] });
    socketRef.current = socket;
    socket.on('connect', () => {
      const user = JSON.parse(localStorage.getItem('wa_user') || '{}');
      socket.emit('join_user', { userId: user.id, token: localStorage.getItem(TOKEN_KEY) || '' });
    });
    socket.on('link_import:event', (event: any) => {
      if (taskId && event.taskId === taskId) refreshDashboard(taskId);
    });
    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [taskId, refreshDashboard]);

  useEffect(() => {
    if (!taskId) return;
    const timer = window.setInterval(() => refreshDashboard(taskId), 5000);
    return () => window.clearInterval(timer);
  }, [taskId, refreshDashboard]);

  const toggleLink = (id: string) => setSelectedLinks(old => {
    const next = new Set(old);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  const toggleAccount = (id: string) => setSelectedAccounts(old => {
    const next = new Set(old);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  async function start(config: DirectPublishConfig) {
    if (!selectedLinks.size || !selectedAccounts.size || !config.adLibraryIds.length) {
      addToast({ title: 'اختر روابط وحسابات مؤهلة وإعلانًا فعالًا قبل التشغيل', type: 'error' });
      return;
    }
    setBusy(true);
    try {
      const response = await authFetch(`${API}/telegram/link-import/tasks`, {
        method: 'POST',
        body: JSON.stringify({
          linkIds: [...selectedLinks],
          accountIds: [...selectedAccounts],
          settings: {
            adLibraryIds: config.adLibraryIds,
            waitAfterJoinSeconds: config.waitAfterJoinSeconds,
            waitAfterPublishSeconds: config.waitAfterPublishSeconds,
            waitAfterLeaveSeconds: config.waitAfterLeaveSeconds,
            leaveEnabled: config.leaveEnabled,
            maxRetries: config.maxRetries,
            dailyOperationLimit,
            daily_operation_limit: dailyOperationLimit,
          },
        }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || 'تعذر إنشاء مهمة الانضمام');
      setTaskId(data.task.id);
      await refreshDashboard(data.task.id);
      addToast({ title: `تم إنشاء ${data.totalOperations} عملية مصرح بها`, type: 'success' });
    } catch (error: any) {
      addToast({ title: error.message, type: 'error' });
    } finally {
      setBusy(false);
    }
  }

  async function control(status: string) {
    if (!taskId) return;
    const response = await authFetch(`${API}/telegram/link-import/tasks/${taskId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    });
    const data = await response.json();
    if (!response.ok || !data.success) addToast({ title: data.error || 'تعذر تغيير حالة المهمة', type: 'error' });
    await refreshDashboard(taskId);
  }

  const readyAccounts = accounts.filter(account => account.status === 'connected' && !['protected', 'blocked'].includes(account.health_status || ''));

  return <div dir="rtl" className="space-y-6 pb-12">
    <DirectPublishSection
      links={links}
      accounts={accounts}
      selectedLinks={selectedLinks}
      selectedAccounts={selectedAccounts}
      dashboard={dashboard}
      taskId={taskId}
      busy={busy}
      onToggleLink={toggleLink}
      onToggleAccount={toggleAccount}
      onClearAccounts={() => setSelectedAccounts(new Set())}
      onLinksImported={load}
      onSelectLinks={() => setSelectedLinks(new Set(links.map(link => link.id)))}
      onSelectAccounts={() => setSelectedAccounts(new Set(readyAccounts.map(account => account.id)))}
      onStart={start}
      onControl={control}
      onReset={() => { setSelectedLinks(new Set()); setDashboard(null); setTaskId(null); }}
    />
  </div>;
}
