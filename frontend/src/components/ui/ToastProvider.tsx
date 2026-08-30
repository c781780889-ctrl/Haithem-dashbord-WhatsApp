import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { CheckCircle2, XCircle, AlertCircle, Info, X } from 'lucide-react';
import { cn } from '@/utils/cn';

export interface Toast {
  id: string;
  title: string;
  description?: string;
  type: 'success' | 'error' | 'warning' | 'info';
}

interface ToastContextType {
  addToast: (t: Omit<Toast, 'id'>) => void;
  removeToast: (id: string) => void;
}

const ToastContext = createContext<ToastContextType | undefined>(undefined);

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used within ToastProvider');
  return context;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const addToast = useCallback((t: Omit<Toast, 'id'>) => {
    if (!t || typeof t !== 'object') return;
    const title = typeof t.title === 'string' ? t.title.trim() : '';
    const description = typeof t.description === 'string' ? t.description.trim() : '';
    const validTypes = new Set<Toast['type']>(['success', 'error', 'warning', 'info']);
    if ((!title && !description) || !validTypes.has(t.type)) return;
    const id = Math.random().toString(36).substring(2, 9);
    setToasts(prev => [...prev.slice(-3), { ...t, title, description: description || undefined, id }]);
  }, []);

  const removeToast = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ addToast, removeToast }}>
      {children}
      {/* FIX: bottom-center أوضح على الموبايل من top-left */}
      <div className="fixed bottom-6 inset-x-0 mx-auto z-[100] flex flex-col gap-3 w-[calc(100%-2rem)] max-w-sm pointer-events-none">
        {toasts.map(toast => (
          <ToastItem key={toast.id} toast={toast} onRemove={() => removeToast(toast.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastItem({ toast, onRemove }: { toast: Toast; onRemove: () => void }) {
  useEffect(() => {
    // FIX: رسائل الخطأ تبقى أطول حتى تُرى على الموبايل
    const duration = toast.type === 'error' ? 7000 : toast.type === 'warning' ? 6000 : 4000;
    const timer = setTimeout(onRemove, duration);
    return () => clearTimeout(timer);
  }, [onRemove, toast.type]);

  const icons = {
    success: <CheckCircle2 className="w-5 h-5" style={{ color: 'var(--success)' }} />,
    error: <XCircle className="w-5 h-5" style={{ color: 'var(--danger)' }} />,
    warning: <AlertCircle className="w-5 h-5" style={{ color: 'var(--warning)' }} />,
    info: <Info className="w-5 h-5" style={{ color: 'var(--info)' }} />
  };

  const bgs = {
    success: 'border-[color:rgba(34,197,94,0.25)]',
    error: 'border-[color:rgba(239,68,68,0.25)]',
    warning: 'border-[color:rgba(245,158,11,0.25)]',
    info: 'border-[color:rgba(59,130,246,0.25)]'
  };
  const toastBg = {
    success: 'var(--success-bg)',
    error: 'var(--danger-bg)',
    warning: 'var(--warning-bg)',
    info: 'var(--info-bg)',
  };

  return (
    <div
      className={cn(
        "pointer-events-auto flex items-start gap-3 p-4 rounded-xl border backdrop-blur-md shadow-elevated",
        "animate-slide-in-r transition-all duration-300",
        "bg-surface", bgs[toast.type]
      )}
      style={{ backgroundColor: toastBg[toast.type] }}
    >
      {icons[toast.type]}
      <div className="flex-1">
        <h4 className="text-sm font-semibold text-primary">{toast.title}</h4>
        {toast.description && <p className="text-xs text-secondary mt-1">{toast.description}</p>}
      </div>
      <button onClick={onRemove} className="text-muted hover:text-primary transition-colors">
        <X className="w-4 h-4" />
      </button>
      <div className="absolute bottom-0 left-0 h-1 bg-current opacity-20 animate-[shimmer_4s_linear_forwards]" />
    </div>
  );
}
