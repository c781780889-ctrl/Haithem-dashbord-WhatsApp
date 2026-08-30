import { API, authFetch } from '@/utils/api';

export type LinkImportItem = {
  originalUrl: string;
  normalizedUrl: string | null;
  status: 'new' | 'existing' | 'invalid' | 'unsupported';
  reason: string;
};

export type LinkImportPreview = {
  filename: string;
  fileSizeBytes: number;
  total: number;
  uniqueCount: number;
  duplicateInFile: number;
  existingCount: number;
  invalidCount: number;
  reviewCount: number;
  newCount: number;
  items: LinkImportItem[];
  previewTruncated?: boolean;
};

export type LinkImportSummary = LinkImportPreview & {
  sourceId?: string;
  validCount?: number;
  duplicateCount?: number;
  processingMs?: number;
  status?: string;
};

export type LinkImportSource = {
  id: string;
  filename: string;
  file_size_bytes: number;
  total_found: number;
  new_count: number;
  duplicate_count: number;
  invalid_count: number;
  review_count: number;
  processing_ms?: number;
  status: string;
  created_at: string;
};

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const ALLOWED_EXTENSIONS = ['.doc', '.docx', '.txt', '.csv', '.json', '.xlsx'];

function assertSupportedFile(file: File) {
  const name = file.name.toLowerCase();
  if (!ALLOWED_EXTENSIONS.some(extension => name.endsWith(extension))) {
    throw new Error('صيغة الملف غير مدعومة. استخدم DOC أو DOCX أو TXT أو CSV أو JSON أو XLSX');
  }
  if (file.size > MAX_FILE_BYTES) throw new Error('حجم الملف يتجاوز الحد المسموح 10MB');
}

async function fileToBase64(file: File) {
  const buffer = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < buffer.length; offset += 0x8000) {
    binary += String.fromCharCode(...buffer.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

async function postFile(file: File, endpoint: string, requestId?: string) {
  assertSupportedFile(file);
  const response = await authFetch(`${API}${endpoint}`, {
    method: 'POST',
    headers: requestId ? { 'Idempotency-Key': requestId } : undefined,
    body: JSON.stringify({ filename: file.name, contentBase64: await fileToBase64(file) }),
  });
  const data = await response.json();
  if (!response.ok || !data.success) throw new Error(data.error || 'تعذر قراءة ملف الروابط');
  return data;
}

export async function previewLinkFile(file: File): Promise<LinkImportPreview> {
  const data = await postFile(file, '/whatsapp/link-import/preview');
  return data.preview || { filename: file.name, fileSizeBytes: file.size, total: 0, uniqueCount: 0, duplicateInFile: 0, existingCount: 0, invalidCount: 0, reviewCount: 0, newCount: 0, items: [] };
}

export async function saveLinkFile(file: File, requestId?: string): Promise<LinkImportSummary> {
  const data = await postFile(file, '/whatsapp/link-import/save', requestId);
  return data.summary || { filename: file.name, fileSizeBytes: file.size, total: 0, uniqueCount: 0, duplicateInFile: 0, existingCount: 0, invalidCount: 0, reviewCount: 0, newCount: 0, items: [] };
}

export async function listImportSources(): Promise<LinkImportSource[]> {
  const response = await authFetch(`${API}/whatsapp/link-import/sources?limit=50`);
  const data = await response.json();
  if (!response.ok || !data.success) throw new Error(data.error || 'تعذر تحميل سجل الاستيراد');
  return data.sources || [];
}

export const importLinkFile = saveLinkFile;
export const importWordLinks = saveLinkFile;
