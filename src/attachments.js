const fs = require('fs/promises');
const path = require('path');

const ATTACHMENT_DIR = path.join(__dirname, '..', 'state', 'attachments');
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 30 * 1000;
const DOCUMENT_EXTENSIONS = new Set(['.pdf', '.txt', '.docx', '.md', '.markdown', '.csv']);

function imageAttachments(message) {
  return [...(message.attachments?.values() || [])].filter((attachment) => {
    const type = (attachment.contentType || '').split(';')[0].toLowerCase();
    return type.startsWith('image/') || /\.(png|jpe?g|webp|gif|heic|heif)$/i.test(attachment.name || '');
  });
}

function documentAttachments(message) {
  return [...(message.attachments?.values() || [])].filter((attachment) =>
    DOCUMENT_EXTENSIONS.has(path.extname(attachment.name || '').toLowerCase()));
}

function supportedAttachments(message) {
  return [...new Map([...imageAttachments(message), ...documentAttachments(message)]
    .map((attachment) => [attachment.id || attachment.url, attachment])).values()];
}

// In a debate, a peer's reply has no attachment of its own. Reuse images from
// the latest human request so each agent can inspect the same visual input.
async function imagesForTurn(message, userAllowed = () => true) {
  const current = imageAttachments(message);
  if (current.length || !message.author.bot || !message.guild) return current;
  try {
    const history = await message.channel.messages.fetch({ limit: 30, before: message.id });
    for (const earlier of history.values()) {
      if (!earlier.author.bot) return userAllowed(earlier.author.id) ? imageAttachments(earlier) : [];
    }
  } catch {
    // A missing history permission must not prevent a normal text reply.
  }
  return [];
}

async function attachmentsForTurn(message, userAllowed = () => true) {
  const current = supportedAttachments(message);
  if (current.length || !message.author.bot || !message.guild) return current;
  try {
    const history = await message.channel.messages.fetch({ limit: 30, before: message.id });
    for (const earlier of history.values()) {
      if (!earlier.author.bot) return userAllowed(earlier.author.id) ? supportedAttachments(earlier) : [];
    }
  } catch {
    // A missing history permission must not prevent a normal text reply.
  }
  return [];
}

function imageExtension(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return '.png';
  if (bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))) return '.jpg';
  if (bytes.subarray(0, 6).toString('ascii').match(/^GIF8[79]a$/)) return '.gif';
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return '.webp';
  return null;
}

function discordAttachmentUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname) ||
      !url.pathname.startsWith('/attachments/')) {
    throw new Error('File URL is not a Discord attachment');
  }
  return url.href;
}

async function downloadAttachment(attachment, maxBytes, fetchFn) {
  const sizeError = `Attachment is larger than ${maxBytes / 1024 / 1024} MB`;
  if (attachment.size > maxBytes) throw new Error(sizeError);
  const response = await fetchFn(discordAttachmentUrl(attachment.url), {
    redirect: 'error',
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok || !response.body) throw new Error(`Attachment download failed (${response.status})`);
  const declaredSize = Number(response.headers.get('content-length'));
  if (declaredSize > maxBytes) throw new Error(sizeError);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error(sizeError);
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks);
}

async function downloadImage(attachment, fetchFn) {
  const bytes = await downloadAttachment(attachment, MAX_IMAGE_BYTES, fetchFn);
  const extension = imageExtension(bytes);
  if (!extension) throw new Error('Unsupported image format (use PNG, JPEG, GIF, or WebP)');
  return { bytes, extension };
}

async function saveImageAttachments(attachments, { directory = ATTACHMENT_DIR, fetchFn = fetch } = {}) {
  if (!attachments.length) return { paths: [], cleanup: async () => {} };
  if (attachments.length > MAX_IMAGES) throw new Error(`Attach at most ${MAX_IMAGES} images per message`);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const tempDir = await fs.mkdtemp(path.join(directory, 'message-'));
  try {
    const paths = [];
    for (const [index, attachment] of attachments.entries()) {
      const { bytes, extension } = await downloadImage(attachment, fetchFn);
      const file = path.join(tempDir, `image-${index + 1}${extension}`);
      await fs.writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
      paths.push(file);
    }
    return { paths, cleanup: async () => fs.rm(tempDir, { recursive: true, force: true }) };
  } catch (error) {
    await fs.rm(tempDir, { recursive: true, force: true });
    throw error;
  }
}

module.exports = {
  imageAttachments, imagesForTurn, documentAttachments, attachmentsForTurn,
  saveImageAttachments, imageExtension, downloadAttachment, MAX_DOCUMENT_BYTES,
};
