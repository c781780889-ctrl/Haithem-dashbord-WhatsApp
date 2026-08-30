import React, { useState, useEffect, useCallback, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import {
  Search, Plus, Trash2, Edit3, Bell, BellOff, Settings,
  Copy, Phone, MessageSquare, ExternalLink, Eye, CheckCircle,
  AlertTriangle, Activity, BarChart3, List, LayoutGrid,
  Filter, RefreshCw, Download, Upload, Tag, Clock,
  Users, Hash, Star, Zap, ChevronLeft, ChevronRight,
  X, Save, StickyNote, History, ToggleLeft, ToggleRight,
  TrendingUp, Volume2, VolumeX, ArrowUpRight, Shield,
  MessageCircle, AtSign, Calendar, Flame, Power, Wifi, WifiOff
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/ToastProvider';
import { API, authFetch, TOKEN_KEY } from '@/utils/api';
import { cn } from '@/utils/cn';

// ─── Types ────────────────────────────────────────────────────────────────────
interface Keyword {
  id: string; word: string; category: string; priority: string;
  color: string; case_sensitive: boolean; is_active: boolean;
  match_count: number; created_at: string; match_type?: string;
  description?: string; notify_enabled?: boolean; private_reply_enabled?: boolean;
  terms?: string[];
}

interface KeywordAlert {
  id: string; matched_keyword: string; message_text: string;
  sender_name: string; sender_phone: string; group_name: string;
  group_jid: string; account_id: string; message_time: string;
  status: string; internal_note?: string;
  keyword_color?: string; keyword_priority?: string; account_name?: string;
  account_phone?: string; is_pinned?: boolean; is_archived?: boolean;
}

interface KWStats {
  keywords_count: number; today_count: number; week_count?: number;
  matched_chats?: number; active_accounts?: number; unread_notifications?: number; replies_sent?: number;
  top_keywords: { matched_keyword: string; cnt: string }[];
  top_groups: { group_name: string; cnt: string }[];
  top_senders: { sender_name: string; sender_phone: string; cnt: string }[];
  daily_chart: { day: string; cnt: string }[];
}

interface KWSettings {
  monitoring_enabled: boolean; notifications_enabled: boolean;
  sound_enabled: boolean; sound_type: string; log_retention_days: number;
  scan_groups?: boolean; scan_private?: boolean; account_ids?: string[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
const fmtDate = (d: string) =>
  new Intl.DateTimeFormat('ar-YE', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(d));

const timeAgo = (d: string) => {
  const diff = Date.now() - new Date(d).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'الآن';
  if (m < 60) return `منذ ${m} د`;
  const h = Math.floor(m / 60);
  if (h < 24) return `منذ ${h} س`;
  return `منذ ${Math.floor(h / 24)} يوم`;
};

const PRIORITY_CONFIG: Record<string, { label: string; color: string; bg: string }> = {
  low:      { label: 'منخفض',  color: 'text-slate-400',   bg: 'bg-slate-500/15' },
  normal:   { label: 'عادي',   color: 'text-blue-400',    bg: 'bg-blue-500/15'  },
  high:     { label: 'عالي',   color: 'text-orange-400',  bg: 'bg-orange-500/15'},
  critical: { label: 'حرج',    color: 'text-red-400',     bg: 'bg-red-500/15'   },
};

const STATUS_CONFIG: Record<string, { label: string; color: string; bg: string }> = {
  new:        { label: 'جديد',         color: 'text-emerald-400', bg: 'bg-emerald-500/15' },
  reviewed:   { label: 'تمت المراجعة', color: 'text-blue-400',    bg: 'bg-blue-500/15'    },
  processing: { label: 'قيد المعالجة', color: 'text-yellow-400',  bg: 'bg-yellow-500/15'  },
};

// ─── Mini Chart ──────────────────────────────────────────────────────────────
function MiniBarChart({ data }: { data: { day: string; cnt: string }[] }) {
  if (!data.length) return <div className="h-20 flex items-center justify-center text-[var(--text-muted)] text-xs">لا توجد بيانات</div>;
  const max = Math.max(...data.map(d => parseInt(d.cnt) || 0), 1);
  return (
    <div className="flex items-end gap-1 h-16">
      {data.map((d, i) => {
        const h = Math.round((parseInt(d.cnt) / max) * 100);
        const label = new Date(d.day).toLocaleDateString('ar', { weekday: 'short' });
        return (
          <div key={i} className="flex-1 flex flex-col items-center gap-1">
            <div className="w-full bg-[var(--brand-primary)]/20 rounded-sm overflow-hidden" style={{ height: 48 }}>
              <div
                className="w-full bg-gradient-to-t from-[var(--brand-primary)] to-[var(--brand-secondary)] rounded-sm transition-all"
                style={{ height: `${h}%`, marginTop: `${100 - h}%` }}
              />
            </div>
            <span className="text-[10px] text-[var(--text-muted)]">{label}</span>
          </div>
        );
      })}
    </div>
  );
}

// ─── Keyword Form Modal ───────────────────────────────────────────────────────
function KeywordFormModal({
  kw, onSave, onClose
}: { kw?: Keyword | null; onSave: (data: any) => Promise<void>; onClose: () => void }) {
  const [form, setForm] = useState({
    word:           kw?.word           ?? '',
    category:       kw?.category       ?? 'عام',
    priority:       kw?.priority       ?? 'normal',
    color:          kw?.color          ?? '#00A884',
    case_sensitive: kw?.case_sensitive ?? false,
    match_type: kw?.match_type ?? 'contains',
    terms: kw?.terms?.join(', ') ?? '',
    description: kw?.description ?? '',
    notify_enabled: kw?.notify_enabled ?? true,
    private_reply_enabled: kw?.private_reply_enabled ?? false,
  });
  const [saving, setSaving] = useState(false);

  const COLORS = ['#00A884', '#4F8EF7', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#10b981', '#f97316'];

  async function handle() {
    if (!form.word.trim()) return;
    setSaving(true);
    try {
      const payload = { ...form, terms: form.terms.split(',').map((v: string) => v.trim()).filter(Boolean) };
      await onSave(payload); onClose();
    } finally { setSaving(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className="bg-[var(--bg-surface)] border border-[var(--border-default)] rounded-2xl w-full max-w-md shadow-[var(--shadow-elevated)]">
        <div className="flex items-center justify-between p-5 border-b border-[var(--border-default)]">
          <h3 className="font-bold text-lg">{kw ? 'تعديل الكلمة' : 'إضافة كلمة مفتاحية'}</h3>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-[var(--bg-elevated)] text-[var(--text-muted)] transition-colors"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-5 space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1.5 text-[var(--text-secondary)]">الكلمة المفتاحية *</label>
            <input
              className="w-full bg-[var(--bg-elevated)] border border-[var(--border-default)] rounded-xl px-3 py-2.5 text-sm outline-none focus:border-[var(--brand-primary)] transition-colors"
              placeholder="مثال: عروض، وظائف، بيع..."
              value={form.word}
              onChange={e => setForm(p => ({ ...p, word: e.target.value }))}
              dir="auto"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium mb-1.5 text-[var(--text-secondary)]">التصنيف</label>
              <input
                className="w-full bg-[var(--bg-elevated)] border border-[var(--border-default)] rounded-xl px-3 py-2.5 text-sm outline-none focus:border-[var(--brand-primary)] transition-colors"
                placeholder="عام"
                value={form.category}
                onChange={e => setForm(p => ({ ...p, category: e.target.value }))}
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1.5 text-[var(--text-secondary)]">الأولوية</label>
              <select
                className="w-full bg-[var(--bg-elevated)] border border-[var(--border-default)] rounded-xl px-3 py-2.5 text-sm outline-none focus:border-[var(--brand-primary)] transition-colors"
                value={form.priority}
                onChange={e => setForm(p => ({ ...p, priority: e.target.value }))}
              >
                {Object.entries(PRIORITY_CONFIG).map(([k, v]) => (
                  <option key={k} value={k}>{v.label}</option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium mb-2 text-[var(--text-secondary)]">لون التمييز</label>
            <div className="flex items-center gap-2 flex-wrap">
              {COLORS.map(c => (
                <button key={c} onClick={() => setForm(p => ({ ...p, color: c }))}
                  className={cn('w-7 h-7 rounded-lg border-2 transition-transform hover:scale-110',
                    form.color === c ? 'border-white scale-110' : 'border-transparent')}
                  style={{ background: c }} />
              ))}
              <input type="color" value={form.color}
                onChange={e => setForm(p => ({ ...p, color: e.target.value }))}
                className="w-7 h-7 rounded-lg cursor-pointer border-2 border-[var(--border-default)]" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium mb-1.5 text-[var(--text-secondary)]">نوع المطابقة</label>
              <select className="w-full bg-[var(--bg-elevated)] border border-[var(--border-default)] rounded-xl px-3 py-2.5 text-sm" value={form.match_type} onChange={e => setForm(p => ({ ...p, match_type: e.target.value }))}>
                <option value="contains">تحتوي على الكلمة</option><option value="exact">مطابقة كاملة</option><option value="starts_with">تبدأ بالكلمة</option><option value="ends_with">تنتهي بالكلمة</option><option value="multiple">عدة كلمات داخل الرسالة</option>
              </select>
            </div>
            <div><label className="block text-sm font-medium mb-1.5 text-[var(--text-secondary)]">عدة كلمات</label><input className="w-full bg-[var(--bg-elevated)] border border-[var(--border-default)] rounded-xl px-3 py-2.5 text-sm" placeholder="سعر, تكلفة, عرض" value={form.terms} onChange={e => setForm(p => ({ ...p, terms: e.target.value }))} dir="auto" /></div>
          </div>
          <input className="w-full bg-[var(--bg-elevated)] border border-[var(--border-default)] rounded-xl px-3 py-2.5 text-sm" placeholder="وصف اختياري" value={form.description} onChange={e => setForm(p => ({ ...p, description: e.target.value }))} />
          <label className="flex items-center gap-2 cursor-pointer">
            <div onClick={() => setForm(p => ({ ...p, case_sensitive: !p.case_sensitive }))}
              className={cn('w-10 h-5 rounded-full transition-colors relative', form.case_sensitive ? 'bg-[var(--brand-primary)]' : 'bg-[var(--bg-elevated)]')}>
              <div className={cn('absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all', form.case_sensitive ? 'left-5' : 'left-0.5')} />
            </div>
            <span className="text-sm text-[var(--text-secondary)]">حساس لحالة الأحرف</span>
          </label>
          <div className="flex flex-wrap gap-4 text-sm text-[var(--text-secondary)]">
            <label className="flex items-center gap-2"><input type="checkbox" checked={form.notify_enabled} onChange={e => setForm(p => ({ ...p, notify_enabled: e.target.checked }))} /> إشعار عند الاكتشاف</label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={form.private_reply_enabled} onChange={e => setForm(p => ({ ...p, private_reply_enabled: e.target.checked }))} /> تفعيل الرد الخاص</label>
          </div>
        </div>
        <div className="flex gap-3 p-5 border-t border-[var(--border-default)]">
          <Button onClick={handle} disabled={!form.word.trim() || saving} className="flex-1 gap-2">
            {saving ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            {kw ? 'حفظ التعديلات' : 'إضافة الكلمة'}
          </Button>
          <Button variant="outline" onClick={onClose}>إلغاء</Button>
        </div>
      </div>
    </div>
  );
}

// ─── Alert Detail Modal ───────────────────────────────────────────────────────
function AlertDetailModal({ alert, onClose, onAction }: {
  alert: KeywordAlert; onClose: () => void;
  onAction: (type: string, payload?: any) => void;
}) {
  const [note, setNote] = useState(alert.internal_note || '');
  const [noteEditing, setNoteEditing] = useState(false);

  const phone = alert.sender_phone;
  const waUrl = `https://wa.me/${phone}`;
  const groupUrl = `https://wa.me/${alert.group_jid?.replace('@g.us', '')}`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className="bg-[var(--bg-surface)] border border-[var(--border-default)] rounded-2xl w-full max-w-lg shadow-[var(--shadow-elevated)] max-h-[90vh] overflow-y-auto">
        <div className="sticky top-0 bg-[var(--bg-surface)] flex items-center justify-between p-5 border-b border-[var(--border-default)] z-10">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center"
              style={{ background: (alert.keyword_color || '#00A884') + '20' }}>
              <Search className="w-4 h-4" style={{ color: alert.keyword_color || '#00A884' }} />
            </div>
            <div>
              <p className="font-bold text-sm">{alert.matched_keyword}</p>
              <p className="text-xs text-[var(--text-muted)]">{timeAgo(alert.message_time)}</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-[var(--bg-elevated)] text-[var(--text-muted)] transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {/* نص الرسالة */}
          <div className="bg-[var(--bg-elevated)] rounded-xl p-4">
            <p className="text-xs text-[var(--text-muted)] mb-2 font-medium">نص الرسالة</p>
            <p className="text-sm leading-relaxed" dir="auto">{alert.message_text}</p>
            <div className="flex gap-2 mt-3">
              <button onClick={() => { navigator.clipboard.writeText(alert.message_text); }}
                className="flex items-center gap-1.5 text-xs text-[var(--text-muted)] hover:text-[var(--brand-primary)] transition-colors">
                <Copy className="w-3 h-3" /> نسخ النص
              </button>
            </div>
          </div>

          {/* معلومات المرسل */}
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-[var(--bg-elevated)] rounded-xl p-3">
              <p className="text-xs text-[var(--text-muted)] mb-1">المرسل</p>
              <p className="font-semibold text-sm">{alert.sender_name}</p>
              <p className="text-xs text-[var(--text-muted)] mt-0.5">{alert.sender_phone}</p>
            </div>
            <div className="bg-[var(--bg-elevated)] rounded-xl p-3">
              <p className="text-xs text-[var(--text-muted)] mb-1">المجموعة</p>
              <p className="font-semibold text-sm truncate">{alert.group_name}</p>
            </div>
          </div>

          {/* الأزرار التفاعلية */}
          <div className="grid grid-cols-2 gap-2">
            <button onClick={() => window.open(waUrl, '_blank')}
              className="flex items-center justify-center gap-2 py-2.5 rounded-xl bg-[var(--brand-primary)]/10 hover:bg-[var(--brand-primary)]/20 text-[var(--brand-primary)] text-sm font-medium transition-colors">
              <MessageSquare className="w-4 h-4" /> رسالة خاصة
            </button>
            <button onClick={() => window.open(waUrl, '_blank')}
              className="flex items-center justify-center gap-2 py-2.5 rounded-xl bg-[var(--bg-elevated)] hover:bg-[var(--border-default)] text-[var(--text-primary)] text-sm font-medium transition-colors">
              <ExternalLink className="w-4 h-4" /> فتح المحادثة
            </button>
            <button onClick={() => navigator.clipboard.writeText(phone)}
              className="flex items-center justify-center gap-2 py-2.5 rounded-xl bg-[var(--bg-elevated)] hover:bg-[var(--border-default)] text-[var(--text-primary)] text-sm font-medium transition-colors">
              <Copy className="w-4 h-4" /> نسخ الرقم
            </button>
            <button onClick={() => window.open(`tel:${phone}`, '_blank')}
              className="flex items-center justify-center gap-2 py-2.5 rounded-xl bg-[var(--bg-elevated)] hover:bg-[var(--border-default)] text-[var(--text-primary)] text-sm font-medium transition-colors">
              <Phone className="w-4 h-4" /> اتصال
            </button>
          </div>

          {/* الملاحظة الداخلية */}
          <div className="border border-[var(--border-default)] rounded-xl p-3">
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-medium text-[var(--text-muted)] flex items-center gap-1.5">
                <StickyNote className="w-3.5 h-3.5" /> ملاحظة داخلية
              </p>
              <button onClick={() => setNoteEditing(p => !p)}
                className="text-xs text-[var(--brand-primary)] hover:underline">
                {noteEditing ? 'إلغاء' : 'تعديل'}
              </button>
            </div>
            {noteEditing ? (
              <div className="space-y-2">
                <textarea
                  value={note} onChange={e => setNote(e.target.value)} rows={3}
                  className="w-full bg-[var(--bg-elevated)] border border-[var(--border-default)] rounded-lg px-3 py-2 text-sm outline-none focus:border-[var(--brand-primary)] resize-none"
                  placeholder="أضف ملاحظة..."
                />
                <Button size="sm" onClick={() => { onAction('note', note); setNoteEditing(false); }} className="text-xs">
                  حفظ الملاحظة
                </Button>
              </div>
            ) : (
              <p className="text-sm text-[var(--text-secondary)]">{note || 'لا توجد ملاحظة'}</p>
            )}
          </div>

          {/* أزرار الحالة */}
          <div className="flex gap-2">
            <Button onClick={() => { onAction('reply'); onClose(); }} className="flex-1 gap-2"><MessageSquare className="w-4 h-4" /> الرد على الخاص</Button>
            <Button onClick={() => { onAction('status', 'reviewed'); onClose(); }} variant="outline" className="flex-1 gap-2 text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/10">
              <CheckCircle className="w-4 h-4" /> تمت المراجعة
            </Button>
            <Button onClick={() => { onAction('delete'); onClose(); }} variant="outline" className="gap-2 text-red-400 border-red-500/30 hover:bg-red-500/10">
              <Trash2 className="w-4 h-4" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Alert Card ───────────────────────────────────────────────────────────────
function AlertCard({ alert, onDetail, onReview, onDelete, onReply, onPin, onArchive }: {
  alert: KeywordAlert;
  onDetail: () => void; onReview: () => void; onDelete: () => void; onReply: () => void; onPin: () => void; onArchive: () => void;
}) {
  const pc = PRIORITY_CONFIG[alert.keyword_priority || 'normal'];
  const sc = STATUS_CONFIG[alert.status] || STATUS_CONFIG.new;
  const color = alert.keyword_color || '#00A884';

  return (
    <div className="bg-[var(--bg-surface)] border border-[var(--border-default)] rounded-2xl p-4 hover:border-[var(--brand-primary)]/40 transition-all group"
      style={{ borderRightColor: color, borderRightWidth: 3 }}>
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-bold"
            style={{ background: color + '20', color }}>
            <Search className="w-3 h-3" />{alert.matched_keyword}
          </span>
          <span className={cn('inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium', sc.bg, sc.color)}>
            {sc.label}
          </span>
          {pc && (
            <span className={cn('inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium', pc.bg, pc.color)}>
              {pc.label}
            </span>
          )}
        </div>
        <span className="text-xs text-[var(--text-muted)] shrink-0 flex items-center gap-1">
          <Clock className="w-3 h-3" />{timeAgo(alert.message_time)}
        </span>
      </div>

      <p className="text-sm text-[var(--text-primary)] line-clamp-2 mb-3 leading-relaxed" dir="auto">
        {alert.message_text}
      </p>

      <div className="flex items-center gap-3 text-xs text-[var(--text-muted)] mb-3">
        <span className="flex items-center gap-1"><Users className="w-3 h-3" />{alert.sender_name}</span>
        <span className="flex items-center gap-1"><Hash className="w-3 h-3" />{alert.sender_phone}</span>
        <span className="flex items-center gap-1 truncate"><MessageCircle className="w-3 h-3" />{alert.group_name}</span>
      </div>

      <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
        <button onClick={onDetail}
          className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg bg-[var(--bg-elevated)] hover:bg-[var(--brand-primary)]/10 text-[var(--text-muted)] hover:text-[var(--brand-primary)] text-xs font-medium transition-colors">
          <Eye className="w-3.5 h-3.5" /> التفاصيل
        </button>
        <button onClick={onReply} title="الرد على الخاص"
          className="flex items-center justify-center gap-1.5 py-1.5 px-3 rounded-lg bg-[var(--brand-primary)]/10 hover:bg-[var(--brand-primary)]/20 text-[var(--brand-primary)] text-xs font-medium transition-colors">
          <MessageSquare className="w-3.5 h-3.5" />
        </button>
        <button onClick={onPin} title="تثبيت" className={cn('p-1.5 rounded-lg transition-colors', alert.is_pinned ? 'bg-amber-500/15 text-amber-400' : 'bg-[var(--bg-elevated)] text-[var(--text-muted)] hover:text-amber-400')}><Star className="w-3.5 h-3.5" /></button>
        <button onClick={onArchive} title="أرشفة" className="p-1.5 rounded-lg bg-[var(--bg-elevated)] text-[var(--text-muted)] hover:text-blue-400"><History className="w-3.5 h-3.5" /></button>
        {alert.status !== 'reviewed' && (
          <button onClick={onReview}
            className="flex items-center justify-center gap-1.5 py-1.5 px-3 rounded-lg bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 text-xs font-medium transition-colors">
            <CheckCircle className="w-3.5 h-3.5" />
          </button>
        )}
        <button onClick={onDelete}
          className="flex items-center justify-center py-1.5 px-3 rounded-lg bg-red-500/10 hover:bg-red-500/20 text-red-400 text-xs font-medium transition-colors">
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}

// ─── MAIN VIEW ────────────────────────────────────────────────────────────────
export default function KeywordMonitoringView({ userId }: { userId: string }) {
  const toast = useToast();
  const addToast = toast.addToast;

  // state
  const [tab, setTab]         = useState<'monitor' | 'keywords' | 'stats' | 'settings' | 'log'>('monitor');
  const [viewMode, setViewMode] = useState<'cards' | 'table'>('cards');
  const [loading, setLoading] = useState(false);

  // keywords state
  const [keywords, setKeywords]   = useState<Keyword[]>([]);
  const [kwSearch, setKwSearch]   = useState('');
  const [kwModal, setKwModal]     = useState<Keyword | null | 'new'>(null);

  // alerts state
  const [alerts, setAlerts]   = useState<KeywordAlert[]>([]);
  const [alertTotal, setAlertTotal] = useState(0);
  const [alertPage, setAlertPage] = useState(1);
  const [alertPages, setAlertPages] = useState(1);
  const [detailAlert, setDetailAlert] = useState<KeywordAlert | null>(null);
  const [newCount, setNewCount]   = useState(0);
  const [notifications, setNotifications] = useState<any[]>([]);
  const [health, setHealth] = useState<any[]>([]);
  const [accountOverview, setAccountOverview] = useState<{ monitoring_enabled: boolean; all_accounts_enabled: boolean; accounts: any[] }>({ monitoring_enabled: true, all_accounts_enabled: true, accounts: [] });
  const [replyAlert, setReplyAlert] = useState<KeywordAlert | null>(null);
  const [replyBody, setReplyBody] = useState('');
  const [replySending, setReplySending] = useState(false);

  // filter state
  const [filter, setFilter] = useState({ keyword: '', group_name: '', status: '', phone: '' });
  const [showFilter, setShowFilter] = useState(false);

  // stats & settings
  const [stats, setStats] = useState<KWStats | null>(null);
  const [settings, setSettings] = useState<KWSettings>({
    monitoring_enabled: true, notifications_enabled: true,
    sound_enabled: true, sound_type: 'default', log_retention_days: 30,
    scan_groups: true, scan_private: true, account_ids: [],
  });
  const [activityLog, setActivityLog] = useState<any[]>([]);

  // realtime
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // ── Fetches ──────────────────────────────────────────────────────────────
  const fetchKeywords = useCallback(async () => {
    try {
      const r = await authFetch(`${API}/keywords`);
      const d = await r.json();
      if (d.success) setKeywords(d.keywords);
    } catch {}
  }, []);

  const fetchAlerts = useCallback(async (page = 1) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), limit: '20' });
      if (filter.keyword)    params.set('keyword',    filter.keyword);
      if (filter.group_name) params.set('group_name', filter.group_name);
      if (filter.status)     params.set('status',     filter.status);
      if (filter.phone)      params.set('phone',      filter.phone);

      const r = await authFetch(`${API}/keyword-alerts?${params}`);
      const d = await r.json();
      if (d.success) {
        setAlerts(d.alerts);
        setAlertTotal(d.total);
        setAlertPage(d.page);
        setAlertPages(d.pages);
        setNewCount(d.alerts.filter((a: KeywordAlert) => a.status === 'new').length);
      }
    } catch {} finally { setLoading(false); }
  }, [filter]);

  const fetchStats = useCallback(async () => {
    try {
      const r = await authFetch(`${API}/keywords/stats`);
      const d = await r.json();
      if (d.success) setStats(d.stats);
    } catch {}
  }, []);

  const fetchSettings = useCallback(async () => {
    try {
      const r = await authFetch(`${API}/keywords/settings`);
      const d = await r.json();
      if (d.success) setSettings(d.settings);
    } catch {}
  }, []);

  const fetchNotifications = useCallback(async () => {
    try { const r = await authFetch(`${API}/keywords/notifications?limit=50`); const d = await r.json(); if (d.success) setNotifications(d.notifications || []); } catch {}
  }, []);

  const fetchHealth = useCallback(async () => {
    try { const r = await authFetch(`${API}/keywords/health`); const d = await r.json(); if (d.success) setHealth(d.health || []); } catch {}
  }, []);

  const fetchAccountOverview = useCallback(async () => {
    try { const r = await authFetch(`${API}/keywords/accounts`); const d = await r.json(); if (d.success) { setAccountOverview({ monitoring_enabled: d.monitoring_enabled !== false, all_accounts_enabled: d.all_accounts_enabled !== false, accounts: d.accounts || [] }); setHealth(d.accounts || []); } } catch {}
  }, []);

  const fetchLog = useCallback(async () => {
    try {
      const r = await authFetch(`${API}/keywords/activity-log`);
      const d = await r.json();
      if (d.success) setActivityLog(d.logs);
    } catch {}
  }, []);

  useEffect(() => { fetchKeywords(); fetchSettings(); fetchNotifications(); fetchAccountOverview(); }, [fetchKeywords, fetchSettings, fetchNotifications, fetchAccountOverview]);
  useEffect(() => { const timer = window.setInterval(() => { fetchNotifications(); fetchAccountOverview(); }, 10000); return () => window.clearInterval(timer); }, [fetchNotifications, fetchAccountOverview]);
  useEffect(() => { if (tab === 'monitor') fetchAlerts(1); }, [tab, filter]);
  useEffect(() => { if (tab === 'stats')   fetchStats(); }, [tab]);
  useEffect(() => { if (tab === 'log')     fetchLog(); }, [tab]);

  // ── Socket.IO realtime ───────────────────────────────────────────────────
  useEffect(() => {
    const socket: Socket = io(window.location.origin, { path: '/socket.io', transports: ['websocket', 'polling'], reconnection: true });
    const onAlert = (payload: any) => {
      if (!payload || payload.userId !== userId || !payload.alert) return;
      const alert = payload.alert;
      setAlerts(prev => [alert, ...prev.filter(a => a.id !== alert.id)].slice(0, 20));
      setNewCount(p => p + 1);
      if (settings.sound_enabled) { try { new Audio('/sounds/alert.mp3').play().catch(() => {}); } catch {} }
      addToast({ title: `تنبيه: ${alert.matched_keyword} من ${alert.sender_name}`, type: 'info' });
    };
    const onDeleted = (payload: any) => {
      if (!payload || payload.userId !== userId) return;
      setAlerts(prev => prev.filter(a => a.id !== payload.alertId && !(payload.accountId && payload.messageId && a.account_id === payload.accountId && a.message_id === payload.messageId)));
      setDetailAlert(prev => prev && (prev.id === payload.alertId || (payload.accountId && payload.messageId && prev.account_id === payload.accountId && prev.message_id === payload.messageId)) ? null : prev);
    };
    const onNotification = (payload: any) => {
      if (!payload || payload.userId !== userId) return;
      if (payload.notification) setNotifications(prev => [payload.notification, ...prev.filter(n => n.id !== payload.notification.id)]);
      setNewCount(p => p + 1);
    };
    socket.on('connect', () => socket.emit('join_user', { userId, token: localStorage.getItem(TOKEN_KEY) || '' }));
    socket.on('keyword_alert', onAlert);
    socket.on('keyword_alert_deleted', onDeleted);
    socket.on('keyword_notification', onNotification);
    return () => { socket.off('keyword_alert', onAlert); socket.off('keyword_alert_deleted', onDeleted); socket.off('keyword_notification', onNotification); socket.disconnect(); };
  }, [userId, settings.sound_enabled, addToast]);

  // ── Keyword actions ──────────────────────────────────────────────────────
  async function toggleMonitoring() {
    const next = !settings.monitoring_enabled;
    const nextSettings = { ...settings, monitoring_enabled: next, account_ids: [] };
    try {
      const r = await authFetch(`${API}/keywords/settings`, { method: 'POST', body: JSON.stringify(nextSettings) });
      const d = await r.json();
      if (!d.success) throw new Error(d.error || 'تعذر تحديث الحالة');
      setSettings(d.settings);
      setAccountOverview(prev => ({ ...prev, monitoring_enabled: next, all_accounts_enabled: true }));
      addToast({ title: next ? 'تم تشغيل نظام الكلمات المفتاحية لكل الحسابات' : 'تم إيقاف نظام الكلمات المفتاحية', type: next ? 'success' : 'warning' });
      fetchAccountOverview();
    } catch (e: any) { addToast({ title: e.message || 'تعذر تحديث حالة النظام', type: 'error' }); }
  }

  // ── Keyword actions ──────────────────────────────────────────────────────
  async function saveKeyword(data: any) {
    const isEdit = kwModal && kwModal !== 'new';
    const url  = isEdit ? `${API}/keywords/${(kwModal as Keyword).id}` : `${API}/keywords`;
    const meth = isEdit ? 'PATCH' : 'POST';
    const r = await authFetch(url, { method: meth, body: JSON.stringify(data) });
    const d = await r.json();
    if (!d.success) { addToast({ title: d.error || 'خطأ', type: 'error' }); return; }
    addToast({ title: isEdit ? 'تم التعديل' : 'تمت الإضافة', type: 'success' });
    await fetchKeywords();
  }

  async function deleteKeyword(id: string) {
    if (!confirm('حذف الكلمة؟')) return;
    const r = await authFetch(`${API}/keywords/${id}`, { method: 'DELETE' });
    const d = await r.json();
    if (d.success) { addToast({ title: 'تم الحذف', type: 'success' }); fetchKeywords(); }
  }

  async function toggleKeyword(kw: Keyword) {
    const r = await authFetch(`${API}/keywords/${kw.id}`, {
      method: 'PATCH', body: JSON.stringify({ is_active: !kw.is_active })
    });
    const d = await r.json();
    if (d.success) fetchKeywords();
  }

  // ── Alert actions ────────────────────────────────────────────────────────
  async function reviewAlert(id: string) {
    const r = await authFetch(`${API}/keyword-alerts/${id}`, {
      method: 'PATCH', body: JSON.stringify({ status: 'reviewed' })
    });
    const d = await r.json();
    if (d.success) { addToast({ title: 'تمت المراجعة', type: 'success' }); fetchAlerts(alertPage); }
  }

  async function toggleAlertFlag(alert: KeywordAlert, field: 'is_pinned' | 'is_archived') {
    const r = await authFetch(`${API}/keyword-alerts/${alert.id}/flag`, { method: 'PATCH', body: JSON.stringify({ field, value: !alert[field] }) });
    const d = await r.json(); if (d.success) { addToast({ title: field === 'is_pinned' ? (alert[field] ? 'تم إلغاء التثبيت' : 'تم تثبيت التنبيه') : 'تم تحديث الأرشفة', type: 'success' }); fetchAlerts(alertPage); }
  }

  async function sendReply() {
    if (!replyAlert || !replyBody.trim()) return; setReplySending(true);
    try { const r = await authFetch(`${API}/keyword-alerts/${replyAlert.id}/reply`, { method: 'POST', body: JSON.stringify({ body: replyBody }) }); const d = await r.json(); if (!d.success) throw new Error(d.error); addToast({ title: 'تم إرسال الرد من الحساب المستلم', type: 'success' }); setReplyAlert(null); setReplyBody(''); fetchAlerts(alertPage); } catch (e: any) { addToast({ title: e.message || 'فشل إرسال الرد', type: 'error' }); } finally { setReplySending(false); }
  }

  async function deleteAlert(id: string) {
    const r = await authFetch(`${API}/keyword-alerts/${id}`, { method: 'DELETE' });
    const d = await r.json();
    if (d.success) { addToast({ title: 'تم حذف التنبيه', type: 'success' }); fetchAlerts(alertPage); }
  }

  async function alertAction(alert: KeywordAlert, type: string, payload?: any) {
    if (type === 'status') { await reviewAlert(alert.id); }
    else if (type === 'delete') { await deleteAlert(alert.id); }
    else if (type === 'reply') { setReplyAlert(alert); }
    else if (type === 'pin') { await toggleAlertFlag(alert, 'is_pinned'); }
    else if (type === 'archive') { await toggleAlertFlag(alert, 'is_archived'); }
    else if (type === 'note') {
      await authFetch(`${API}/keyword-alerts/${alert.id}/note`, {
        method: 'POST', body: JSON.stringify({ note: payload })
      });
      addToast({ title: 'تم حفظ الملاحظة', type: 'success' });
    }
  }

  // ── Export/Import ────────────────────────────────────────────────────────
  async function exportKw() {
    const r = await authFetch(`${API}/keywords/export`);
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'keywords.json'; a.click();
    URL.revokeObjectURL(url);
  }

  function importKw() {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.json';
    inp.onchange = async (e: any) => {
      const file = e.target.files[0];
      if (!file) return;
      const text = await file.text();
      try {
        const keywords = JSON.parse(text);
        const r = await authFetch(`${API}/keywords/import`, {
          method: 'POST', body: JSON.stringify({ keywords })
        });
        const d = await r.json();
        if (d.success) { addToast({ title: `تم استيراد ${d.added} كلمة`, type: 'success' }); fetchKeywords(); }
      } catch { addToast({ title: 'ملف غير صحيح', type: 'error' }); }
    };
    inp.click();
  }

  // ── Save settings ────────────────────────────────────────────────────────
  async function saveSettings() {
    const r = await authFetch(`${API}/keywords/settings`, {
      method: 'POST', body: JSON.stringify(settings)
    });
    const d = await r.json();
    if (d.success) addToast({ title: 'تم حفظ الإعدادات', type: 'success' });
  }

  // ── Filtered keywords ────────────────────────────────────────────────────
  const filteredKw = keywords.filter(k =>
    !kwSearch || k.word.toLowerCase().includes(kwSearch.toLowerCase()) ||
    k.category.toLowerCase().includes(kwSearch.toLowerCase())
  );

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full bg-[var(--bg-app)] text-[var(--text-primary)]" dir="rtl">

      {/* Header */}
      <div className="bg-[var(--bg-surface)] border-b border-[var(--border-default)] px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-[var(--brand-primary)] to-[var(--brand-secondary)] flex items-center justify-center shadow-[var(--shadow-glow)]">
              <Search className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-xl font-bold">الكلمات المفتاحية</h1>
              <p className="text-xs text-[var(--text-muted)]">مراقبة لحظية لرسائل المجموعات</p>
            </div>
            {newCount > 0 && (
              <span className="px-2.5 py-0.5 rounded-full bg-red-500 text-white text-xs font-bold animate-pulse">
                {newCount}
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button onClick={() => { fetchAlerts(alertPage); fetchStats(); fetchAccountOverview(); }}
              className="p-2 rounded-xl hover:bg-[var(--bg-elevated)] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors" title="تحديث حالة الحسابات">
              <RefreshCw className="w-4 h-4" />
            </button>
            <Button onClick={toggleMonitoring} variant={settings.monitoring_enabled ? 'outline' : 'default'} className={cn('gap-2 rounded-xl', settings.monitoring_enabled ? 'border-red-500/40 text-red-400 hover:bg-red-500/10' : 'bg-emerald-600 hover:bg-emerald-500')}>
              <Power className="w-4 h-4" />{settings.monitoring_enabled ? 'إيقاف النظام' : 'تشغيل النظام'}
            </Button>
            <div className={cn('w-2 h-2 rounded-full', settings.monitoring_enabled ? 'bg-emerald-400 animate-pulse' : 'bg-slate-400')} />
            <span className="text-xs text-[var(--text-muted)]">
              {settings.monitoring_enabled ? 'مفعّل' : 'موقوف'}
            </span>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 mt-4 bg-[var(--bg-elevated)] p-1 rounded-xl w-fit">
          {([
            { key: 'monitor',  label: 'التنبيهات',     icon: Bell    },
            { key: 'keywords', label: 'الكلمات',       icon: Tag     },
            { key: 'stats',    label: 'الإحصائيات',    icon: BarChart3 },
            { key: 'settings', label: 'الإعدادات',     icon: Settings },
            { key: 'log',      label: 'سجل النشاط',    icon: History  },
          ] as const).map(t => (
            <button key={t.key} onClick={() => setTab(t.key)}
              className={cn('flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-all',
                tab === t.key
                  ? 'bg-[var(--brand-primary)] text-white shadow-[var(--shadow-glow)]'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
              )}>
              <t.icon className="w-3.5 h-3.5" />{t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6">

        {/* ── Monitor Tab ── */}
        {tab === 'monitor' && (
          <div className="space-y-4">
            {/* Account activation and real connection details */}
            <Card className="bg-[var(--bg-surface)] border-[var(--border-default)]">
              <CardContent className="p-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h2 className="font-bold flex items-center gap-2"><Users className="w-4 h-4 text-emerald-400" /> الحسابات المرتبطة بالنظام</h2>
                    <p className="text-xs text-[var(--text-muted)] mt-1">جميع الحسابات مفعّلة تلقائياً للمراقبة عند تشغيل النظام.</p>
                  </div>
                  <Badge variant={accountOverview.all_accounts_enabled ? 'success' : 'warning'}>{accountOverview.all_accounts_enabled ? 'كل الحسابات مفعّلة' : 'نطاق مخصص'}</Badge>
                </div>
                {accountOverview.accounts.length === 0 ? <p className="text-sm text-[var(--text-muted)] py-3">لا توجد حسابات واتساب مرتبطة حتى الآن.</p> : <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">{accountOverview.accounts.map((account: any) => {
                  const connected = account.connected;
                  return <div key={account.account_id} className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-elevated)] p-3">
                    <div className="flex items-start justify-between gap-2"><div className="min-w-0"><p className="font-semibold truncate">{account.account_name || 'حساب واتساب'}</p><p className="text-xs text-[var(--text-muted)] font-mono mt-1" dir="ltr">{account.account_phone || 'بدون رقم'}</p></div><span className={cn('inline-flex items-center gap-1 text-xs font-semibold', connected ? 'text-emerald-400' : 'text-amber-400')}><span className={cn('w-2 h-2 rounded-full', connected ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400')} />{connected ? 'متصل ويعمل' : account.account_status === 'connecting' ? 'جارٍ الاتصال' : 'غير متصل'}</span></div>
                    <div className="mt-3 flex items-center justify-between text-[11px] text-[var(--text-muted)]"><span className="flex items-center gap-1">{connected ? <Wifi className="w-3.5 h-3.5 text-emerald-400" /> : <WifiOff className="w-3.5 h-3.5" />} {account.included ? 'مفعّل للمراقبة' : 'غير مفعّل'}</span><span>آخر نشاط: {account.last_event_at ? timeAgo(account.last_event_at) : '—'}</span></div>
                  </div>;
                })}</div>}
              </CardContent>
            </Card>
            {/* Quick Stats Row */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              {[
                { label: 'تنبيهات اليوم', value: stats?.today_count ?? '—', icon: Bell, color: 'text-emerald-400' },
                { label: 'هذا الأسبوع',  value: stats?.week_count  ?? '—', icon: TrendingUp, color: 'text-blue-400' },
                { label: 'الكلمات النشطة', value: keywords.filter(k => k.is_active).length, icon: Tag, color: 'text-purple-400' },
                { label: 'إجمالي التنبيهات', value: alertTotal, icon: Activity, color: 'text-orange-400' },
              ].map((s, i) => (
                <Card key={i} className="bg-[var(--bg-surface)] border-[var(--border-default)]">
                  <CardContent className="p-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-xs text-[var(--text-muted)]">{s.label}</p>
                        <p className={cn('text-2xl font-bold mt-0.5', s.color)}>{s.value}</p>
                      </div>
                      <div className={cn('w-10 h-10 rounded-xl flex items-center justify-center', s.color, 'bg-current/10')}>
                        <s.icon className="w-5 h-5" />
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>

            <div className="bg-[var(--bg-surface)] border border-[var(--border-default)] rounded-2xl p-4 flex flex-wrap items-center gap-4">
              <div className="flex items-center gap-2"><span className={cn('w-2.5 h-2.5 rounded-full', health.length && health.every(h => h.status === 'connected') ? 'bg-emerald-400 animate-pulse' : health.length ? 'bg-amber-400' : 'bg-slate-400')} /><span className="text-sm font-semibold">{health.length && health.every(h => h.status === 'connected') ? 'النظام يعمل - استقبال مباشر' : health.length ? 'الاتصال غير مستقر' : 'بانتظار اتصال الحسابات'}</span></div>
              <span className="text-xs text-[var(--text-muted)]">الحسابات النشطة: {stats?.active_accounts ?? health.filter(h => h.status === 'connected').length}</span>
              <span className="text-xs text-[var(--text-muted)]">آخر نبضة: {health[0]?.updated_at ? timeAgo(health[0].updated_at) : '—'}</span>
              <span className="text-xs text-[var(--text-muted)]">التنبيهات غير المقروءة: {stats?.unread_notifications ?? notifications.filter(n => !n.is_read).length}</span>
            </div>

            {/* Filter bar */}
            <div className="flex items-center gap-2 flex-wrap">
              <div className="relative flex-1 min-w-48">
                <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]" />
                <input
                  className="w-full bg-[var(--bg-surface)] border border-[var(--border-default)] rounded-xl pr-9 pl-3 py-2 text-sm outline-none focus:border-[var(--brand-primary)] transition-colors"
                  placeholder="بحث بالكلمة المفتاحية..."
                  value={filter.keyword}
                  onChange={e => setFilter(p => ({ ...p, keyword: e.target.value }))}
                />
              </div>

              <button onClick={() => setShowFilter(p => !p)}
                className={cn('flex items-center gap-2 px-3 py-2 rounded-xl border text-sm font-medium transition-colors',
                  showFilter ? 'bg-[var(--brand-primary)]/10 border-[var(--brand-primary)]/30 text-[var(--brand-primary)]'
                             : 'border-[var(--border-default)] text-[var(--text-muted)] hover:text-[var(--text-primary)]')}>
                <Filter className="w-4 h-4" /> فلاتر
              </button>

              <div className="flex bg-[var(--bg-elevated)] rounded-xl p-1 gap-1">
                <button onClick={() => setViewMode('cards')}
                  className={cn('p-1.5 rounded-lg transition-colors', viewMode === 'cards' ? 'bg-[var(--brand-primary)] text-white' : 'text-[var(--text-muted)]')}>
                  <LayoutGrid className="w-4 h-4" />
                </button>
                <button onClick={() => setViewMode('table')}
                  className={cn('p-1.5 rounded-lg transition-colors', viewMode === 'table' ? 'bg-[var(--brand-primary)] text-white' : 'text-[var(--text-muted)]')}>
                  <List className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Advanced filter */}
            {showFilter && (
              <div className="bg-[var(--bg-surface)] border border-[var(--border-default)] rounded-2xl p-4 grid grid-cols-2 sm:grid-cols-4 gap-3">
                {[
                  { key: 'group_name', placeholder: 'اسم المجموعة' },
                  { key: 'phone', placeholder: 'رقم الهاتف' },
                ].map(f => (
                  <input key={f.key}
                    className="bg-[var(--bg-elevated)] border border-[var(--border-default)] rounded-xl px-3 py-2 text-sm outline-none focus:border-[var(--brand-primary)] transition-colors"
                    placeholder={f.placeholder}
                    value={(filter as any)[f.key]}
                    onChange={e => setFilter(p => ({ ...p, [f.key]: e.target.value }))}
                  />
                ))}
                <select
                  className="bg-[var(--bg-elevated)] border border-[var(--border-default)] rounded-xl px-3 py-2 text-sm outline-none focus:border-[var(--brand-primary)] transition-colors"
                  value={filter.status}
                  onChange={e => setFilter(p => ({ ...p, status: e.target.value }))}>
                  <option value="">كل الحالات</option>
                  {Object.entries(STATUS_CONFIG).map(([k, v]) => (
                    <option key={k} value={k}>{v.label}</option>
                  ))}
                </select>
                <button onClick={() => setFilter({ keyword: '', group_name: '', status: '', phone: '' })}
                  className="flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl border border-[var(--border-default)] text-sm text-[var(--text-muted)] hover:text-red-400 hover:border-red-500/30 transition-colors">
                  <X className="w-3.5 h-3.5" /> مسح
                </button>
              </div>
            )}

            {/* Alerts list */}
            {loading ? (
              <div className="flex items-center justify-center py-16 text-[var(--text-muted)]">
                <RefreshCw className="w-6 h-6 animate-spin mr-2" /> جارٍ التحميل...
              </div>
            ) : alerts.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 text-[var(--text-muted)]">
                <Bell className="w-12 h-12 mb-4 opacity-30" />
                <p className="font-medium">لا توجد تنبيهات</p>
                <p className="text-sm mt-1">ستظهر هنا لحظياً عند اكتشاف كلمة مفتاحية</p>
              </div>
            ) : viewMode === 'cards' ? (
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                {alerts.map(a => (
                  <AlertCard key={a.id} alert={a}
                    onDetail={() => setDetailAlert(a)}
                    onReview={() => reviewAlert(a.id)}
                    onDelete={() => deleteAlert(a.id)}
                    onReply={() => setReplyAlert(a)}
                    onPin={() => toggleAlertFlag(a, 'is_pinned')}
                    onArchive={() => toggleAlertFlag(a, 'is_archived')}
                  />
                ))}
              </div>
            ) : (
              <div className="bg-[var(--bg-surface)] border border-[var(--border-default)] rounded-2xl overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="border-b border-[var(--border-default)] bg-[var(--bg-elevated)]">
                      <tr>
                        {['الكلمة', 'الرسالة', 'المرسل', 'الرقم', 'المجموعة', 'الوقت', 'الحالة', ''].map(h => (
                          <th key={h} className="text-right px-4 py-3 text-xs font-semibold text-[var(--text-muted)]">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[var(--border-default)]">
                      {alerts.map(a => {
                        const sc = STATUS_CONFIG[a.status] || STATUS_CONFIG.new;
                        return (
                          <tr key={a.id} className="hover:bg-[var(--bg-elevated)] transition-colors">
                            <td className="px-4 py-3">
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-bold"
                                style={{ background: (a.keyword_color || '#00A884') + '20', color: a.keyword_color || '#00A884' }}>
                                {a.matched_keyword}
                              </span>
                            </td>
                            <td className="px-4 py-3 max-w-xs">
                              <p className="truncate text-[var(--text-secondary)]">{a.message_text}</p>
                            </td>
                            <td className="px-4 py-3 font-medium">{a.sender_name}</td>
                            <td className="px-4 py-3 text-[var(--text-muted)]">{a.sender_phone}</td>
                            <td className="px-4 py-3 text-[var(--text-muted)] max-w-xs truncate">{a.group_name}</td>
                            <td className="px-4 py-3 text-[var(--text-muted)] whitespace-nowrap">{timeAgo(a.message_time)}</td>
                            <td className="px-4 py-3">
                              <span className={cn('inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium', sc.bg, sc.color)}>
                                {sc.label}
                              </span>
                            </td>
                            <td className="px-4 py-3">
                              <div className="flex items-center gap-1">
                                <button onClick={() => setDetailAlert(a)} className="p-1.5 rounded-lg hover:bg-[var(--bg-elevated)] text-[var(--text-muted)] hover:text-[var(--brand-primary)] transition-colors"><Eye className="w-4 h-4" /></button>
                                <button onClick={() => reviewAlert(a.id)} className="p-1.5 rounded-lg hover:bg-emerald-500/10 text-[var(--text-muted)] hover:text-emerald-400 transition-colors"><CheckCircle className="w-4 h-4" /></button>
                                <button onClick={() => deleteAlert(a.id)} className="p-1.5 rounded-lg hover:bg-red-500/10 text-[var(--text-muted)] hover:text-red-400 transition-colors"><Trash2 className="w-4 h-4" /></button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Pagination */}
            {alertPages > 1 && (
              <div className="flex items-center justify-between">
                <p className="text-sm text-[var(--text-muted)]">
                  إجمالي {alertTotal} تنبيه — صفحة {alertPage} من {alertPages}
                </p>
                <div className="flex items-center gap-2">
                  <button disabled={alertPage <= 1} onClick={() => fetchAlerts(alertPage - 1)}
                    className="p-2 rounded-xl border border-[var(--border-default)] disabled:opacity-40 hover:bg-[var(--bg-elevated)] transition-colors">
                    <ChevronRight className="w-4 h-4" />
                  </button>
                  <button disabled={alertPage >= alertPages} onClick={() => fetchAlerts(alertPage + 1)}
                    className="p-2 rounded-xl border border-[var(--border-default)] disabled:opacity-40 hover:bg-[var(--bg-elevated)] transition-colors">
                    <ChevronLeft className="w-4 h-4" />
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── Keywords Tab ── */}
        {tab === 'keywords' && (
          <div className="space-y-4">
            <div className="flex items-center gap-3 flex-wrap">
              <div className="relative flex-1 min-w-48">
                <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]" />
                <input
                  className="w-full bg-[var(--bg-surface)] border border-[var(--border-default)] rounded-xl pr-9 pl-3 py-2 text-sm outline-none focus:border-[var(--brand-primary)] transition-colors"
                  placeholder="بحث في الكلمات..."
                  value={kwSearch}
                  onChange={e => setKwSearch(e.target.value)}
                />
              </div>
              <Button onClick={() => setKwModal('new')} className="gap-2 shrink-0">
                <Plus className="w-4 h-4" /> إضافة كلمة
              </Button>
              <button onClick={exportKw}
                className="flex items-center gap-1.5 px-3 py-2 rounded-xl border border-[var(--border-default)] text-sm text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors">
                <Download className="w-4 h-4" /> تصدير
              </button>
              <button onClick={importKw}
                className="flex items-center gap-1.5 px-3 py-2 rounded-xl border border-[var(--border-default)] text-sm text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors">
                <Upload className="w-4 h-4" /> استيراد
              </button>
            </div>

            {filteredKw.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 text-[var(--text-muted)]">
                <Tag className="w-12 h-12 mb-4 opacity-30" />
                <p className="font-medium">لا توجد كلمات مفتاحية</p>
                <p className="text-sm mt-1 mb-4">أضف كلمات لبدء المراقبة</p>
                <Button onClick={() => setKwModal('new')} className="gap-2">
                  <Plus className="w-4 h-4" /> إضافة أول كلمة
                </Button>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {filteredKw.map(kw => {
                  const pc = PRIORITY_CONFIG[kw.priority];
                  return (
                    <div key={kw.id}
                      className={cn('bg-[var(--bg-surface)] border rounded-2xl p-4 transition-all hover:shadow-lg group',
                        kw.is_active ? 'border-[var(--border-default)] hover:border-[var(--brand-primary)]/40' : 'border-[var(--border-default)] opacity-60')}
                      style={{ borderRightColor: kw.is_active ? kw.color : undefined, borderRightWidth: kw.is_active ? 3 : undefined }}>
                      <div className="flex items-start justify-between mb-3">
                        <div className="flex items-center gap-2">
                          <div className="w-8 h-8 rounded-lg flex items-center justify-center"
                            style={{ background: kw.color + '20' }}>
                            <Search className="w-4 h-4" style={{ color: kw.color }} />
                          </div>
                          <div>
                            <p className="font-bold" dir="auto">{kw.word}</p>
                            <p className="text-xs text-[var(--text-muted)]">{kw.category}</p>
                          </div>
                        </div>
                        <button onClick={() => toggleKeyword(kw)}
                          className="text-[var(--text-muted)] hover:text-[var(--brand-primary)] transition-colors">
                          {kw.is_active
                            ? <ToggleRight className="w-6 h-6 text-[var(--brand-primary)]" />
                            : <ToggleLeft className="w-6 h-6" />}
                        </button>
                      </div>

                      <div className="flex items-center gap-2 flex-wrap mb-3">
                        <span className={cn('text-xs px-2 py-0.5 rounded-full font-medium', pc.bg, pc.color)}>{pc.label}</span>
                        <span className="text-xs px-2 py-0.5 rounded-full bg-[var(--bg-elevated)] text-[var(--text-muted)]">
                          {kw.match_count} تطابق
                        </span>
                        {kw.case_sensitive && (
                          <span className="text-xs px-2 py-0.5 rounded-full bg-purple-500/15 text-purple-400">حساس</span>
                        )}
                      </div>

                      <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button onClick={() => setKwModal(kw)}
                          className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg bg-[var(--bg-elevated)] hover:bg-[var(--brand-primary)]/10 hover:text-[var(--brand-primary)] text-[var(--text-muted)] text-xs font-medium transition-colors">
                          <Edit3 className="w-3.5 h-3.5" /> تعديل
                        </button>
                        <button onClick={() => deleteKeyword(kw.id)}
                          className="flex items-center justify-center gap-1.5 py-1.5 px-3 rounded-lg bg-red-500/10 hover:bg-red-500/20 text-red-400 text-xs font-medium transition-colors">
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* ── Stats Tab ── */}
        {tab === 'stats' && stats && (
          <div className="space-y-6">
            {/* Summary cards */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              {[
                { label: 'الكلمات المفتاحية', value: stats.keywords_count, icon: Tag, color: 'text-purple-400' },
                { label: 'مطابقات اليوم',     value: stats.today_count,    icon: Zap, color: 'text-emerald-400' },
                { label: 'مطابقات الأسبوع',   value: stats.week_count,     icon: TrendingUp, color: 'text-blue-400' },
                { label: 'أكثر كلمة',          value: stats.top_keywords[0]?.matched_keyword || '—', icon: Flame, color: 'text-orange-400' },
              ].map((s, i) => (
                <Card key={i} className="bg-[var(--bg-surface)] border-[var(--border-default)]">
                  <CardContent className="p-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-xs text-[var(--text-muted)]">{s.label}</p>
                        <p className={cn('text-2xl font-bold mt-0.5', s.color)}>{s.value}</p>
                      </div>
                      <div className={cn('w-10 h-10 rounded-xl flex items-center justify-center', s.color, 'bg-current/10')}>
                        <s.icon className="w-5 h-5" />
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>

            {/* Chart */}
            <Card className="bg-[var(--bg-surface)] border-[var(--border-default)]">
              <CardContent className="p-5">
                <h3 className="font-bold mb-4 flex items-center gap-2">
                  <BarChart3 className="w-4 h-4 text-[var(--brand-primary)]" /> المطابقات خلال 7 أيام
                </h3>
                <MiniBarChart data={stats.daily_chart} />
              </CardContent>
            </Card>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {/* Top keywords */}
              <Card className="bg-[var(--bg-surface)] border-[var(--border-default)]">
                <CardContent className="p-5">
                  <h3 className="font-bold mb-3 text-sm flex items-center gap-2">
                    <Star className="w-4 h-4 text-yellow-400" /> أكثر الكلمات تطابقاً
                  </h3>
                  <div className="space-y-2">
                    {stats.top_keywords.length === 0
                      ? <p className="text-xs text-[var(--text-muted)]">لا توجد بيانات</p>
                      : stats.top_keywords.map((k, i) => (
                      <div key={i} className="flex items-center justify-between">
                        <span className="text-sm font-medium" dir="auto">{k.matched_keyword}</span>
                        <span className="text-xs px-2 py-0.5 rounded-full bg-[var(--brand-primary)]/15 text-[var(--brand-primary)] font-bold">{k.cnt}</span>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>

              {/* Top groups */}
              <Card className="bg-[var(--bg-surface)] border-[var(--border-default)]">
                <CardContent className="p-5">
                  <h3 className="font-bold mb-3 text-sm flex items-center gap-2">
                    <MessageCircle className="w-4 h-4 text-blue-400" /> أكثر المجموعات
                  </h3>
                  <div className="space-y-2">
                    {stats.top_groups.length === 0
                      ? <p className="text-xs text-[var(--text-muted)]">لا توجد بيانات</p>
                      : stats.top_groups.map((g, i) => (
                      <div key={i} className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium truncate">{g.group_name}</span>
                        <span className="text-xs px-2 py-0.5 rounded-full bg-blue-500/15 text-blue-400 font-bold shrink-0">{g.cnt}</span>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>

              {/* Top senders */}
              <Card className="bg-[var(--bg-surface)] border-[var(--border-default)]">
                <CardContent className="p-5">
                  <h3 className="font-bold mb-3 text-sm flex items-center gap-2">
                    <AtSign className="w-4 h-4 text-purple-400" /> أكثر الأعضاء
                  </h3>
                  <div className="space-y-2">
                    {stats.top_senders.length === 0
                      ? <p className="text-xs text-[var(--text-muted)]">لا توجد بيانات</p>
                      : stats.top_senders.map((s, i) => (
                      <div key={i} className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-sm font-medium truncate">{s.sender_name}</p>
                          <p className="text-xs text-[var(--text-muted)]">{s.sender_phone}</p>
                        </div>
                        <span className="text-xs px-2 py-0.5 rounded-full bg-purple-500/15 text-purple-400 font-bold shrink-0">{s.cnt}</span>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>
        )}

        {/* ── Settings Tab ── */}
        {tab === 'settings' && (
          <div className="max-w-xl space-y-4">
            <Card className="bg-[var(--bg-surface)] border-[var(--border-default)]">
              <CardContent className="p-5 space-y-5">
                <h3 className="font-bold flex items-center gap-2">
                  <Shield className="w-4 h-4 text-[var(--brand-primary)]" /> إعدادات المراقبة
                </h3>

                {([
                  { key: 'monitoring_enabled',    label: 'تفعيل المراقبة',             desc: 'تشغيل وإيقاف المراقبة اللحظية',         icon: Activity     },
                  { key: 'notifications_enabled', label: 'إشعارات لوحة التحكم',        desc: 'إشعارات داخلية عند كل تطابق',            icon: Bell         },
                  { key: 'sound_enabled',         label: 'تنبيه صوتي',                 desc: 'تشغيل صوت عند كل تنبيه جديد',            icon: Volume2      },
                ] as const).map(opt => (
                  <div key={opt.key} className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-xl bg-[var(--bg-elevated)] flex items-center justify-center">
                        <opt.icon className="w-4 h-4 text-[var(--brand-primary)]" />
                      </div>
                      <div>
                        <p className="text-sm font-medium">{opt.label}</p>
                        <p className="text-xs text-[var(--text-muted)]">{opt.desc}</p>
                      </div>
                    </div>
                    <button onClick={() => setSettings(p => ({ ...p, [opt.key]: !p[opt.key] }))}
                      className={cn('w-12 h-6 rounded-full relative transition-colors',
                        settings[opt.key] ? 'bg-[var(--brand-primary)]' : 'bg-[var(--bg-elevated)]')}>
                      <div className={cn('absolute top-1 w-4 h-4 rounded-full bg-white shadow transition-all',
                        settings[opt.key] ? 'left-7' : 'left-1')} />
                    </button>
                  </div>
                ))}

                <div>
                  <label className="block text-sm font-medium mb-1.5 text-[var(--text-secondary)]">مدة الاحتفاظ بالسجلات</label>
                  <div className="flex items-center gap-3">
                    <input type="range" min="7" max="365" step="7"
                      value={settings.log_retention_days}
                      onChange={e => setSettings(p => ({ ...p, log_retention_days: +e.target.value }))}
                      className="flex-1" />
                    <span className="text-sm font-bold text-[var(--brand-primary)] w-16 text-center">
                      {settings.log_retention_days} يوم
                    </span>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Button onClick={saveSettings} className="w-full gap-2">
              <Save className="w-4 h-4" /> حفظ الإعدادات
            </Button>
          </div>
        )}

        {/* ── Activity Log Tab ── */}
        {tab === 'log' && (
          <div className="space-y-3">
            {activityLog.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 text-[var(--text-muted)]">
                <History className="w-12 h-12 mb-4 opacity-30" />
                <p className="font-medium">لا توجد سجلات</p>
              </div>
            ) : (
              activityLog.map((log, i) => (
                <div key={log.id || i} className="flex items-start gap-4 bg-[var(--bg-surface)] border border-[var(--border-default)] rounded-xl p-4">
                  <div className="w-8 h-8 rounded-lg bg-[var(--bg-elevated)] flex items-center justify-center shrink-0">
                    <History className="w-4 h-4 text-[var(--brand-primary)]" />
                  </div>
                  <div className="flex-1">
                    <p className="text-sm font-medium">{log.details}</p>
                    <p className="text-xs text-[var(--text-muted)] mt-0.5">{fmtDate(log.created_at)}</p>
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {/* Modals */}
      {replyAlert && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="bg-[var(--bg-surface)] border border-[var(--border-default)] rounded-2xl w-full max-w-md shadow-[var(--shadow-elevated)] p-5" dir="rtl">
            <div className="flex items-center justify-between mb-4"><h3 className="font-bold flex items-center gap-2"><MessageSquare className="w-4 h-4 text-[var(--brand-primary)]" /> الرد على الخاص</h3><button onClick={() => setReplyAlert(null)}><X className="w-4 h-4 text-[var(--text-muted)]" /></button></div>
            <div className="rounded-xl bg-[var(--bg-elevated)] p-3 text-sm space-y-1 mb-4"><p>المستلم: <b dir="ltr">{replyAlert.sender_phone}</b></p><p>الحساب المستلم: <b>{replyAlert.account_name || replyAlert.account_id}</b></p><p className="text-xs text-[var(--text-muted)]" dir="auto">{replyAlert.message_text}</p></div>
            <textarea autoFocus rows={5} className="w-full bg-[var(--bg-elevated)] border border-[var(--border-default)] rounded-xl p-3 text-sm resize-none" placeholder="اكتب الرد..." value={replyBody} onChange={e => setReplyBody(e.target.value)} dir="auto" />
            <div className="flex gap-2 mt-4"><Button className="flex-1 gap-2" disabled={!replyBody.trim() || replySending} onClick={sendReply}>{replySending ? <RefreshCw className="w-4 h-4 animate-spin" /> : <MessageSquare className="w-4 h-4" />} إرسال الرد</Button><Button variant="outline" onClick={() => setReplyAlert(null)}>إلغاء</Button></div>
          </div>
        </div>
      )}
      {kwModal !== null && (
        <KeywordFormModal
          kw={kwModal === 'new' ? null : kwModal}
          onSave={saveKeyword}
          onClose={() => setKwModal(null)}
        />
      )}
      {detailAlert && (
        <AlertDetailModal
          alert={detailAlert}
          onClose={() => setDetailAlert(null)}
          onAction={(type, payload) => alertAction(detailAlert, type, payload)}
        />
      )}
    </div>
  );
}
