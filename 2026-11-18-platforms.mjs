export const platformNames = { naver: '네이버 블로그', cafe: '네이버 카페', tistory: '티스토리' };

export function platformOf(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return '';
    if (url.hostname === 'blog.naver.com') return 'naver';
    if (url.hostname === 'cafe.naver.com') return 'cafe';
    if (url.hostname.endsWith('.tistory.com') && !['www.tistory.com', 'notice.tistory.com'].includes(url.hostname)) return 'tistory';
  } catch { /* Unsupported tab */ }
  return '';
}

export const connectionKey = windowId => 'connection:' + windowId;
export const transferKey = windowId => 'transfer:' + windowId;
