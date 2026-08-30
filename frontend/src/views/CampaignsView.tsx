import React, { useState, useEffect, useCallback } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Progress } from '@/components/ui/progress';
import { StatCard } from '@/components/ui/stat-card';
import { EmptyState } from '@/components/ui/empty-state';
import { Alert } from '@/components/ui/alert';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import { Play, Pause, Trash2, Plus, Megaphone, Smartphone, Check, Loader2, ListChecks, Users, Send } from 'lucide-react';
import { cn } from '@/utils/cn';
import { authFetch, API } from '@/utils/api';

interface Campaign {
  id: string;
  name: string;
  status: string;
  total_targets: number;
  sent_count: number;
  failed_count: number;
  ad_library_id?: string;
  created_at: string;
}

interface Ad { id: string; name: string; content: string; }
interface Group { id: string; name: string; participants_count?: number; }

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; variant: 'success' | 'info' | 'warning' | 'secondary' | 'soft' | 'danger' }> = {
    active:    { label: 'نشطة',    variant: 'success' },
    running:   { label: 'تعمل',    variant: 'info' },
    paused:    { label: 'متوقفة',  variant: 'warning' },
    completed: { label: 'مكتملة',  variant: 'secondary' },
    draft:     { label: 'مسودة',   variant: 'soft' },
    pending:   { label: 'معلقة',   variant: 'soft' },
    failed:    { label: 'فشلت',    variant: 'danger' },
  };
  const cfg = map[status] || { label: status, variant: 'secondary' as const };
  return <Badge variant={cfg.variant} dot>{cfg.label}</Badge>;
}

