import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, CheckCircle2, Eye, FileText, FileUp, History, Loader2, RefreshCw, Save, Search, X } from 'lucide-react';
import { API, authFetch } from '@/utils/api';
import { cn } from '@/utils/cn';
import { useToast } from './ui/ToastProvider';
import { listImportSources, previewLinkFile, saveLinkFile, type LinkImportPreview, type LinkImportSource } from '@/utils/linkImport';

type Props = { onSaved?: () => void | Promise<void> };
type Phase = 'idle' | 'reading' | 'analyzing' | 'ready' | 'saving' | 'done' | 'error';

const phaseLabels: Record<Phase, string> = {
  idle: 'بانتظار اختيار الملف', reading: 'قراءة الملف بالكامل…', analyzing: 'استخراج الروابط وتنظيفها ومقارنتها…', ready: 'اكتملت المعاينة، راجع النتائج قبل الحفظ', saving: 'حفظ الروابط الجديدة داخل أتمتة الانضمام…', done: 'اكتمل الحفظ بنجاح', error: 'تعذر إكمال الاستيراد',
};
const statusLabels = { new: 'جديد', existing: 'موجود مسبقًا', invalid: 'غير صالح', unsupported: 'يحتاج مراجعة' } as const;

function formatBytes(bytes: number) {
  if (!bytes) return '0 بايت';
  const units = ['بايت', 'ك.ب', 'م.ب'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}
function formatDate(value?: string | number) {
  if (!value) return 'غير متوفر';
  return new Date(value).toLocaleString('ar-SA', { dateStyle: 'short', timeStyle: 'short' });
}
function statusStyle(status: string) {
  return status === 'new' ? 'border-emerald-400/25 bg-emerald-400/10 text-emerald-200' : status === 'existing' ? 'border-amber-400/25 bg-amber-400/10 text-amber-200' : 'border-rose-400/25 bg-rose-400/10 text-rose-200';
}

export default function JoinAutomationImportPanel({ onSaved }: Props) {
  const { addToast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<LinkImportPreview | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState('');
  const [previewSearch, setPreviewSearch] = useState('');
  const [previewStatus, setPreviewStatus] = useState('all');
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState<LinkImportSource[]>([]);
  const importRequestIdRef = useRef<string | null>(null);

  const loadHistory = useCallback(async () => {
    try { setHistory(await listImportSources()); } catch { /* history is supplementary to importing */ }
  }, []);
  useEffect(() => { loadHistory(); }, [loadHistory]);

  const analyze = useCallback(async (selectedFile: File) => {
    setFile(selectedFile);
    setPreview(null);
    setError('');
    setPhase('reading');
    try {
      setPhase('analyzing');
      const result = await previewLinkFile(selectedFile);
      setPreview(result);
      setPhase('ready');
    } catch (exception: any) {
      setPhase('error');
      setError(exception?.message || 'تعذر تحليل الملف');
      addToast({ title: exception?.message || 'تعذر تحليل الملف', type: 'error' });
    }
  }, [addToast]);

  function chooseFile(selectedFile?: File) {
    if (!selectedFile) return;
    const name = selectedFile.name.toLowerCase();
    if (!['.doc', '.docx', '.txt', '.csv', '.json', '.xlsx'].some(extension => name.endsWith(extension))) {
      setPhase('error');
      setError('نوع الملف غير مدعوم. اختر DOC أو DOCX أو TXT أو CSV أو JSON أو XLSX.');
      return;
    }
    analyze(selectedFile);
  }

  async function save() {
    if (!file || !preview) return;
    setPhase('saving');
    setError('');
    try {
      const requestId = importRequestIdRef.current || globalThis.crypto?.randomUUID?.() || `wa-import-${Date.now()}-${Math.random()}`;
      importRequestIdRef.current = requestId;
      const summary = await saveLinkFile(file, requestId);
      importRequestIdRef.current = null;
      setPhase('done');
      setPreview(current => current ? { ...current, ...summary, items: current.items } : current);
      await loadHistory();
      await onSaved?.();
      addToast({ title: `تم حفظ ${summary.newCount || 0} رابط جديد داخل أتمتة الانضمام`, type: 'success' });
    } catch (exception: any) {
      setPhase('error');
      setError(exception?.message || 'تعذر حفظ الروابط');
      addToast({ title: exception?.message || 'تعذر حفظ الروابط', type: 'error' });
    }
  }

  function cancel() {
    setFile(null); setPreview(null); setError(''); setPhase('idle'); setPreviewSearch(''); setPreviewStatus('all');
    if (fileRef.current) fileRef.current.value = '';
  }

  const filteredItems = useMemo(() => (preview?.items || []).filter(item => {
    const matchesSearch = !previewSearch || `${item.originalUrl} ${item.normalizedUrl || ''}`.toLowerCase().includes(previewSearch.toLowerCase());
    return matchesSearch && (previewStatus === 'all' || item.status === previewStatus);
  }), [preview, previewSearch, previewStatus]);

  const busy = phase === 'reading' || phase === 'analyzing' || phase === 'saving';
  return <section className="rounded-3xl border border-emerald-400/25 bg-gradient-to-br from-emerald-500/10 via-[var(--bg-elevated)] to-cyan-500/5 p-5 shadow-[var(--shadow-card)] sm:p-6" aria-busy={busy}>
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="flex items-start gap-3">
        <div className="rounded-2xl bg-emerald-400/15 p-3 text-emerald-300"><FileText className="h-6 w-6" /></div>
        <div><h2 className="text-lg font-black">استيراد روابط واتساب من ملف</h2><p className="mt-1 max-w-3xl text-xs leading-5 text-[var(--text-muted)]">اختر ملف DOC أو DOCX أو TXT أو CSV أو JSON أو XLSX. تتم قراءة الروابط، ثم تنظيفها وتوحيدها ومقارنتها قبل الحفظ.</p></div>
      </div>
      <input ref={fileRef} hidden type="file" accept=".doc,.docx,.txt,.csv,.json,.xlsx,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/json,text/csv" onChange={event => chooseFile(event.target.files?.[0])} />
      <button type="button" onClick={() => fileRef.current?.click()} disabled={busy} className="inline-flex items-center gap-2 rounded-xl bg-emerald-400 px-4 py-2.5 text-sm font-black text-slate-950 transition hover:bg-emerald-300 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"><FileUp className="h-4 w-4" />اختيار ملف الروابط</button>
    </div>

    {(file || phase === 'error') && <div className="mt-5 rounded-2xl border border-[var(--border-default)] bg-[var(--bg-surface)] p-4">
      <div className="flex flex-wrap items-center justify-between gap-3"><div className="flex min-w-0 items-center gap-3"><FileText className="h-5 w-5 shrink-0 text-cyan-300" /><div className="min-w-0"><p className="truncate text-sm font-bold">{file?.name || 'ملف غير صالح'}</p><p className="mt-1 text-[11px] text-[var(--text-muted)]">الحجم: {file ? formatBytes(file.size) : '—'} · تاريخ الملف: {file ? formatDate(file.lastModified) : '—'}</p></div></div><span className={cn('rounded-full border px-3 py-1.5 text-xs font-bold', phase === 'error' ? 'border-rose-400/25 bg-rose-500/10 text-rose-200' : phase === 'done' ? 'border-emerald-400/25 bg-emerald-500/10 text-emerald-200' : 'border-cyan-400/25 bg-cyan-500/10 text-cyan-200')}>{phaseLabels[phase]}</span></div>
      {busy && <div className="mt-4"><div className="h-1.5 overflow-hidden rounded-full bg-[var(--bg-elevated)]"><div className="h-full w-1/3 animate-pulse rounded-full bg-cyan-400" /></div><p className="mt-2 text-[11px] text-[var(--text-muted)]">تتم متابعة مراحل المعالجة من الخادم؛ لا يتم عرض نسبة تقدّم تقديرية.</p></div>}
      {error && <p className="mt-3 rounded-xl border border-rose-400/20 bg-rose-500/5 p-3 text-xs leading-5 text-rose-200">{error}</p>}
    </div>}

    {preview && <div className="mt-5 space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {[['إجمالي المكتشف', preview.total, 'text-cyan-200'], ['الفريد بعد التنظيف', preview.uniqueCount, 'text-sky-200'], ['مكرر داخل الملف', preview.duplicateInFile, 'text-amber-200'], ['موجود مسبقًا', preview.existingCount, 'text-orange-200'], ['غير صالح', preview.invalidCount + preview.reviewCount, 'text-rose-200'], ['روابط جديدة', preview.newCount, 'text-emerald-200']].map(([label, value, tone]) => <div key={String(label)} className="rounded-2xl border border-[var(--border-default)] bg-[var(--bg-surface)] p-3"><span className="text-[11px] text-[var(--text-muted)]">{label}</span><strong className={cn('mt-1 block text-xl font-black', tone)}>{value}</strong></div>)}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="flex items-center gap-2 text-sm font-black"><Eye className="h-4 w-4 text-cyan-300" />معاينة قبل الحفظ</h3><p className="mt-1 text-[11px] text-[var(--text-muted)]">لن يتم إرسال أي رابط إلى حساب واتساب بمجرد الاستيراد؛ الحفظ يضيفها إلى قائمة أتمتة الانضمام فقط.</p></div><div className="flex flex-wrap gap-2"><label className="relative"><Search className="absolute right-2.5 top-2.5 h-3.5 w-3.5 text-[var(--text-muted)]" /><input value={previewSearch} onChange={event => setPreviewSearch(event.target.value)} placeholder="بحث في المعاينة" className="w-44 rounded-lg border border-[var(--border-default)] bg-[var(--bg-surface)] py-2 pr-8 pl-2 text-xs" dir="ltr" /></label><select value={previewStatus} onChange={event => setPreviewStatus(event.target.value)} className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-surface)] px-2 py-2 text-xs"><option value="all">كل الحالات</option><option value="new">جديد</option><option value="existing">موجود مسبقًا</option><option value="invalid">غير صالح</option><option value="unsupported">يحتاج مراجعة</option></select></div></div>
      <div className="max-h-72 overflow-auto rounded-2xl border border-[var(--border-default)]"><table className="w-full min-w-[720px] text-right text-xs"><thead className="sticky top-0 bg-[var(--bg-surface)] text-[var(--text-muted)]"><tr><th className="p-3">الحالة</th><th className="p-3">الرابط الأصلي</th><th className="p-3">الرابط الموحد</th><th className="p-3">التفاصيل</th></tr></thead><tbody>{filteredItems.length ? filteredItems.map((item, index) => <tr key={`${item.originalUrl}-${index}`} className="border-t border-[var(--border-default)]"><td className="p-3"><span className={cn('rounded-full border px-2 py-1 text-[10px] font-bold', statusStyle(item.status))}>{statusLabels[item.status]}</span></td><td className="max-w-[250px] truncate p-3 font-mono" dir="ltr">{item.originalUrl || '—'}</td><td className="max-w-[250px] truncate p-3 font-mono text-cyan-200" dir="ltr">{item.normalizedUrl || '—'}</td><td className="p-3 text-[var(--text-muted)]">{item.reason}</td></tr>) : <tr><td colSpan={4} className="p-8 text-center text-[var(--text-muted)]">لا توجد نتائج مطابقة.</td></tr>}</tbody></table></div>
      {preview.previewTruncated && <p className="text-[11px] text-amber-200">تم عرض أول 2000 نتيجة فقط للمعاينة، بينما أُحصيت جميع الروابط وسيتم حفظ الروابط الجديدة كلها.</p>}
      <div className="flex flex-wrap justify-end gap-2"><button type="button" onClick={() => file && analyze(file)} disabled={busy || !file} className="inline-flex items-center gap-2 rounded-xl border border-cyan-400/25 px-3 py-2 text-xs font-bold text-cyan-200 disabled:opacity-50"><RefreshCw className="h-4 w-4" />إعادة تحليل وتنظيف</button><button type="button" onClick={() => file && analyze(file)} disabled={busy || !file} className="inline-flex items-center gap-2 rounded-xl border border-amber-400/25 px-3 py-2 text-xs font-bold text-amber-200 disabled:opacity-50"><Check className="h-4 w-4" />إزالة التكرارات</button><button type="button" onClick={cancel} disabled={busy} className="inline-flex items-center gap-2 rounded-xl border border-rose-400/25 px-3 py-2 text-xs font-bold text-rose-200 disabled:opacity-50"><X className="h-4 w-4" />إلغاء</button><button type="button" onClick={save} disabled={busy || !preview.newCount} className="inline-flex items-center gap-2 rounded-xl bg-emerald-400 px-4 py-2 text-xs font-black text-slate-950 disabled:cursor-not-allowed disabled:opacity-40"><Save className="h-4 w-4" />حفظ {preview.newCount} رابط جديد</button></div>
    </div>}

    <div className="mt-5 border-t border-[var(--border-default)] pt-4"><button type="button" onClick={() => setShowHistory(current => !current)} className="inline-flex items-center gap-2 text-xs font-bold text-[var(--text-muted)] hover:text-cyan-200"><History className="h-4 w-4" />سجل عمليات الاستيراد <span className="rounded-full bg-[var(--bg-surface)] px-2 py-0.5">{history.length}</span></button>{showHistory && <div className="mt-3 overflow-auto rounded-2xl border border-[var(--border-default)]"><table className="w-full min-w-[720px] text-right text-xs"><thead className="bg-[var(--bg-surface)] text-[var(--text-muted)]"><tr><th className="p-3">الملف</th><th className="p-3">التاريخ</th><th className="p-3">الإجمالي</th><th className="p-3">الجديدة</th><th className="p-3">التكرارات</th><th className="p-3">غير الصالحة</th><th className="p-3">الحالة</th></tr></thead><tbody>{history.length ? history.map(item => <tr key={item.id} className="border-t border-[var(--border-default)]"><td className="p-3 font-bold">{item.filename}</td><td className="p-3 whitespace-nowrap">{formatDate(item.created_at)}</td><td className="p-3">{item.total_found}</td><td className="p-3 text-emerald-200">{item.new_count}</td><td className="p-3 text-amber-200">{item.duplicate_count}</td><td className="p-3 text-rose-200">{item.invalid_count + item.review_count}</td><td className="p-3"><span className="inline-flex items-center gap-1 text-emerald-200"><CheckCircle2 className="h-3.5 w-3.5" />{item.status === 'completed' ? 'مكتمل' : item.status}</span></td></tr>) : <tr><td colSpan={7} className="p-6 text-center text-[var(--text-muted)]">لا توجد عمليات استيراد بعد.</td></tr>}</tbody></table></div>}</div>
  </section>;
}
