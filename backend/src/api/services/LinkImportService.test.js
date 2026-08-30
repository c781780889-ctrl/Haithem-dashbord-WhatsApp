'use strict';

const AdmZip = require('adm-zip');
const XLSX = require('xlsx');
const service = require('./LinkImportService');

test('extracts and normalizes WhatsApp invite links from a real DOCX container', () => {
  const zip = new AdmZip();
  zip.addFile('word/document.xml', Buffer.from('<w:document><w:p>https://chat.whatsapp.com/ABC123</w:p><w:p>https://chat.whatsapp.com/ABC123، https://chat.whatsapp.com/XYZ789</w:p></w:document>'));
  const links = service.parseDocx(zip.toBuffer(), 'links.docx');
  const parsed = service.parseImportedLinks(links);
  expect(links).toHaveLength(3);
  expect(parsed.valid.map(item => item.canonicalUrl)).toEqual(['https://chat.whatsapp.com/ABC123', 'https://chat.whatsapp.com/XYZ789']);
  expect(parsed.duplicateInFile).toBe(1);
});

test('extracts hyperlink targets from DOCX relationships and full document text', () => {
  const zip = new AdmZip();
  zip.addFile('word/document.xml', Buffer.from('<w:document><w:body><w:p><w:hyperlink r:id="rId1"><w:r><w:t>رابط المجموعة</w:t></w:r></w:hyperlink></w:p><w:p>نص https://chat.whatsapp.com/TEXT123 داخل الفقرة</w:p></w:body></w:document>'));
  zip.addFile('word/_rels/document.xml.rels', Buffer.from('<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://chat.whatsapp.com/REL123" TargetMode="External"/></Relationships>'));
  const parsed = service.parseImportedLinks(service.parseDocx(zip.toBuffer(), 'links.docx'));
  expect(parsed.valid.map(item => item.canonicalUrl)).toEqual(expect.arrayContaining(['https://chat.whatsapp.com/REL123', 'https://chat.whatsapp.com/TEXT123']));
});

test('rejects malformed DOCX containers and accepts the .doc extension path', () => {
  expect(() => service.parseDocx(Buffer.from('not-a-doc'), 'links.docx')).toThrow('حاوية DOCX');
  expect(() => service.parseImportFile(Buffer.from('not-a-doc'), 'links.doc')).toThrow('تعذر قراءة ملف Word القديم');
});

test('separates unsupported and malformed links for review metrics', () => {
  const parsed = service.parseImportedLinks([
    'https://example.com/group',
    'https://chat.whatsapp.com/no',
  ]);
  expect(parsed.review).toHaveLength(1);
  expect(parsed.invalid).toHaveLength(1);
});

test.each([
  ['links.txt', Buffer.from('https://chat.whatsapp.com/TXT123')],
  ['links.csv', Buffer.from('name,url\nA,https://chat.whatsapp.com/CSV123')],
])('extracts links from %s', (filename, buffer) => {
  const links = service.parseImportFile(buffer, filename);
  const parsed = service.parseImportedLinks(links);
  expect(parsed.valid.map(item => item.canonicalUrl)).toContain(`https://chat.whatsapp.com/${filename.endsWith('txt') ? 'TXT123' : 'CSV123'}`);
});

test('extracts links from JSON arrays and links objects', () => {
  const links = service.parseImportFile(Buffer.from(JSON.stringify({ links: [{ url: 'https://chat.whatsapp.com/JSON123' }, 'https://chat.whatsapp.com/JSON456'] })), 'links.json');
  const parsed = service.parseImportedLinks(links);
  expect(parsed.valid.map(item => item.canonicalUrl)).toEqual(expect.arrayContaining(['https://chat.whatsapp.com/JSON123', 'https://chat.whatsapp.com/JSON456']));
});

test('extracts links from XLSX cells', () => {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([['الرابط'], ['https://chat.whatsapp.com/XLSX123']]);
  XLSX.utils.book_append_sheet(workbook, sheet, 'روابط');
  const links = service.parseImportFile(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }), 'links.xlsx');
  const parsed = service.parseImportedLinks(links);
  expect(parsed.valid.map(item => item.canonicalUrl)).toContain('https://chat.whatsapp.com/XLSX123');
});

test('rejects unsupported import extensions', () => {
  expect(() => service.parseImportFile(Buffer.from('https://chat.whatsapp.com/ABC123'), 'links.pdf')).toThrow('غير مدعومة');
});

const DelayEngine = require('./DelayEngine');
const JoinScheduler = require('./JoinScheduler');

test('DelayEngine returns a deterministic inclusive delay within the configured range', () => {
  expect(DelayEngine.nextDelay(10, 20, () => 0)).toBe(10);
  expect(DelayEngine.nextDelay(10, 20, () => 0.999999)).toBe(20);
  expect(DelayEngine.nextDelay(200000, 300000, () => 0.5)).toBe(86400);
});

test('JoinScheduler rejects transitions out of terminal states', () => {
  expect(JoinScheduler.canTransition('pending', 'processing')).toBe(true);
  expect(JoinScheduler.canTransition('paused', 'pending')).toBe(true);
  expect(JoinScheduler.canTransition('success', 'processing')).toBe(false);
  expect(() => JoinScheduler.assertTransition('failed', 'retry')).toThrow('غير مسموح');
});

test('JoinScheduler produces a traceable scheduled timestamp', () => {
  const schedule = JoinScheduler.schedule({ minDelaySeconds: 5, maxDelaySeconds: 5, now: 1000, random: () => 0.5 });
  expect(schedule.delaySeconds).toBe(5);
  expect(schedule.scheduledAt.toISOString()).toBe(new Date(6000).toISOString());
});

test('JoinScheduler enforces the minimum gap from the last real join timestamp', () => {
  const lastJoinAt = new Date('2026-08-25T04:00:00.000Z').toISOString();
  const now = Date.parse('2026-08-25T04:01:00.250Z');
  expect(JoinScheduler.remainingAccountDelay(lastJoinAt, 120, now)).toBe(60);
  expect(JoinScheduler.remainingAccountDelay(lastJoinAt, 120, Date.parse('2026-08-25T04:02:00.000Z'))).toBe(0);
  expect(JoinScheduler.remainingAccountDelay(null, 120, now)).toBe(0);
});

test('JoinScheduler distributes remaining links across the cycle window without violating the minimum', () => {
  const now = Date.parse('2026-08-25T04:00:00.000Z');
  const scheduled = JoinScheduler.schedule({ minDelaySeconds: 120, maxDelaySeconds: 360, remainingOperations: 29, cycleEndAt: '2026-08-25T05:00:00.000Z', now, random: () => 0.999999 });
  expect(scheduled.delaySeconds).toBe(124);
  expect(scheduled.scheduledAt.toISOString()).toBe('2026-08-25T04:02:04.000Z');
});
