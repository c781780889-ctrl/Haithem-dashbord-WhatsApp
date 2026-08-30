import { useRef, useState } from 'react';
import { CheckCircle2, Eye, FileText, FileUp, Loader2, Upload, X } from 'lucide-react';
import { useToast } from './ui/ToastProvider';
import { importTelegramLinkFile, previewTelegramLinkFile, type TelegramImportPreview, type TelegramImportResult } from '@/utils/telegramLinkImport';

type Props = { onSaved?: () => void | Promise<void> };

export default function TelegramWordImportPanel({ onSaved }: Props) {
  const { addToast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<TelegramImportPreview | null>(null);
  const [result, setResult] = useState<TelegramImportResult | null>(null);
  const [busy, setBusy] = useState<'preview' | 'save' | null>(null);
  const [error, setError] = useState('');

  function chooseFile(selected?: File) { if (!selected) return; setFile(selected); setPreview(null); setResult(null); setError(''); }
  async function previewFile() {
    if (!file) { setError('اختر ملفًا للاستيراد أولًا.'); return; }
    setBusy('preview'); setError(''); setResult(null);
    try { setPreview(await previewTelegramLinkFile(file)); }
    catch (exception: any) { setError(exception?.message || 'تعذر معاينة الملف'); addToast({ title: exception?.message || 'تعذر معاينة الملف', type: 'error' }); }
    finally { setBusy(null); }
  }
  async function saveFile() {
    if (!file || !preview) return;
    setBusy('save'); setError('');
    try { const saved = await importTelegramLinkFile(file, globalThis.crypto?.randomUUID?.() || `telegram-file-${Date.now()}`); setResult(saved); await onSaved?.(); addToast({ title: `تم حفظ ${saved.saved} رابط جديد فقط`, type: 'success' }); }
    catch (exception: any) { setError(exception?.message || 'تعذر حفظ الروابط'); addToast({ title: exception?.message || 'تعذر حفظ الروابط', type: 'error' }); }
    finally { setBusy(null); }
  }
  function reset() { setFile(null); setPreview(null); setResult(null); setError(''); if (fileRef.current) fileRef.current.value = ''; }

  return <section className="rounded-3xl border border-emerald-400/25 bg-gradient-to-br from-emerald-500/10 via-[var(--bg-elevated)] to-cyan-500/5 p-5 shadow-[var(--shadow-card)] sm:p-6">
    <div className="flex flex-wrap items-start justify-between gap-4"><div className="flex items-start gap-3"><div className="rounded-2xl bg-emerald-400/15 p-3 text-emerald-300"><FileText className="h-6 w-6" /></div><div><h2 className="text-lg font-black">استيراد روابط تيليجرام من ملف Word</h2><p className="mt-1 max-w-3xl text-xs leading-5 text-[var(--text-muted)]">اختر ملفًا من ذاكرة الهاتف بصيغة DOC أو DOCX أو TXT أو CSV أو JSON. تتم المعاينة أولًا دون حفظ أو تشغيل انضمام.</p></div></div><input ref={fileRef} hidden type="file" accept=".doc,.docx,.txt,.csv,.json,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/csv,application/json" onChange={event => chooseFile(event.target.files?.[0])} /><button type="button" onClick={() => fileRef.current?.click()} disabled={!!busy} className="inline-flex items-center gap-2 rounded-xl bg-emerald-400 px-4 py-2.5 text-sm font-black text-slate-950 disabled:opacity-50"><FileUp className="h-4 w-4" />اختيار ملف من الهاتف</button></div>
    <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-end"><div className="min-w-0 flex-1 rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] px-3 py-2.5 text-xs">{file ? <><p className="truncate font-bold">{file.name}</p><p className="mt-1 text-[var(--text-muted)]">{(file.size / 1024).toFixed(1)} ك.ب · جاهز للمعاينة</p></> : <p className="text-[var(--text-muted)]">لم يتم اختيار ملف</p>}</div><button type="button" onClick={previewFile} disabled={!!busy || !file} className="inline-flex items-center justify-center gap-2 rounded-xl bg-cyan-400 px-4 py-2.5 text-xs font-black text-slate-950 disabled:opacity-40">{busy === 'preview' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Eye className="h-4 w-4" />}استيراد ومراجعة</button></div>
    {error && <p className="mt-4 rounded-xl border border-rose-400/20 bg-rose-500/5 p-3 text-xs leading-5 text-rose-200">{error}</p>}
    {preview && <div className="mt-4 rounded-2xl border border-cyan-400/20 bg-cyan-500/5 p-4"><div className="flex items-center gap-2 text-sm font-black"><Eye className="h-4 w-4 text-cyan-300" />معاينة بدون حفظ أو انضمام</div><div className="mt-3 grid grid-cols-2 gap-2 text-center text-xs sm:grid-cols-5"><span className="rounded-xl bg-[var(--bg-surface)] p-2"><b className="block text-lg text-cyan-200">{preview.total}</b>إجمالي</span><span className="rounded-xl bg-[var(--bg-surface)] p-2"><b className="block text-lg text-emerald-200">{preview.newCount}</b>جديدة</span><span className="rounded-xl bg-[var(--bg-surface)] p-2"><b className="block text-lg text-amber-200">{preview.existingCount + preview.duplicateInFile}</b>مكررة</span><span className="rounded-xl bg-[var(--bg-surface)] p-2"><b className="block text-lg text-rose-200">{preview.invalidCount}</b>غير صالحة</span><span className="rounded-xl bg-[var(--bg-surface)] p-2"><b className="block text-lg text-sky-200">{preview.uniqueCount}</b>فريدة</span></div><div className="mt-3 max-h-44 overflow-auto rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)]">{preview.items.slice(0, 100).map((item, index) => <div key={`${item.originalUrl}-${index}`} className="flex items-center justify-between gap-2 border-b border-[var(--border-default)] px-3 py-2 text-[11px] last:border-0"><span className="min-w-0 truncate font-mono" dir="ltr">{item.originalUrl}</span><span className={item.status === 'new' ? 'shrink-0 text-emerald-300' : item.status === 'existing' ? 'shrink-0 text-amber-300' : 'shrink-0 text-rose-300'}>{item.reason}</span></div>)}</div><div className="mt-4 flex flex-wrap justify-end gap-2"><button type="button" onClick={reset} disabled={!!busy} className="inline-flex items-center gap-1 rounded-xl border border-[var(--border-default)] px-3 py-2 text-xs font-bold"><X className="h-4 w-4" />إلغاء</button><button type="button" onClick={saveFile} disabled={!!busy || !preview.newCount} className="inline-flex items-center gap-2 rounded-xl bg-emerald-400 px-4 py-2 text-xs font-black text-slate-950 disabled:opacity-40">{busy === 'save' ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}تأكيد حفظ {preview.newCount} رابط</button></div></div>}
    {result && <p className="mt-3 rounded-xl border border-emerald-400/20 bg-emerald-500/5 p-3 text-xs font-bold text-emerald-200">تم الحفظ فقط، ولم يتم تشغيل الانضمام تلقائيًا. الجديد: {result.saved} · المكرر: {result.duplicates} · غير الصالح: {result.invalid}</p>}
  </section>;
}
