import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, CardContent } from '@/components/ui/card';
import { StatCard } from '@/components/ui/stat-card';
import { Badge } from '@/components/ui/badge';
import { SkeletonCard, Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import {
  Users, Send, Megaphone, Link as LinkIcon, Calendar,
  Code2, Phone, UsersRound, Plus, ArrowLeft, RefreshCw, AlertTriangle,
} from 'lucide-react';
import { authFetch, API } from '@/utils/api';
import SubscriptionStatusCard from '../components/SubscriptionStatusCard';

interface AccountStats {
  groups: number;
  activeAds: number;
  messagesSent: number;
  activeSchedules: number;
  extractedLinks: number;
  role?: string;
}

export default function DashboardHome({ accounts = [] }: { accounts?: any[] }) {
  const navigate = useNavigate();

  const [selectedId, setSelectedId] = useState<string | null>(
    () => localStorage.getItem('wa_selected_account') || null
  );
  const [stats, setStats] = useState<AccountStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ─── Keep selection in sync with the account switcher ───────────────────
  useEffect(() => {
    function onStorage() {
      setSelectedId(localStorage.getItem('wa_selected_account') || null);
    }
    window.addEventListener('storage', onStorage);
    const interval = setInterval(() => {
      const current = localStorage.getItem('wa_selected_account') || null;
      setSelectedId(prev => (prev === current ? prev : current));
    }, 1000);
    return () => { window.removeEventListener('storage', onStorage); clearInterval(interval); };
  }, []);

  const effectiveId = selectedId || accounts[0]?.id || null;
  const selectedAccount = accounts.find(a => a.id === effectiveId);

  const loadStats = useCallback(async (accountId: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await authFetch(`${API}/accounts/${accountId}/stats`);
      if (!res.ok) throw new Error('تعذر جلب إحصائيات الحساب');
      const data = await res.json();
      if (data?.success && data.stats) {
        setStats(data.stats);
      } else {
        throw new Error(data?.error || 'استجابة غير متوقعة من الخادم');
      }
    } catch (e: any) {
      setError(e.message || 'حدث خطأ أثناء جلب البيانات');
      setStats(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (effectiveId) loadStats(effectiveId);
    else { setStats(null); setError(null); }
  }, [effectiveId, loadStats]);

  const statCards = stats ? [
    { title: 'المجموعات',       value: stats.groups.toLocaleString('ar'),          icon: UsersRound, color: 'var(--info-500)' },
    { title: 'الإعلانات النشطة', value: stats.activeAds.toLocaleString('ar'),       icon: Megaphone,  color: 'var(--brand-secondary-500)' },
    { title: 'الرسائل المُرسلة', value: stats.messagesSent.toLocaleString('ar'),    icon: Send,       color: 'var(--success-500)' },
    { title: 'الروابط المستخرجة',value: stats.extractedLinks.toLocaleString('ar'),  icon: LinkIcon,   color: 'var(--warning-500)' },
  ] : [];

  return (
    <div className="flex flex-col gap-6 animate-fade-in">

      {/* ─── Subscription Status Card ─── */}
      <SubscriptionStatusCard />

      {/* ─── Developer Attribution Banner ─── */}
      <div className="relative flex items-center justify-between px-5 py-4 rounded-2xl overflow-hidden border border-[var(--border-default)] hover:border-[var(--brand-primary)]/40 transition-all duration-300 group bg-gradient-to-l from-[var(--brand-primary)]/6 via-[var(--bg-surface)] to-[var(--bg-surface)]">
        <div className="absolute right-0 top-0 h-full w-1 bg-gradient-to-b from-[var(--brand-primary)] to-[var(--brand-secondary)] rounded-l-full opacity-80" />
        <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-[var(--brand-primary)]/40 to-transparent" />

        <div className="flex items-center gap-4">
          <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-[var(--brand-primary)]/20 to-[var(--brand-secondary)]/10 border border-[var(--brand-primary)]/25 flex items-center justify-center flex-shrink-0 shadow-[0_0_12px_rgba(0,168,132,0.1)] group-hover:shadow-[0_0_16px_rgba(0,168,132,0.2)] transition-shadow">
            <Code2 className="w-5 h-5 text-[var(--brand-primary)]" />
          </div>
          <div className="flex flex-col leading-tight">
            <span className="text-label text-muted">برمجة وإعداد</span>
            <span className="text-heading-s text-primary">م/ هيثم العقلاني</span>
          </div>
        </div>

        <a
          href="tel:+967781780889"
          className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-[var(--brand-primary)]/10 border border-[var(--brand-primary)]/20 hover:bg-[var(--brand-primary)]/20 hover:border-[var(--brand-primary)]/45 hover:shadow-[0_0_14px_rgba(0,168,132,0.18)] transition-all duration-200"
        >
          <Phone className="w-4 h-4 text-[var(--brand-primary)]" />
          <span className="text-sm font-mono font-bold text-[var(--brand-primary)] tracking-wide dir-ltr">
            +967781780889
          </span>
        </a>
      </div>

      {/* ─── Page Header ─── */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-heading-xl text-primary">مرحباً بك في لوحة التحكم</h1>
          <p className="text-secondary mt-1 text-body-m">
            {selectedAccount ? `نظرة عامة على أداء حساب "${selectedAccount.name}"` : 'نظرة عامة على أداء حساباتك وحملاتك'}
          </p>
        </div>
        {selectedAccount && (
          <Badge variant={selectedAccount.status === 'connected' ? 'success' : 'danger'} dot className="px-3 py-1.5 text-sm">
            {selectedAccount.status === 'connected' ? 'الحساب متصل' : 'الحساب غير متصل'}
          </Badge>
        )}
      </div>

      {/* ─── No accounts at all: real empty state ─── */}
      {accounts.length === 0 && (
        <Card>
          <CardContent className="p-0">
            <EmptyState
              icon={Users}
              title="لا توجد حسابات مضافة بعد"
              description="أضف حساب واتساب أول لتبدأ برؤية إحصائيات المجموعات، الرسائل، والحملات هنا."
              actionLabel="إضافة حساب جديد"
              onAction={() => navigate('/accounts')}
            />
          </CardContent>
        </Card>
      )}

      {/* ─── Has accounts but stats failed to load ─── */}
      {accounts.length > 0 && error && !loading && (
        <Card>
          <CardContent className="p-0">
            <EmptyState
              icon={AlertTriangle}
              variant="error"
              title="تعذر تحميل الإحصائيات"
              description={error}
              actionLabel="إعادة المحاولة"
              onAction={() => effectiveId && loadStats(effectiveId)}
            />
          </CardContent>
        </Card>
      )}

      {/* ─── Stats Grid: loading skeleton / real data ─── */}
      {accounts.length > 0 && !error && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4 stagger-children">
          {loading ? (
            Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={i} />)
          ) : (
            statCards.map((stat, i) => (
              <div key={i} className="animate-slide-up" style={{ animationDelay: `${i * 50}ms` }}>
                <StatCard {...stat} />
              </div>
            ))
          )}
        </div>
      )}

      {/* ─── Groups / Schedules summary + Quick Actions ─── */}
      {accounts.length > 0 && !error && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Card>
            <CardContent className="p-6">
              <h3 className="text-heading-s text-primary mb-6">ملخص النشر</h3>
              {loading ? (
                <div className="flex flex-col gap-4">
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="h-4 w-1/2" />
                </div>
              ) : stats ? (
                <div className="flex flex-col gap-5">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-lg bg-[var(--info-bg)] flex items-center justify-center text-[var(--info-500)]">
                        <Calendar className="w-4.5 h-4.5" />
                      </div>
                      <span className="text-sm text-secondary">الجداول النشطة حالياً</span>
                    </div>
                    <span className="text-lg font-bold text-primary">{stats.activeSchedules.toLocaleString('ar')}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-lg bg-[var(--success-bg)] flex items-center justify-center text-[var(--success-500)]">
                        <UsersRound className="w-4.5 h-4.5" />
                      </div>
                      <span className="text-sm text-secondary">إجمالي المجموعات المرتبطة</span>
                    </div>
                    <span className="text-lg font-bold text-primary">{stats.groups.toLocaleString('ar')}</span>
                  </div>
                  {stats.groups === 0 && (
                    <p className="text-xs text-muted bg-[var(--bg-elevated)] rounded-lg px-3 py-2">
                      لا توجد مجموعات مرتبطة بهذا الحساب بعد. اذهب إلى صفحة المجموعات للمزامنة من واتساب.
                    </p>
                  )}
                </div>
              ) : (
                <p className="text-sm text-muted">لا توجد بيانات لعرضها.</p>
              )}
            </CardContent>
          </Card>

          <div className="flex flex-col gap-4">
            <Card
              className="bg-gradient-to-br from-[rgba(0,168,132,0.1)] to-transparent border-[var(--brand-primary-light)] hover:border-[var(--brand-primary)] group cursor-pointer"
              onClick={() => navigate('/campaigns')}
            >
              <CardContent className="p-6 flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 rounded-xl bg-[var(--brand-primary)] flex items-center justify-center text-white shadow-[var(--shadow-glow)]">
                    <Send className="w-6 h-6" />
                  </div>
                  <div>
                    <h3 className="font-bold text-heading-s text-primary group-hover:text-[var(--brand-primary)] transition-colors">إنشاء حملة</h3>
                    <p className="text-sm text-secondary">إرسال رسالة فورية أو مجدولة للمجموعات</p>
                  </div>
                </div>
                <ArrowLeft className="w-5 h-5 text-[var(--text-muted)] icon-directional group-hover:text-[var(--brand-primary)] group-hover:-translate-x-1 transition-all" />
              </CardContent>
            </Card>
            <Card
              className="hover:border-[var(--brand-secondary)] group cursor-pointer"
              onClick={() => navigate('/schedules')}
            >
              <CardContent className="p-6 flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 rounded-xl bg-[var(--bg-elevated)] border border-[var(--border-strong)] flex items-center justify-center text-[var(--brand-secondary)]">
                    <Calendar className="w-6 h-6" />
                  </div>
                  <div>
                    <h3 className="font-bold text-heading-s text-primary">جدولة نشر</h3>
                    <p className="text-sm text-secondary">إعداد نشر تلقائي حسب دورة زمنية</p>
                  </div>
                </div>
                <ArrowLeft className="w-5 h-5 text-[var(--text-muted)] icon-directional group-hover:text-[var(--brand-secondary)] group-hover:-translate-x-1 transition-all" />
              </CardContent>
            </Card>
            <Card
              className="hover:border-[var(--border-strong)] group cursor-pointer"
              onClick={() => navigate('/accounts')}
            >
              <CardContent className="p-6 flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 rounded-xl bg-[var(--bg-elevated)] border border-[var(--border-strong)] flex items-center justify-center text-[var(--text-muted)]">
                    <Plus className="w-6 h-6" />
                  </div>
                  <div>
                    <h3 className="font-bold text-heading-s text-primary">إضافة حساب</h3>
                    <p className="text-sm text-secondary">ربط رقم واتساب جديد بالنظام</p>
                  </div>
                </div>
                <ArrowLeft className="w-5 h-5 text-[var(--text-muted)] icon-directional group-hover:-translate-x-1 transition-all" />
              </CardContent>
            </Card>
          </div>
        </div>
      )}

      {/* ─── Manual refresh ─── */}
      {accounts.length > 0 && effectiveId && !loading && (
        <button
          onClick={() => loadStats(effectiveId)}
          className="self-start flex items-center gap-2 text-xs text-muted hover:text-primary transition-colors"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          تحديث الإحصائيات
        </button>
      )}

    </div>
  );
}
