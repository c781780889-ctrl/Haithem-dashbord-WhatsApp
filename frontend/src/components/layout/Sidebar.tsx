import React from 'react';
import { NavLink } from 'react-router-dom';
import {
  LayoutDashboard, Users, Library, Calendar,
  Megaphone, LogOut, ChevronRight,
  UsersRound, BarChart3, Crown, Brain, Activity,
  MessageCircle, CreditCard, Monitor, SearchCheck, Link2, Send, Bot, ScrollText, Smartphone, Database
} from 'lucide-react';
import { cn } from '@/utils/cn';

interface SidebarProps {
  isCollapsed: boolean;
  setIsCollapsed: (v: boolean) => void;
  currentUser: any;
  onLogout: () => void;
  isConnected: boolean;
}

export function Sidebar({ isCollapsed, setIsCollapsed, currentUser, onLogout }: SidebarProps) {
  const isAdmin = ['super_admin', 'admin'].includes(currentUser?.role);

  const navItems = [
    {
      section: 'العام',
      items: [
        { to: '/', icon: LayoutDashboard, label: 'لوحة التحكم', exact: true },
        { to: '/accounts', icon: Users, label: 'الحسابات' },
      ]
    },
    {
      section: 'خاص واتس اب',
      special: true,
      items: [
        { to: '/private-whatsapp', icon: Smartphone, label: 'قسم خاص واتس اب' },
      ]
    },
    {
      section: 'النشر',
      items: [
        { to: '/ad-library',        icon: Library,   label: 'مكتبة الإعلانات'   },
        { to: '/schedules',         icon: Calendar,   label: 'النشر المجدول'     },
        { to: '/campaigns',         icon: Megaphone,  label: 'الحملات'           },
        { to: '/groups',            icon: UsersRound, label: 'المجموعات'         },
      ]
    },
    {
      section: 'الروابط',
      items: [
        { to: '/keywords',      icon: SearchCheck,  label: 'كلمات مفتاحية واتساب' },
        { to: '/link-import',   icon: Link2,         label: 'استيراد الروابط' },
        { to: '/direct-publish',   icon: Send,           label: 'الانضمام والنشر المباشر' },
        { to: '/whatsapp-join-automation',       icon: Bot,       label: 'أتمتة الانضمام لروابط واتساب' },
        { to: '/whatsapp-join-automation/audit', icon: ScrollText, label: 'سجل تدقيق واتساب' },
      ]
    },

    {
      section: 'الذكاء الاصطناعي',
      items: [
        { to: '/ai-automation', icon: Brain, label: 'مركز الذكاء والأتمتة' },
      ]
    },
    {
      section: 'التشخيص',
      items: [
        { to: '/diagnostics', icon: Activity, label: 'لوحة التشخيص' },
      ]
    },
  ];

  const adminItems = isAdmin ? [
    {
      section: 'الإدارة',
      admin: true,
      items: [
        { to: '/admin/stats',         icon: BarChart3,     label: 'الإحصائيات'   },
        { to: '/admin/subscriptions', icon: CreditCard,    label: 'الاشتراكات'   },
        { to: '/admin/subscriber-monitoring', icon: Monitor, label: 'مراقبة المشتركين' },
        { to: '/admin/postgres-storage', icon: Database, label: 'مساحة PostgreSQL' },
        { to: '/telegram',            icon: MessageCircle, label: 'تيليجرام'  },
        { to: '/telegram-keywords',    icon: SearchCheck,    label: 'كلمات مفتاحية تيليجرام' },
        { to: '/telegram-smart-conversations', icon: Brain,      label: 'المحادثات الذكية' },
        { to: '/join-automation',       icon: Bot,             label: 'أتمتة الانضمام لروابط تيليجرام' },
      ]
    }
  ] : [];

  const telegramUserItems = (!isAdmin && currentUser?.enableTelegram) ? [
    {
      section: 'التيلجرام التفاعلي',
      items: [
        { to: '/telegram', icon: MessageCircle, label: 'تيليجرام' },
        { to: '/telegram-keywords', icon: SearchCheck, label: 'كلمات مفتاحية تيليجرام' },
        { to: '/telegram-smart-conversations', icon: Brain, label: 'المحادثات الذكية' },
        { to: '/join-automation', icon: Bot, label: 'أتمتة الانضمام لروابط تيليجرام' },
      ]
    }
  ] : [];

  const allSections = [...navItems, ...telegramUserItems, ...adminItems];

  const roleLabels: Record<string, string> = { super_admin: 'Super Admin', admin: 'Admin', moderator: 'Moderator', user: 'User' };
  const roleColors: Record<string, string> = { super_admin: 'var(--warning-500)', admin: 'var(--brand-secondary-500)', moderator: 'var(--info-500)', user: 'var(--text-muted)' };
  const roleLabel = roleLabels[currentUser?.role] || 'User';
  const roleColor = roleColors[currentUser?.role] || 'var(--text-muted)';

  return (
    <aside
      className={cn(
        "flex flex-col bg-[var(--bg-sidebar)] border-l border-[var(--border-default)] transition-[width] duration-300 ease-[cubic-bezier(0.4,0,0.2,1)] z-10 relative",
        isCollapsed ? "w-20" : "w-64"
      )}
    >
      {/* Logo */}
      <div className="h-16 flex items-center justify-between px-4 border-b border-[var(--border-default)]">
        {!isCollapsed && (
          <div className="flex items-center gap-2.5 overflow-hidden">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[var(--brand-primary)] to-[var(--brand-secondary)] flex items-center justify-center text-white font-bold shadow-[var(--shadow-glow)] shrink-0">W</div>
            <span className="font-bold text-heading-s whitespace-nowrap truncate">هيثم العقلاني</span>
          </div>
        )}
        {isCollapsed && (
          <div className="w-full flex justify-center">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[var(--brand-primary)] to-[var(--brand-secondary)] flex items-center justify-center text-white font-bold">W</div>
          </div>
        )}
        <button
          onClick={() => setIsCollapsed(!isCollapsed)}
          aria-label="طي القائمة الجانبية"
          className={cn("p-1.5 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors", isCollapsed && "hidden")}>
          <ChevronRight className="w-5 h-5" />
        </button>
      </div>

      {/* Expand button when collapsed */}
      {isCollapsed && (
        <button
          onClick={() => setIsCollapsed(false)}
          aria-label="توسيع القائمة الجانبية"
          className="absolute -left-3 top-[3.25rem] w-6 h-6 rounded-full bg-[var(--bg-elevated)] border border-[var(--border-strong)] flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--brand-primary)] shadow-sm transition-colors"
        >
          <ChevronRight className="w-3.5 h-3.5 rotate-180" />
        </button>
      )}

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto py-4 px-3 flex flex-col gap-5" aria-label="التنقل الرئيسي">
        {allSections.map((section, idx) => (
          <div key={idx}>
            {!isCollapsed && (
              <h4 className={cn(
                "text-label mb-2 px-3 flex items-center gap-1.5",
                (section as any).special ? "text-cyan-300/80" : (section as any).admin ? "text-[var(--brand-primary)]/70" : "text-[var(--text-muted)]"
              )}>
                {(section as any).admin && <Crown className="w-3 h-3"/>}
                {section.section}
              </h4>
            )}
            <ul className="flex flex-col gap-1">
              {section.items.map((item, i) => (
                <li key={i}>
                  <NavLink
                    to={item.to}
                    end={(item as any).exact}
                    title={isCollapsed ? item.label : undefined}
                    aria-label={isCollapsed ? item.label : undefined}
                    className={({ isActive }) => cn(
                      "flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all duration-150 text-sm font-medium group relative",
                      isActive
                        ? ((section as any).special ? "bg-cyan-400 text-slate-950 shadow-[0_0_20px_rgba(34,211,238,0.22)]" : "bg-[var(--brand-primary)] text-white shadow-[var(--shadow-glow)]")
                        : "text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
                    )}
                  >
                    {({ isActive }) => (
                      <>
                        <item.icon className="w-5 h-5 shrink-0" aria-hidden="true" />
                        {!isCollapsed && <span className="truncate">{item.label}</span>}
                        {isActive && <span className="sr-only">(الصفحة الحالية)</span>}
                      </>
                    )}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>

      {/* User footer */}
      <div className="p-3 border-t border-[var(--border-default)]">
        {!isCollapsed ? (
          <div className="flex items-center gap-3 px-2 py-2">
            <div className="w-8 h-8 rounded-xl flex items-center justify-center font-bold text-sm text-white shrink-0"
              style={{ background: `color-mix(in srgb, ${roleColor} 25%, transparent)`, color: roleColor }}>
              {(currentUser?.username || 'U').charAt(0).toUpperCase()}
            </div>
            <div className="flex-1 overflow-hidden">
              <p className="text-sm font-semibold truncate text-primary">{currentUser?.username}</p>
              <p className="text-xs font-medium" style={{ color: roleColor }}>{roleLabel}</p>
            </div>
            <button onClick={onLogout} title="تسجيل الخروج" aria-label="تسجيل الخروج"
              className="p-1.5 rounded-lg text-[var(--text-muted)] hover:text-[var(--danger)] hover:bg-[var(--danger-bg)] transition-colors">
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        ) : (
          <button onClick={onLogout} title="تسجيل الخروج" aria-label="تسجيل الخروج"
            className="w-full flex justify-center p-2 text-[var(--text-muted)] hover:text-[var(--danger)] hover:bg-[var(--danger-bg)] rounded-xl transition-colors">
            <LogOut className="w-5 h-5" />
          </button>
        )}
      </div>
    </aside>
  );
}
