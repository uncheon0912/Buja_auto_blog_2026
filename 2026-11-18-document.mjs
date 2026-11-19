const kinds = new Set(['paragraph', 'heading', 'list', 'ordered-list', 'callout', 'blockquote', 'checklist', 'faq']);
const scalar = (value, limit) => typeof value === 'string' ? value.slice(0, limit) : '';
const plain = (value, limit = 8000) => scalar(value, limit).replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
  .replace(/^\s*#{1,6}\s+/gm, '').replace(/\*\*(.+?)\*\*/g, '$1').trim();
export const escape = value => String(value).replace(/[&<>"']/g, value =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[value]);
export const splitBody = value => scalar(value, 60000).split(/\n\s*\n/).map(value => value.trim()).filter(Boolean);
export function shortHeading(value) {
  const phrase = plain(value).normalize('NFC').replace(/\s+/g, ' ');
  const characters = Array.from(phrase);
  if (characters.length < 15) return phrase;
  const cut = characters.slice(0, 14).join('').trimEnd();
  const boundary = cut.lastIndexOf(' ');
  return boundary >= 8 && characters[14] !== ' ' ? cut.slice(0, boundary) : cut;
}

function listItems(raw, depth = 0) {
  if (!Array.isArray(raw) || depth > 2) return [];
  return raw.slice(0, 20).flatMap(value => {
    const text = plain(typeof value === 'string' ? value : value?.text, 1000);
    return text ? [{ text, children: listItems(value?.children, depth + 1) }] : [];
  });
}

function asSupportedBlock(value) {
  if (value?.type === 'steps' || value?.type === 'comparison') {
    const ordered = value.type === 'steps';
    const items = Array.isArray(value.items) ? value.items.map(item => {
      const label = plain(ordered ? item?.title : item?.label, 250);
      const description = plain(item?.text, 1000);
      return label ? { text:label, children:description ? [description] : [] } : description;
    }) : [];
    return {...value, type:ordered ? 'ordered-list' : 'list', items};
  }
  if (value?.type === 'pros_cons') {
    const items = [['장점',value.pros],['단점',value.cons]].flatMap(([text,children]) =>
      Array.isArray(children) && children.length ? [{text, children}] : []);
    return {...value,type:'list',items};
  }
  return value;
}

export function normalizeContent(raw) {
  if (!Array.isArray(raw)) return [];
  const used = new Set();
  return raw.slice(0, 100).flatMap((rawBlock, index) => {
    const value = asSupportedBlock(rawBlock);
    const type = value?.type === 'lead' || value?.type === 'cta' ? 'paragraph' : value?.type;
    if (!kinds.has(type)) return [];
    let id = /^[a-z0-9_-]{1,50}$/i.test(value.id || '') ? value.id : 'block-' + (index + 1);
    while (used.has(id)) id = '_' + id;
    used.add(id);
    if (['list', 'ordered-list', 'checklist'].includes(type)) {
      return [{ id, type, text: plain(value.text, 250), items: listItems(value.items) }];
    }
    if (type === 'faq') {
      const items = Array.isArray(value.items) ? value.items.slice(0, 16).map(item => ({
        question: plain(item?.question, 700).replace(/^(?:Q\.|Question:)\s*/i, ''),
        answer: plain(item?.answer, 2400).replace(/^(?:A\.|Answer:)\s*/i, '')
      })) : [];
      return [{ id, type, text: plain(value.text, 250), items }];
    }
    return [{
      id, type, text: type === 'heading' ? shortHeading(value.text) : plain(value.text),
      ...(type === 'heading' ? { level: value.level === 3 ? 3 : 2 } : {}),
      ...(type === 'callout' ? { title: plain(value.title, 250), variant: ['tip','summary','warning'].includes(value.variant) ? value.variant : 'summary' } : {})
    }];
  });
}

function listTexts(items) {
  return items.flatMap(item => [item.text, ...listTexts(item.children || [])]);
}

export function textOfBlock(block) {
  if (['list', 'ordered-list', 'checklist'].includes(block.type)) return listTexts(block.items).join('\n');
  if (block.type === 'faq') return block.items.flatMap(item => ['Q. ' + item.question, 'A. ' + item.answer]).join('\n');
  return [block.title, block.text].filter(Boolean).join('\n');
}

export function blocksOf(draft) {
  if (draft.content?.length) return draft.content;
  return splitBody(draft.body).map((text, index) => ({ id: 'legacy-' + (index + 1), type: 'paragraph', text }));
}

export function imageAnchor(image, blocks) {
  if (image.afterBlockId) {
    return blocks.some(block => block.id === image.afterBlockId) ? image.afterBlockId : undefined;
  }
  const index = Math.max(0, Number(image.afterParagraph) || 0);
  return index === 0 ? '' : blocks[Math.min(index, blocks.length) - 1]?.id;
}

export function orderedImages(images, blocks) {
  const indexes = new Map(blocks.map((block, index) => [block.id, index + 1]));
  indexes.set('', 0);
  return images.map(image => ({ ...image, anchor: imageAnchor(image, blocks) }))
    .sort((a, b) => (indexes.get(a.anchor) ?? Infinity) - (indexes.get(b.anchor) ?? Infinity));
}

export function fixedPhotoPosition(image) {
  return image.placement === 'fixed' || (image.placement !== 'auto' && Boolean(image.afterBlockId || image.afterParagraph > 0));
}

export function photoPlacements(images, blocks, platform) {
  if (platform !== 'naver' || !images.length) return orderedImages(images, blocks);
  const thumbnail = images.find(image => image.thumbnail) || images[0];
  const bodyPhotos = images.filter(image => image.id !== thumbnail.id).map(image => {
    const fixed = fixedPhotoPosition(image);
    return {...image, thumbnail: false, fixed, anchor: fixed ? imageAnchor(image, blocks) : undefined};
  });
  const reserved = new Set(bodyPhotos.filter(image => image.fixed).map(image => image.anchor));
  const available = blocks.filter(block => block.type === 'paragraph' && !reserved.has(block.id));
  let automatic = 0;
  return [{...thumbnail, anchor: '', thumbnail: true}, ...bodyPhotos.map(image => image.fixed ? image : {
    ...image, anchor: available[automatic++]?.id ?? blocks.at(-1)?.id ?? ''
  })];
}

const htmlText = value => escape(value).replace(/\n/g, '<br>');
function listHTML(items, tag, checklist = false) {
  return '<' + tag + (checklist ? ' style="list-style:none;padding-left:12px">' : '>')
    + items.map(item => '<li>' + (checklist ? '☐ ' : '') + htmlText(item.text)
    + (item.children?.length ? listHTML(item.children, 'ul') : '') + '</li>').join('') + '</' + tag + '>';
}

export function renderBlock(block, accent, article = false, headingColor = false) {
  const content = htmlText(block.text || '');
  const accented = 'border-left:4px solid ' + accent
    + (article ? ';background-color:' + accent + '14;padding:10px 12px;border-radius:8px' : ';padding-left:10px');
  const label = article && content ? '<p><strong>' + content + '</strong></p>' : '';
  switch (block.type) {
    case 'heading': {
      const colored = headingColor ? '<span style="color:' + accent + ';font-weight:700">' + content + '</span>' : content;
      return '<h' + block.level + ' style="' + accented + (headingColor ? ';color:' + accent : '')
        + '">' + colored + '</h' + block.level + '>';
    }
    case 'blockquote': return '<blockquote>' + content + '</blockquote>';
    case 'callout': return '<p style="' + accented + '">'
      + (block.title ? '<strong>' + htmlText(block.title) + '</strong><br>' : '<strong>' + content + '</strong>')
      + (block.title ? content : '') + '</p>';
    case 'list': case 'checklist': return label + listHTML(block.items, 'ul', article && block.type === 'checklist');
    case 'ordered-list': return label + listHTML(block.items, 'ol');
    case 'faq': return (article && content ? '<h2 style="' + accented + '">' + content + '</h2>' : '')
      + block.items.map(item => '<p><strong>Q. ' + htmlText(item.question)
      + '</strong><br>A. ' + htmlText(item.answer) + '</p>').join('');
    default: return '<p>' + content + '</p>';
  }
}
