import React, { useState, useEffect, useCallback, Suspense, lazy } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { ToastProvider } from './components/ui/ToastProvider';
import LoginPage from './components/LoginPage';
import { AppLayout } from './components/layout/AppLayout';
import { SkeletonCard } from './components/ui/skeleton';

// Views
// DashboardHome loads eagerly — it's the first screen shown after login,
// so lazy-loading it would only add a network waterfall with no benefit.
import DashboardHome from './views/DashboardHome';

// All other views are code-split (Performance Pass — Stage 5): each route's
// JS is fetched only when the user navigates to it, shrinking the initial
// bundle instead of shipping all 14 admin/feature screens up front.
const AccountsView              = lazy(() => import('./views/AccountsView'));
const CampaignsView             = lazy(() => import('./views/CampaignsView'));
const GroupsView                = lazy(() => import('./views/GroupsView'));
const ScheduleDashboardView     = lazy(() => import('./views/ScheduleDashboardView'));
const AdLibraryView             = lazy(() => import('./views/AdLibraryView'));
const AIAutomationView          = lazy(() => import('./views/AIAutomationView'));
const KeywordMonitoringView     = lazy(() => import('./views/KeywordMonitoringView'));
const LinkImportView             = lazy(() => import('./views/LinkImportView'));
const DirectPublishView          = lazy(() => import('./views/DirectPublishView'));
const JoinAutomationView         = lazy(() => import('./views/JoinAutomationView'));
const WhatsAppJoinAutomationView = lazy(() => import('./views/WhatsAppJoinAutomationView'));
const WhatsAppAuditLogsView       = lazy(() => import('./views/WhatsAppAuditLogsView'));
const PrivateWhatsAppView         = lazy(() => import('./views/PrivateWhatsAppView'));
const PrivateWhatsAppPublishingView = lazy(() => import('./views/PrivateWhatsAppPublishingView'));
const PrivateWhatsAppSettingsView = lazy(() => import('./views/PrivateWhatsAppSettingsView'));
const JoinAutomationReportsView = lazy(() => import('./views/JoinAutomationReportsView'));
// Admin views
const DiagnosticsDashboardView  = lazy(() => import('./views/DiagnosticsDashboardView'));
const TelegramView              = lazy(() => import('./views/TelegramView'));
const TelegramKeywordView       = lazy(() => import('./views/TelegramKeywordView'));
const TelegramSmartConversationsView = lazy(() => import('./views/TelegramSmartConversationsView'));
const AdminStatsView            = lazy(() => import('./views/AdminStatsView'));
const SubscriptionsView         = lazy(() => import('./views/SubscriptionsView'));
const SubscriberMonitoringView  = lazy(() => import('./views/SubscriberMonitoringView'));
const PostgresStorageView        = lazy(() => import('./views/PostgresStorageView'));

import { ErrorBoundary } from './components/ErrorBoundary';
import {
  API, TOKEN_KEY, REFRESH_TOKEN_KEY, USER_KEY,
  saveTokens, clearTokens, authFetch,
} from './utils/api';

/** Route-level fallback while a lazy view's chunk downloads. Uses the
 *  existing Skeleton system (motion.csv preset #15) so it feels native
 *  to the rest of the loading-state language instead of a bare spinner. */
function RouteLoadingFallback() {
  return (
    <div role="status" aria-live="polite" aria-busy="true" className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      <span className="sr-only">جاري التحميل…</span>
      {Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={i} />)}
    </div>
  );
}



function ProtectedRoute({ children, adminOnly = false, currentUser }:
  { children: React.ReactNode; adminOnly?: boolean; currentUser: any }) {
  if (adminOnly && !['super_admin', 'admin'].includes(currentUser?.role)) {
    return <Navigate to="/" replace />;
  }
  return <>{children}</>;
}

