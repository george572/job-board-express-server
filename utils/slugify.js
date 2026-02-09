// Georgian to Latin transliteration map
const georgianToLatin = {
  'ა': 'a', 'ბ': 'b', 'გ': 'g', 'დ': 'd', 'ე': 'e',
  'ვ': 'v', 'ზ': 'z', 'თ': 't', 'ი': 'i', 'კ': 'k',
  'ლ': 'l', 'მ': 'm', 'ნ': 'n', 'ო': 'o', 'პ': 'p',
  'ჟ': 'zh', 'რ': 'r', 'ს': 's', 'ტ': 't', 'უ': 'u',
  'ფ': 'f', 'ქ': 'k', 'ღ': 'gh', 'ყ': 'q', 'შ': 'sh',
  'ჩ': 'ch', 'ც': 'ts', 'ძ': 'dz', 'წ': 'ts', 'ჭ': 'ch',
  'ხ': 'kh', 'ჯ': 'j', 'ჰ': 'h'
};

const specialCharsToHyphen = {
  '/': '-', '\\': '-', '|': '-', '_': '-', '.': '-',
  ',': '-', ';': '-', ':': '-', '!': '-', '?': '-',
  '(': '-', ')': '-', '[': '-', ']': '-', '{': '-',
  '}': '-', '+': '-', '=': '-', '@': '-', '#': '-',
  '$': '-', '%': '-', '^': '-', '&': '-', '*': '-',
  '"': '-', "'": '-', '`': '-', '~': '-'
};

function slugify(text) {
  // First transliterate Georgian characters
  const transliterated = text
    .split('')
    .map(char => georgianToLatin[char] || char)
    .join('');

  // Replace special characters with hyphens
  const withHyphens = transliterated
    .split('')
    .map(char => specialCharsToHyphen[char] || char)
    .join('');

  return withHyphens
    .toString()
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
}

function extractIdFromSlug(slug) {
  const parts = slug.split('-');
  const lastPart = parts[parts.length - 1];
  
  if (/^\d+$/.test(lastPart)) {
    return lastPart;
  }
  
  return null;
}

module.exports = { slugify, extractIdFromSlug };