export default function CampaignsView({ accountId }: { accountId: string | null }) {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [ads, setAds] = useState<Ad[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(false);
  const [isWizardOpen, setIsWizardOpen] = useState(false);
  const [step, setStep] = useState(1);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const [form, setForm] = useState({
    name: '',
    ad_library_id: '',
    target_type: 'group_members' as 'group_members',
    target_ids: [] as string[],
    batch_size: 10,
    interval_seconds: 15,
    daily_limit: 500,
    exclude_admins: true,
    exclude_duplicates: true,
  });

  const loadData = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    try {
      const [campRes, adRes, grpRes] = await Promise.all([
        authFetch(`${API}/accounts/${accountId}/campaigns`),
        authFetch(`${API}/accounts/${accountId}/ads`),
        authFetch(`${API}/accounts/${accountId}/groups`),
      ]);
      const [campData, adData, grpData] = await Promise.all([campRes.json(), adRes.json(), grpRes.json()]);
      if (campData.success) setCampaigns(campData.campaigns || []);
      if (adData.success) setAds(adData.ads || []);
      if (grpData.success) setGroups(grpData.groups || []);
    } catch (e) {
      console.error('[Campaigns] loadData error:', e);
    } finally {
      setLoading(false);
    }
  }, [accountId]);

  useEffect(() => { loadData(); }, [loadData]);

  useEffect(() => {
    if (!campaigns.some(c => ['active', 'running'].includes(c.status))) return;
    const timer = window.setInterval(loadData, 5000);
    return () => window.clearInterval(timer);
  }, [campaigns, loadData]);

  const handleCreateCampaign = async () => {
    if (!accountId) return;
    if (!form.name.trim()) { setError('اسم الحملة مطلوب'); return; }
    if (!form.ad_library_id) { setError('يجب اختيار إعلان'); return; }
    if (form.target_ids.length === 0) { setError('يجب اختيار مجموعة واحدة على الأقل'); return; }
    setSaving(true);
    setError('');
    try {
      const res = await authFetch(`${API}/accounts/${accountId}/campaigns`, {
        method: 'POST',
        body: JSON.stringify({
          name: form.name,
          adLibraryId: form.ad_library_id,
          targetType: form.target_type,
          targetIds: form.target_ids,
          batchSize: form.batch_size,
          intervalSeconds: form.interval_seconds,
          dailyLimit: form.daily_limit,
          excludeAdmins: form.exclude_admins,
          excludeDuplicates: form.exclude_duplicates,
        }),
      });
      const data = await res.json();
      if (data.success && data.campaignId) {
        // The CTA is "Launch", so creation and queueing are one user action.
        const startRes = await authFetch(`${API}/accounts/${accountId}/campaigns/${data.campaignId}/start`, {
          method: 'POST',
        });
        const startData = await startRes.json();
        if (!startRes.ok || !startData.success) {
          throw new Error(startData.error || 'تم إنشاء الحملة لكن تعذّر تشغيلها');
        }
        setIsWizardOpen(false);
        setStep(1);
        setForm({ name: '', ad_library_id: '', target_type: 'group_members', target_ids: [], batch_size: 10, interval_seconds: 15, daily_limit: 500, exclude_admins: true, exclude_duplicates: true });
        await loadData();
      } else {
        setError(data.error || 'حدث خطأ أثناء إنشاء الحملة');
      }
    } catch (e: any) {
      setError(e.message || 'حدث خطأ أثناء إطلاق الحملة');
    } finally {
      setSaving(false);
    }
  };

  const handlePause = async (id: string) => {
    if (!accountId) return;
    const res = await authFetch(`${API}/accounts/${accountId}/campaigns/${id}/pause`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok || !data.success) { setError(data.error || 'تعذّر إيقاف الحملة'); return; }
    await loadData();
  };

  const handleStart = async (id: string) => {
    if (!accountId) return;
    const res = await authFetch(`${API}/accounts/${accountId}/campaigns/${id}/start`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok || !data.success) { setError(data.error || 'تعذّر تشغيل الحملة'); return; }
    await loadData();
  };

  const handleDelete = async (id: string) => {
    if (!accountId || !confirm('هل تريد حذف هذه الحملة؟')) return;
    const res = await authFetch(`${API}/accounts/${accountId}/campaigns/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok || !data.success) { setError(data.error || 'تعذّر حذف الحملة'); return; }
    setCampaigns(prev => prev.filter(c => c.id !== id));
  };

  const toggleGroup = (id: string) => {
    setForm(f => ({
      ...f,
      target_ids: f.target_ids.includes(id) ? f.target_ids.filter(x => x !== id) : [...f.target_ids, id],
    }));
  };

  if (!accountId) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center p-8 rounded-2xl border-2 border-dashed border-[var(--border-default)] max-w-sm">
          <Smartphone className="w-12 h-12 text-[var(--text-muted)] mx-auto mb-4" />
          <h3 className="text-lg font-bold text-[var(--text-primary)]">الرجاء اختيار حساب</h3>
          <p className="text-sm text-[var(--text-secondary)] mt-2">يجب اختيار حساب واتساب نشط من الشريط العلوي لعرض وإدارة الحملات الخاصة به.</p>
        </div>
      </div>
    );
  }

  const total = campaigns.length;
  const active = campaigns.filter(c => ['active', 'running'].includes(c.status)).length;
  const paused = campaigns.filter(c => c.status === 'paused').length;
  const completed = campaigns.filter(c => c.status === 'completed').length;

  return (
    <div className="flex flex-col gap-6 h-full">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold text-[var(--text-primary)]">الحملات</h1>
          <p className="text-[var(--text-secondary)] mt-1">إدارة حملات الإرسال الجماعي</p>
        </div>
        <Button onClick={() => { setStep(1); setError(''); setIsWizardOpen(true); }}>
          <Plus className="w-4 h-4" />
          <span>حملة جديدة</span>
        </Button>
      </div>

      {error && !isWizardOpen && <Alert variant="danger" onDismiss={() => setError('')}>{error}</Alert>}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard title="إجمالي الحملات" value={total} icon={Megaphone} color="var(--info)" />
        <StatCard title="نشطة" value={active} icon={Play} color="var(--success)" />
        <StatCard title="متوقفة" value={paused} icon={Pause} color="var(--warning)" />
        <StatCard title="مكتملة" value={completed} icon={Check} color="var(--text-muted)" />
      </div>

      <Card className="card flex-1 overflow-hidden flex flex-col">
        <div className="flex-1 overflow-auto">
          {loading ? (
            <div className="flex items-center justify-center p-12">
              <Loader2 className="w-8 h-8 animate-spin text-[var(--brand-primary)]" />
            </div>
          ) : campaigns.length === 0 ? (
            <EmptyState
              icon={Megaphone}
              title="لا توجد حملات بعد"
              description="أنشئ حملتك الأولى لبدء الإرسال الجماعي لمجموعاتك المستهدفة."
              actionLabel="إنشاء حملة"
              onAction={() => { setStep(1); setIsWizardOpen(true); }}
            />
          ) : (
            <Table>
              <TableHeader className="bg-[var(--bg-elevated)] sticky top-0 z-10 shadow-sm">
                <TableRow className="border-[var(--border-default)] hover:bg-transparent">
                  <TableHead className="text-right py-4 font-semibold text-[var(--text-primary)]">اسم الحملة</TableHead>
                  <TableHead className="text-right py-4 font-semibold text-[var(--text-primary)]">المستهدفون</TableHead>
                  <TableHead className="text-right py-4 font-semibold text-[var(--text-primary)]">المُرسَل</TableHead>
                  <TableHead className="text-right py-4 font-semibold text-[var(--text-primary)]">التقدم</TableHead>
                  <TableHead className="text-right py-4 font-semibold text-[var(--text-primary)]">الحالة</TableHead>
                  <TableHead className="text-right py-4 font-semibold text-[var(--text-primary)]">الإجراءات</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {campaigns.map(camp => {
                  const progress = camp.total_targets > 0 ? Math.round((camp.sent_count / camp.total_targets) * 100) : 0;
                  return (
                    <TableRow key={camp.id} className="border-[var(--border-default)] group">
                      <TableCell className="font-medium text-[var(--text-primary)] py-4">
                        <div className="flex items-center gap-3">
                          <div className="w-8 h-8 rounded-lg bg-[var(--bg-elevated)] flex items-center justify-center text-[var(--brand-primary)]">
                            <Megaphone className="w-4 h-4" />
                          </div>
                          {camp.name}
                        </div>
                      </TableCell>
                      <TableCell className="text-[var(--text-secondary)]">{camp.total_targets.toLocaleString()}</TableCell>
                      <TableCell className="text-[var(--text-secondary)]">{camp.sent_count.toLocaleString()}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Progress value={progress} className="w-24" />
                          <span className="text-xs text-[var(--text-muted)] w-8">{progress}%</span>
                        </div>
                      </TableCell>
                      <TableCell><StatusBadge status={camp.status} /></TableCell>
                      <TableCell>
                        <div className="flex gap-1 opacity-50 group-hover:opacity-100 transition-opacity">
                          {!['active', 'running', 'completed'].includes(camp.status) && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 text-[var(--success)] hover:text-[var(--success)] hover:bg-[var(--success-bg)]"
                              onClick={() => handleStart(camp.id)}
                              aria-label="بدء الحملة"
                            >
                              <Play className="w-4 h-4" />
                            </Button>
                          )}
                          {['active', 'running'].includes(camp.status) && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 text-[var(--warning)] hover:text-[var(--warning)] hover:bg-[var(--warning-bg)]"
                              onClick={() => handlePause(camp.id)}
                              aria-label="إيقاف الحملة مؤقتًا"
                            >
                              <Pause className="w-4 h-4" />
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-[var(--danger)] hover:text-[var(--danger)] hover:bg-[var(--danger-bg)]"
                            onClick={() => handleDelete(camp.id)}
                            aria-label="حذف الحملة"
                          >
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </div>
      </Card>

      {/* Wizard */}
      <Dialog open={isWizardOpen} onOpenChange={v => { if (!saving) { setIsWizardOpen(v); if (!v) setStep(1); } }}>
        <DialogContent className="sm:max-w-2xl min-h-[500px] flex flex-col">
          <DialogHeader>
            <DialogTitle>حملة جديدة</DialogTitle>
          </DialogHeader>

          <div className="flex items-center justify-center gap-2 py-4">
            {[
              { n: 1, label: 'الإعلان' },
              { n: 2, label: 'المجموعات' },
              { n: 3, label: 'القواعد' },
              { n: 4, label: 'الإرسال' },
            ].map(({ n: s, label }) => (
              <React.Fragment key={s}>
                <div className="flex flex-col items-center gap-1.5">
                  <div className={cn('w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold transition-colors',
                    step === s ? 'bg-[var(--brand-primary)] text-white shadow-[var(--shadow-glow)]'
                    : step > s ? 'bg-[var(--brand-primary-light)] text-[var(--brand-primary)]'
                    : 'bg-[var(--bg-elevated)] text-[var(--text-muted)]')}>
                    {step > s ? <Check className="w-4 h-4" /> : s}
                  </div>
                  <span className={cn('text-[10px] font-medium', step === s ? 'text-[var(--brand-primary)]' : 'text-[var(--text-muted)]')}>
                    {label}
                  </span>
                </div>
                {s < 4 && <div className={cn('w-12 h-1 rounded-full transition-colors mb-4', step > s ? 'bg-[var(--brand-primary-light)]' : 'bg-[var(--bg-elevated)]')} />}
              </React.Fragment>
            ))}
          </div>

          <div className="flex-1 overflow-auto py-2">
            {step === 1 && (
              <div className="flex flex-col gap-4 animate-fade-in">
                <div className="flex flex-col gap-2">
                  <label htmlFor="campaign-name" className="text-sm font-medium">اسم الحملة <span className="text-[var(--danger)]">*</span></label>
                  <input
                    id="campaign-name"
                    className="input"
                    placeholder="أدخل اسماً مميزاً للحملة..."
                    value={form.name}
                    onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  />
                </div>
                <div className="flex flex-col gap-2 mt-4">
                  <label className="text-sm font-medium">اختر الإعلان من المكتبة <span className="text-[var(--danger)]">*</span></label>
                  {ads.length === 0 ? (
                    <Alert variant="warning">لا توجد إعلانات. أضف إعلاناً من مكتبة الإعلانات أولاً.</Alert>
                  ) : (
                    <div className="grid grid-cols-2 gap-3 max-h-64 overflow-auto">
                      {ads.map(ad => (
                        <div
                          key={ad.id}
                          onClick={() => setForm(f => ({ ...f, ad_library_id: ad.id }))}
                          className={cn('border rounded-xl p-4 cursor-pointer transition-colors', form.ad_library_id === ad.id
                            ? 'border-[var(--brand-primary)] bg-[var(--brand-primary-light)]'
                            : 'border-[var(--border-default)] hover:border-[var(--brand-primary)]'
                          )}
                        >
                          <div className="font-bold text-[var(--text-primary)]">{ad.name}</div>
                          <p className="text-xs text-[var(--text-muted)] mt-1 line-clamp-2">{ad.content}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
            {step === 2 && (
              <div className="flex flex-col gap-4 animate-fade-in">
                <h3 className="font-bold text-[var(--text-primary)]">اختيار المجموعات المستهدفة</h3>
                <div className="border border-[var(--border-default)] rounded-xl overflow-auto max-h-72">
                  {groups.length === 0 ? (
                    <p className="p-4 text-sm text-[var(--text-muted)]">لا توجد مجموعات</p>
                  ) : groups.map(g => (
                    <label key={g.id} className="flex items-center gap-3 p-3 border-b border-[var(--border-default)] last:border-0 hover:bg-[var(--bg-elevated)] cursor-pointer">
                      <Checkbox
                        checked={form.target_ids.includes(g.id)}
                        onCheckedChange={() => toggleGroup(g.id)}
                        aria-label={`اختيار مجموعة ${g.name}`}
                      />
                      <div className="flex-1">
                        <p className="font-medium text-[var(--text-primary)]">{g.name}</p>
                        {g.participants_count !== undefined && <p className="text-xs text-[var(--text-muted)]">{g.participants_count} عضو</p>}
                      </div>
                    </label>
                  ))}
                </div>
              </div>
            )}
            {step === 3 && (
              <div className="flex flex-col gap-6 animate-fade-in">
                <h3 className="font-bold text-[var(--text-primary)]">قواعد الاستبعاد والإرسال</h3>
                <div className="flex flex-col gap-4">
                  <div className="flex items-center justify-between p-4 border border-[var(--border-default)] rounded-xl bg-[var(--bg-elevated)]">
                    <div>
                      <p className="font-medium text-[var(--text-primary)]">استبعاد المشرفين</p>
                      <p className="text-xs text-[var(--text-muted)] mt-1">لا ترسل رسائل لمشرفي المجموعات.</p>
                    </div>
                    <Switch
                      checked={form.exclude_admins}
                      onCheckedChange={v => setForm(f => ({ ...f, exclude_admins: v }))}
                      aria-label="استبعاد المشرفين"
                    />
                  </div>
                  <div className="flex items-center justify-between p-4 border border-[var(--border-default)] rounded-xl bg-[var(--bg-elevated)]">
                    <div>
                      <p className="font-medium text-[var(--text-primary)]">منع التكرار</p>
                      <p className="text-xs text-[var(--text-muted)] mt-1">إرسال رسالة واحدة فقط للرقم حتى لو تواجد في عدة مجموعات.</p>
                    </div>
                    <Switch
                      checked={form.exclude_duplicates}
                      onCheckedChange={v => setForm(f => ({ ...f, exclude_duplicates: v }))}
                      aria-label="منع التكرار"
                    />
                  </div>
                </div>
              </div>
            )}
            {step === 4 && (
              <div className="flex flex-col gap-6 animate-fade-in">
                <h3 className="font-bold text-[var(--text-primary)]">إعدادات الإرسال للحماية</h3>
                <div className="grid grid-cols-2 gap-4">
                  <div className="flex flex-col gap-2">
                    <label htmlFor="interval-seconds" className="text-sm font-medium">الفاصل بين الرسائل (ثانية)</label>
                    <select
                      id="interval-seconds"
                      className="input"
                      value={form.interval_seconds}
                      onChange={e => setForm(f => ({ ...f, interval_seconds: Number(e.target.value) }))}
                    >
                      <option value={10}>10 ثواني (سريع)</option>
                      <option value={15}>15 ثانية (موصى به)</option>
                      <option value={30}>30 ثانية (آمن)</option>
                      <option value={60}>60 ثانية (أكثر أماناً)</option>
                    </select>
                  </div>
                  <div className="flex flex-col gap-2">
                    <label htmlFor="daily-limit" className="text-sm font-medium">الحد الأقصى اليومي</label>
                    <input
                      id="daily-limit"
                      className="input"
                      type="number"
                      value={form.daily_limit}
                      onChange={e => setForm(f => ({ ...f, daily_limit: Number(e.target.value) }))}
                    />
                  </div>
                </div>
                {error && <Alert variant="danger" onDismiss={() => setError('')}>{error}</Alert>}
              </div>
            )}
          </div>

          <div className="flex justify-between mt-auto pt-4 border-t border-[var(--border-default)]">
            <Button variant="outline" onClick={() => step > 1 ? setStep(step - 1) : setIsWizardOpen(false)} disabled={saving}>
              {step > 1 ? 'السابق' : 'إلغاء'}
            </Button>
            <Button
              onClick={() => step < 4 ? setStep(step + 1) : handleCreateCampaign()}
              disabled={saving || (step === 1 && (!form.name.trim() || !form.ad_library_id)) || (step === 2 && form.target_ids.length === 0)}
            >
              {saving ? <><Loader2 className="w-4 h-4 animate-spin ml-2" />جارٍ إطلاق الحملة...</> : step < 4 ? 'التالي' : 'إطلاق الحملة'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
