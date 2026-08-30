import React, { useState, useMemo } from 'react';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';
import { CommandPalette, type CommandItem } from '@/components/ui/command-palette';
import { usePageMotion } from '@/hooks/usePageMotion';
import {
  LayoutDashboard, Users, Library, Calendar, Megaphone,
  SearchCheck, Brain, Activity,
  BarChart3, CreditCard, Monitor, MessageCircle, Link2, Send, Bot, Smartphone,
} from 'lucide-react';

interface AppLayoutProps {
  children: React.ReactNode;
  accounts: any[];
  selectedAccountId: string | null;
  onAccountChange: (id: string | null) => void;
  currentUser: any;
  onLogout: () => void;
}

export function AppLayout({
  children,
  accounts,
  selectedAccountId,
  onAccountChange,
  currentUser,
  onLogout
}: AppLayoutProps) {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const motionRef = usePageMotion<HTMLDivElement>();

  const isAdmin = ['super_admin', 'admin'].includes(currentUser?.role);

  const commandItems: CommandItem[] = useMemo(() => {
    const base: CommandItem[] = [
      { id: 'home',       label: 'لوحة التحكم',        section: 'التنقل', icon: LayoutDashboard, to: '/' },
      { id: 'private-whatsapp', label: 'قسم خاص واتس اب', section: 'خاص واتس اب', icon: Smartphone, to: '/private-whatsapp' },
      { id: 'accounts',   label: 'الحسابات',            section: 'التنقل', icon: Users,           to: '/accounts' },
      { id: 'ads',        label: 'مكتبة الإعلانات',      section: 'النشر',  icon: Library,         to: '/ad-library' },
      { id: 'schedules',  label: 'النشر المجدول',        section: 'النشر',  icon: Calendar,        to: '/schedules' },
      { id: 'campaigns',  label: 'الحملات',              section: 'النشر',  icon: Megaphone,       to: '/campaigns' },
      { id: 'groups',     label: 'المجموعات',            section: 'النشر',  icon: Users,           to: '/groups' },
      { id: 'keywords',   label: 'الكلمات المفتاحية',    section: 'الروابط', icon: SearchCheck,     to: '/keywords' },
      { id: 'link-import',    label: 'استيراد الروابط',          section: 'الروابط', icon: Link2, to: '/link-import' },
      { id: 'direct-publish',  label: 'الانضمام والنشر المباشر', section: 'الروابط', icon: Send,  to: '/direct-publish' },
      { id: 'join-automation', label: 'أتمتة الانضمام', section: 'الروابط', icon: Bot, to: '/join-automation' },
      { id: 'join-automation-reports', label: 'تقارير أتمتة الانضمام', section: 'الروابط', icon: BarChart3, to: '/join-automation/reports' },
      { id: 'ai',         label: 'مركز الذكاء والأتمتة', section: 'الذكاء الاصطناعي', icon: Brain, to: '/ai-automation' },
      { id: 'diagnostics',label: 'لوحة التشخيص',         section: 'التشخيص', icon: Activity,        to: '/diagnostics' },
    ];
    if (isAdmin) {
      base.push(
        { id: 'admin-stats', label: 'الإحصائيات', section: 'الإدارة', icon: BarChart3, to: '/admin/stats' },
        { id: 'admin-subs',  label: 'الاشتراكات', section: 'الإدارة', icon: CreditCard, to: '/admin/subscriptions' },
        { id: 'admin-mon',   label: 'مراقبة المشتركين', section: 'الإدارة', icon: Monitor, to: '/admin/subscriber-monitoring' },
        { id: 'telegram',    label: 'تيليجرام', section: 'الإدارة', icon: MessageCircle, to: '/telegram' },
      );
    }
    return base;
  }, [isAdmin]);

  return (
    <div className="flex h-screen overflow-hidden bg-[var(--bg-app)] text-[var(--text-primary)]">
      <a href="#main-content" className="skip-link">تخطي إلى المحتوى الرئيسي</a>

      {/* Sidebar - RTL so it's on the right */}
      <Sidebar
        isCollapsed={isCollapsed}
        setIsCollapsed={setIsCollapsed}
        currentUser={currentUser}
        onLogout={onLogout}
        isConnected={accounts.some(a => a.id === selectedAccountId && a.status === 'connected')}
      />

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <TopBar
          accounts={accounts}
          selectedAccountId={selectedAccountId}
          onAccountChange={onAccountChange}
          currentUser={currentUser}
          onLogout={onLogout}
        />
        <main id="main-content" className="flex-1 overflow-auto p-6 scroll-smooth">
          <div ref={motionRef} className="max-w-7xl mx-auto w-full h-full">
            {children}
          </div>
        </main>
      </div>

      <CommandPalette items={commandItems} />
    </div>
  );
}