function AppInner() {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(TOKEN_KEY) || null);
  const [currentUser, setCurrentUser] = useState<any>(() => {
    try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null') || null; } catch { return null; }
  });
  const [isConnected, setIsConnected] = useState(true);

  // ── Account state lifted here to satisfy AppLayout + AccountsView ──────────
  const [accounts, setAccounts] = useState<any[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(false);
  // ── FIX: Persist selectedAccountId to localStorage so page refresh doesn't
  //         cause the null → real-id transition that triggers hooks violations.
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(() => {
    return localStorage.getItem('wa_selected_account') || null;
  });

  const handleAccountChange = useCallback((id: string | null) => {
    if (id) {
      localStorage.setItem('wa_selected_account', id);
    } else {
      localStorage.removeItem('wa_selected_account');
    }
    setSelectedAccountId(id);
  }, []);

  // ── FIX 1: Race condition — cancel stale verify fetches with cleanup flag ──
  useEffect(() => {
    // بدون تسجيل دخول — تجاهل التحقق من التوكن
    if (!token) return;
    let cancelled = false;
    const controller = new AbortController();

    fetch(`${API}/auth/verify`, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal })
      .then(r => {
        if (cancelled) return null;
        if (r.status === 401) { handleLogout(); return null; }
        return r.json();
      })
      .then(d => {
        if (!d || cancelled) return;
        if (!d.success) { setIsConnected(false); return; }
        const merged = { ...currentUser, ...d.user };
        setCurrentUser(merged);
        localStorage.setItem(USER_KEY, JSON.stringify(merged));

        // جلب حالة تيلجرام للمشتركين العاديين
        if (!['super_admin', 'admin'].includes(d.user?.role)) {
          fetch(`${API}/subscription/me`, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal })
            .then(r2 => r2.json())
            .then(s => {
              if (cancelled || !s.success) return;
              const withTg = { ...merged, enableTelegram: s.subscription?.enableTelegram === true };
              setCurrentUser(withTg);
              localStorage.setItem(USER_KEY, JSON.stringify(withTg));
            })
            .catch(() => {});
        }
      })
      .catch(error => {
        if (!cancelled && error?.name !== 'AbortError') setIsConnected(false);
      });

    return () => { cancelled = true; controller.abort(); };
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── FIX 2: Fetch accounts so AppLayout/TopBar get the data they need ───────
  const fetchAccounts = useCallback(async (signal?: AbortSignal) => {
    if (!token || signal?.aborted) return;
    setAccountsLoading(true);
    try {
      const res  = await authFetch(`${API}/accounts`, { signal });
      const data = await res.json();
      if (data.success) {
        const list: any[] = data.accounts ?? [];
        setAccounts(list);
        // Restore saved account OR auto-select first account
        setSelectedAccountId(prev => {
          const saved = localStorage.getItem('wa_selected_account');
          if (saved && list.some((a: any) => a.id === saved)) return saved;
          if (prev && list.some((a: any) => a.id === prev)) return prev;
          const first = list.length > 0 ? list[0].id : null;
          if (first) localStorage.setItem('wa_selected_account', first);
          return first;
        });
      }
    } catch (error: any) {
      // إلغاء الطلب عند تغيير الجلسة أو تفكيك المكوّن ليس خطأً للمستخدم.
      if (error?.name !== 'AbortError') { /* network error — silent */ }
    } finally {
      if (!signal?.aborted) setAccountsLoading(false);
    }
  }, [token]);

  useEffect(() => {
    if (!token || !currentUser) return;
    const controller = new AbortController();
    fetchAccounts(controller.signal);
    return () => controller.abort();
  }, [token, currentUser?.id, fetchAccounts]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Account status polling every 30s — keeps TopBar indicator live ────────
  useEffect(() => {
    if (!token || !currentUser) return;
    const controller = new AbortController();
    let requestInFlight = false;
    const refresh = async () => {
      if (requestInFlight || controller.signal.aborted) return;
      requestInFlight = true;
      try {
        const response = await authFetch(`${API}/accounts`, { signal: controller.signal });
        const data = await response.json();
        if (data.success && !controller.signal.aborted) setAccounts(data.accounts ?? []);
      } catch (error: any) {
        if (error?.name !== 'AbortError') { /* silent background refresh */ }
      } finally { requestInFlight = false; }
    };
    const id = window.setInterval(refresh, 30_000);
    return () => { controller.abort(); window.clearInterval(id); };
  }, [token, currentUser?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  function handleLogin(accessToken: string, refreshToken: string, user: any) {
    saveTokens(accessToken, refreshToken);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
    setToken(accessToken);
    setCurrentUser(user);
  }

  function handleLogout() {
    const refreshToken = localStorage.getItem(REFRESH_TOKEN_KEY);
    if (token) {
      fetch(`${API}/auth/logout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      }).catch(() => {});
    }
    clearTokens();
    localStorage.removeItem('wa_selected_account');
    setToken(null);
    setCurrentUser(null);
    setAccounts([]);
    setSelectedAccountId(null);
  }

  // تسجيل الدخول مطلوب — بيانات: admin / 7817808899
  if (!token || !currentUser) {
    return <LoginPage onLogin={handleLogin} />;
  }

  return (
    // FIX 2: All required AppLayout props now provided
    <AppLayout
      currentUser={currentUser}
      onLogout={handleLogout}
      accounts={accounts}
      selectedAccountId={selectedAccountId}
      onAccountChange={handleAccountChange}
    >
      <ErrorBoundary>
        <Suspense fallback={<RouteLoadingFallback />}>
        <Routes>
          {/* FIX 3: accounts prop passed to DashboardHome */}
          <Route path="/"               element={<DashboardHome accounts={accounts} />} />
          <Route path="/accounts"       element={
            <AccountsView
              accounts={accounts}
              loading={accountsLoading}
              fetchAccounts={fetchAccounts}
              selectedAccountId={selectedAccountId}
              setSelectedAccountId={handleAccountChange}
            />
          } />
          <Route path="/campaigns"      element={<CampaignsView      accountId={selectedAccountId} />} />

          <Route path="/groups"         element={<GroupsView          accountId={selectedAccountId} />} />
          <Route path="/schedules"      element={<ScheduleDashboardView accountId={selectedAccountId} accounts={accounts} />} />
          <Route path="/ad-library"     element={<AdLibraryView        accountId={selectedAccountId} />} />
          <Route path="/ai-automation" element={<AIAutomationView />} />
          <Route path="/keywords"      element={<KeywordMonitoringView userId={currentUser.id} />} />
          <Route path="/link-import"   element={<LinkImportView />} />
          <Route path="/direct-publish" element={<DirectPublishView />} />
          <Route path="/join-automation" element={<JoinAutomationView />} />
          <Route path="/whatsapp-join-automation" element={<WhatsAppJoinAutomationView />} />
          <Route path="/private-whatsapp" element={<PrivateWhatsAppView accounts={accounts} />} />
          <Route path="/private-whatsapp/publishing" element={<PrivateWhatsAppPublishingView />} />
          <Route path="/private-whatsapp/settings" element={<PrivateWhatsAppSettingsView />} />
          <Route path="/whatsapp-join-automation/audit" element={<WhatsAppAuditLogsView />} />
          <Route path="/join-automation/reports" element={<JoinAutomationReportsView />} />
          <Route path="/diagnostics"   element={<DiagnosticsDashboardView accountId={selectedAccountId} />} />

          {/* Admin-only routes */}
          <Route path="/admin/stats"   element={
            <ProtectedRoute adminOnly currentUser={currentUser}>
              <AdminStatsView />
            </ProtectedRoute>} />
          <Route path="/admin/subscriptions" element={
            <ProtectedRoute adminOnly currentUser={currentUser}>
              <SubscriptionsView />
            </ProtectedRoute>} />
          <Route path="/admin/postgres-storage" element={
            <ProtectedRoute adminOnly currentUser={currentUser}>
              <PostgresStorageView />
            </ProtectedRoute>} />
          <Route path="/admin/subscriber-monitoring" element={
            <ProtectedRoute adminOnly currentUser={currentUser}>
              <SubscriberMonitoringView />
            </ProtectedRoute>} />
          <Route path="/telegram"        element={<TelegramView />} />
          <Route path="/telegram-keywords" element={<TelegramKeywordView userId={currentUser.id} />} />
          <Route path="/telegram-smart-conversations" element={<TelegramSmartConversationsView userId={currentUser.id} />} />

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        </Suspense>
      </ErrorBoundary>
    </AppLayout>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <BrowserRouter>
        <AppInner />
      </BrowserRouter>
    </ToastProvider>
  );
}

