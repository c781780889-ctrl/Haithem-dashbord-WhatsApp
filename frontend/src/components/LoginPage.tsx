import React, { useState } from 'react';
import { Eye, EyeOff, Loader2, Code2, Phone, Shield, Zap } from 'lucide-react';
import { API } from '../utils/api';
import { useToast } from './ui/ToastProvider';
import { Alert } from './ui/alert';
import { Checkbox } from './ui/checkbox';

interface LoginPageProps {
  onLogin: (accessToken: string, refreshToken: string, user: any) => void;
}

const REMEMBER_KEY = 'wa-dashboard-remember-username';

export default function LoginPage({ onLogin }: LoginPageProps) {
  const [username, setUsername] = useState(() => {
    try { return localStorage.getItem(REMEMBER_KEY) ?? ''; } catch { return ''; }
  });
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [rememberMe, setRememberMe] = useState(() => {
    try { return !!localStorage.getItem(REMEMBER_KEY); } catch { return false; }
  });
  const [formError, setFormError] = useState<string | null>(null);
  const { addToast } = useToast();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);

    if (!username || !password) {
      setFormError('الرجاء إدخال اسم المستخدم وكلمة المرور');
      return;
    }

    setLoading(true);
    try {
      const res = await fetch(`${API}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      const data = await res.json();

      if (res.ok && data.success) {
        try {
          if (rememberMe) localStorage.setItem(REMEMBER_KEY, username);
          else localStorage.removeItem(REMEMBER_KEY);
        } catch { /* localStorage may be unavailable, ignore safely */ }
        addToast({ title: 'مرحبًا بعودتك', description: 'تم تسجيل الدخول بنجاح', type: 'success' });
        onLogin(data.accessToken, data.refreshToken, data.user);
      } else {
        setFormError(data.error || 'بيانات الاعتماد غير صحيحة');
      }
    } catch (err) {
      setFormError('تعذر الاتصال بالخادم، الرجاء المحاولة مجددًا');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-[var(--bg-app)] relative overflow-hidden dir-ltr">
      {/* Animated Grid Background */}
      <div className="absolute inset-0 z-0 bg-[radial-gradient(rgba(255,255,255,0.05)_1px,transparent_1px)] [background-size:24px_24px] opacity-20 animate-[pulse-dot_4s_ease-in-out_infinite]" />
      
      {/* Glow Effects */}
      <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-[var(--brand-primary)]/20 rounded-full blur-[120px] pointer-events-none mix-blend-screen" />
      <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-[var(--brand-secondary)]/10 rounded-full blur-[120px] pointer-events-none mix-blend-screen" />

      <div className="w-full max-w-md p-8 relative z-10 animate-scale-in" dir="rtl">
        {/* Logo & Title */}
        <div className="flex flex-col items-center mb-8">
          <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-[var(--brand-primary)] to-[var(--brand-secondary)] flex items-center justify-center text-white font-bold text-3xl mb-6 shadow-[var(--shadow-glow)]">
            W
          </div>
          <h1 className="text-2xl font-bold text-[var(--text-primary)]">هيثم العقلاني</h1>
          <div className="flex items-center gap-2 mt-2 px-3 py-1 rounded-full bg-[var(--bg-elevated)] border border-[var(--border-default)]">
            <Shield className="w-3 h-3 text-[var(--brand-primary)]" />
            <p className="text-xs text-[var(--text-muted)]">نظام إدارة متكامل وآمن</p>
          </div>
        </div>

        {/* Login Form */}
        <form onSubmit={handleSubmit} className="bg-[var(--bg-surface)] border border-[var(--border-default)] p-8 rounded-3xl shadow-[var(--shadow-elevated)] flex flex-col gap-5 relative overflow-hidden">
          {/* subtle top border highlight */}
          <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-[var(--brand-primary)] to-transparent opacity-50" />

          {formError && (
            <Alert variant="danger" onDismiss={() => setFormError(null)}>
              {formError}
            </Alert>
          )}

          <div className="flex flex-col gap-1.5">
            <label htmlFor="login-username" className="text-sm font-medium text-[var(--text-secondary)]">اسم المستخدم</label>
            <input 
              id="login-username"
              type="text" 
              value={username}
              onChange={e => setUsername(e.target.value)}
              className="input dir-ltr text-left font-mono"
              placeholder="admin"
              disabled={loading}
              autoComplete="username"
              autoFocus
            />
          </div>

          <div className="flex flex-col gap-1.5 relative">
            <label htmlFor="login-password" className="text-sm font-medium text-[var(--text-secondary)]">كلمة المرور</label>
            <div className="relative">
              <input 
                id="login-password"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={e => setPassword(e.target.value)}
                className="input dir-ltr text-left font-mono pr-10"
                placeholder="••••••••"
                disabled={loading}
                autoComplete="current-password"
              />
              <button 
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                aria-label={showPassword ? 'إخفاء كلمة المرور' : 'إظهار كلمة المرور'}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--border-focus)] rounded-md"
              >
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          <label className="flex items-center gap-2.5 cursor-pointer select-none -mt-1">
            <Checkbox
              checked={rememberMe}
              onCheckedChange={setRememberMe}
              disabled={loading}
              aria-label="تذكرني"
            />
            <span className="text-sm text-[var(--text-secondary)]">تذكر اسم المستخدم</span>
          </label>

          <button 
            type="submit" 
            disabled={loading}
            className="mt-3 h-12 rounded-xl font-bold text-white bg-gradient-to-r from-[var(--brand-primary)] to-[#008f6e] hover:brightness-110 active:scale-[0.98] transition-all flex items-center justify-center gap-2 shadow-[var(--shadow-glow)] disabled:opacity-70 disabled:pointer-events-none"
          >
            {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : 'تسجيل الدخول'}
          </button>
        </form>

        {/* ─── Developer Attribution Card ─── */}
        <div className="mt-5">
          <div className="relative bg-[var(--bg-surface)] border border-[var(--border-default)] rounded-2xl px-5 py-4 overflow-hidden hover:border-[var(--brand-primary)]/40 transition-all duration-300 group">
            
            {/* animated top gradient line */}
            <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-[var(--brand-primary)] to-transparent opacity-60" />
            {/* subtle bottom glow */}
            <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-1/2 h-px bg-gradient-to-r from-transparent via-[var(--brand-primary)]/30 to-transparent" />

            <div className="flex items-center justify-between">
              {/* Developer info */}
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-[var(--brand-primary)]/20 to-[var(--brand-secondary)]/10 border border-[var(--brand-primary)]/25 flex items-center justify-center flex-shrink-0 group-hover:border-[var(--brand-primary)]/50 transition-colors">
                  <Code2 className="w-5 h-5 text-[var(--brand-primary)]" />
                </div>
                <div className="flex flex-col leading-tight">
                  <span className="text-[10px] font-semibold text-[var(--text-muted)] tracking-widest uppercase">برمجة وإعداد</span>
                  <span className="text-sm font-bold text-[var(--text-primary)]">م/ هيثم العقلاني</span>
                </div>
              </div>

              {/* Phone contact */}
              <a
                href="tel:+967781780889"
                className="flex items-center gap-2 px-3.5 py-2 rounded-xl bg-[var(--brand-primary)]/10 border border-[var(--brand-primary)]/20 hover:bg-[var(--brand-primary)]/20 hover:border-[var(--brand-primary)]/45 hover:shadow-[0_0_12px_rgba(0,168,132,0.15)] transition-all duration-200"
              >
                <Phone className="w-3.5 h-3.5 text-[var(--brand-primary)]" />
                <span className="text-[13px] font-mono font-bold text-[var(--brand-primary)] tracking-wide dir-ltr">
                  +967781780889
                </span>
              </a>
            </div>

            {/* bottom row: system badge */}
            <div className="mt-3 pt-3 border-t border-[var(--border-default)] flex items-center gap-2">
              <Zap className="w-3 h-3 text-[var(--brand-primary)]" />
              <span className="text-[11px] text-[var(--text-muted)]">
                هيثم العقلاني · نظام إدارة متقدم للأعمال
              </span>
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}
