const test = require('node:test');
const assert = require('node:assert/strict');
const JSZip = require('jszip');
const { attachmentsForTurn, documentAttachments } = require('../src/attachments');
const { extractDocumentText, documentContext } = require('../src/documents');

const url = 'https://cdn.discordapp.com/attachments/123/456/report.pdf';

function samplePdf() {
  const chunks = ['%PDF-1.4\n'];
  const offsets = [0];
  function object(number, body) {
    offsets[number] = Buffer.byteLength(chunks.join(''));
    chunks.push(`${number} 0 obj\n${body}\nendobj\n`);
  }
  object(1, '<< /Type /Catalog /Pages 2 0 R >>');
  object(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  object(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>');
  object(4, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const stream = 'BT /F1 12 Tf 20 200 Td (Project alpha) Tj ET';
  object(5, `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  const start = Buffer.byteLength(chunks.join(''));
  chunks.push('xref\n0 6\n0000000000 65535 f \n');
  for (let i = 1; i <= 5; i++) chunks.push(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`);
  chunks.push(`trailer\n<< /Root 1 0 R /Size 6 >>\nstartxref\n${start}\n%%EOF\n`);
  return Buffer.from(chunks.join(''));
}

test('extracts text from PDF, DOCX, and UTF-8 files', async () => {
  assert.match((await extractDocumentText('report.pdf', samplePdf())).text, /Project alpha/);
  const zip = new JSZip();
  zip.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Project beta</w:t></w:r></w:p></w:body></w:document>');
  assert.match((await extractDocumentText('report.docx', await zip.generateAsync({ type: 'nodebuffer' }))).text, /Project beta/);
  assert.equal((await extractDocumentText('notes.md', Buffer.from('# 제목'))).text, '# 제목');
  assert.equal((await extractDocumentText('table.csv', Buffer.from('a,b\n1,2'))).text, 'a,b\n1,2');
  await assert.rejects(extractDocumentText('notes.txt', Buffer.from([0, 1])), /binary data/);
});

test('downloads documents only from Discord and limits their prompt text', async () => {
  const longText = Buffer.from('x'.repeat(30000));
  const attachment = { name: 'notes.txt', size: longText.length, url };
  const context = await documentContext([attachment], { fetchFn: async () => new Response(longText) });
  assert.match(context, /File: notes.txt/);
  assert.match(context, /\[Text truncated\]/);
  assert.match(context, /x{25000}\n\[Text truncated\]/);
  await assert.rejects(documentContext([{ ...attachment, url: 'https://example.com/file.txt' }]), /not a Discord attachment/);
  await assert.rejects(documentContext([{ ...attachment, size: 11 * 1024 * 1024 }]), /larger than 10 MB/);
});

test('debate peers can read the latest authorized human documents', async () => {
  const document = { name: 'notes.md', size: 8, url };
  const human = { author: { bot: false, id: 'owner' }, attachments: new Map([['document', document]]) };
  const message = {
    author: { bot: true }, guild: {}, id: 'reply', attachments: new Map(),
    channel: { messages: { fetch: async () => new Map([['human', human]]) } },
  };
  assert.deepEqual(documentAttachments(human), [document]);
  assert.deepEqual(await attachmentsForTurn(message, (id) => id === 'owner'), [document]);
  assert.deepEqual(await attachmentsForTurn(message, () => false), []);
});
