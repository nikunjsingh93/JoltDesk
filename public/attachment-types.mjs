export const imageExtensions = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

export function attachmentKind(name, type) {
  if (Object.hasOwn(imageExtensions, type)) return 'image';
  if (type?.startsWith('image/')) return null;
  if (type?.startsWith('text/') || /\.(md|json|js|ts|tsx|jsx|py|rs|go|java|c|cpp|h|css|html|xml|yaml|yml|toml|csv|log|sql|sh|txt)$/i.test(name)) return 'text';
  return null;
}

export const unsupportedAttachment = name => `${name} is unsupported. Attach text, source code, or a PNG, JPEG, WebP, or GIF image.`;
