import { API, authFetch } from './api';

export type TelegramImportItem = { originalUrl: string; normalizedUrl: string | null; status: 'new' | 'existing' | 'invalid'; reason: string };
export type TelegramImportPreview = { filename: string; total: number; uniqueCount: number; duplicateInFile: number; existingCount: number; invalidCount: number; newCount: number; items: TelegramImportItem[]; previewTruncated?: boolean };
export type TelegramImportResult = { saved: number; duplicates: number; invalid: number; total: number };

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const ALLOWED_EXTENSIONS = ['.doc', '.docx', '.txt', '.csv', '.json'];

async function fileToBase64(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

async function filePayload(file: File) {
  const name = file.name.toLowerCase();
  if (!ALLOWED_EXTENSIONS.some(extension => name.endsWith(extension))) throw new Error('نوع الملف غير مدعوم. اختر DOC أو DOCX أو TXT أو CSV أو JSON.');
  if (file.size > MAX_FILE_BYTES) throw new Error('حجم الملف يتجاوز الحد المسموح 10MB.');
  return { filename: file.name, format: name.endsWith('.json') ? 'json' : name.slice(name.lastIndexOf('.') + 1), contentBase64: await fileToBase64(file) };
}

export async function previewTelegramLinkFile(file: File): Promise<TelegramImportPreview> {
  const response = await authFetch(`${API}/telegram/join-automation-v2/links/preview`, { method: 'POST', body: JSON.stringify(await filePayload(file)) });
  const envelope = await response.json();
  if (!response.ok || !envelope.success) throw new Error(envelope.error?.message || envelope.error || 'تعذر معاينة الملف');
  return (envelope.data || envelope) as TelegramImportPreview;
}

export async function importTelegramLinkFile(file: File, requestId: string): Promise<TelegramImportResult> {
  const response = await authFetch(`${API}/telegram/join-automation-v2/links/import`, { method: 'POST', headers: { 'Idempotency-Key': requestId }, body: JSON.stringify(await filePayload(file)) });
  const envelope = await response.json();
  if (!response.ok || !envelope.success) throw new Error(envelope.error?.message || envelope.error || 'تعذر حفظ الروابط');
  return (envelope.data || envelope) as TelegramImportResult;
}
