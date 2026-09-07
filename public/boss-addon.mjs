import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
const types = ['movie', 'series', 'season', 'episode', 'channel', 'event'];
const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const httpResource = (value) => {
  try {
    const url = new URL(value); let decoded = url.href;
    for (let i = 0; i < 3; i++) { const next = decodeURIComponent(decoded); if (next === decoded) break; decoded = next; }
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !/(magnet:|urn:btih:|urn:btmh:|\.torrent\b)/i.test(decoded);
  } catch { return false; }
};
function media(item) {
  if (!item || typeof item.id !== 'string' || !item.id || item.id.length > 256 || !types.includes(item.type) || typeof item.title !== 'string' || !item.title.trim()) throw bad('Invalid media record');
  if (item.category != null) category(item.category);
  return { ...item, playbackState: 'UNRESOLVED' };
}
function category(item) {
  if (!item || typeof item.id !== 'string' || !item.id || item.id.length > 256 || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 1024 || !['movie', 'series', 'channel', 'event'].includes(item.type)) throw bad('Invalid category record');
  return { id: item.id, name: item.name, type: item.type };
}
function programme(event) {
  const xml = (value) => String(value || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char]));
  const time = (value) => new Date(value).toISOString().replace(/[-:T]/g, '').slice(0, 14) + ' +0000';
  if (!event || typeof event.channelKey !== 'string' || !event.channelKey || event.channelKey.length > 256 || typeof event.title !== 'string' || !event.title.trim() || !Number.isSafeInteger(event.startsAt) || !Number.isSafeInteger(event.endsAt) || event.startsAt < 0 || event.endsAt <= event.startsAt || event.endsAt >= 253402300800000) throw bad('Invalid guide programme');
  if (event.title.length > 4096 || (event.description != null && (typeof event.description !== 'string' || event.description.length > 65536))) throw bad('Guide programme exceeds text limits');
  return `<programme channel="${xml(event.channelKey)}" start="${time(event.startsAt)}" stop="${time(event.endsAt)}"><title>${xml(event.title)}</title><desc>${xml(event.description)}</desc></programme>`;
}
export function createBossAddon(config, handlers) {
  if (!config.id || !config.name || !httpResource(config.baseUrl) || !Array.isArray(config.types) || config.types.some((type) => !types.includes(type))) throw bad('Invalid addon configuration');
  const base = config.baseUrl.replace(/\/$/, '');
  const pathname = new URL(base).pathname.replace(/\/$/, '');
  const capabilities = { catalog: Boolean(handlers.catalogue), metadata: Boolean(handlers.media), search: Boolean(handlers.search), streams: Boolean(handlers.playback), subtitles: Boolean(handlers.subtitles), live: config.types.includes('channel'), epg: false, catchup: false, timeshift: false, types: config.types };
  capabilities.epg = capabilities.live && typeof handlers.guide === 'function';
  capabilities.categories = capabilities.catalog && typeof handlers.categories === 'function';
  capabilities.catchup = capabilities.live && capabilities.streams && capabilities.metadata && typeof handlers.catchup === 'function';
  const resources = Object.fromEntries([['catalogue', 'catalog'], ['media', 'metadata'], ['playback', 'streams'], ['subtitles', 'subtitles']].filter(([, capability]) => capabilities[capability]).map(([name]) => [name, `${base}/${name}${name === 'catalogue' ? '' : '/{id}'}`]));
  if (capabilities.epg) resources.guide = `${base}/guide`;
  if (capabilities.categories) resources.categories = `${base}/categories`;
  if (capabilities.catchup) resources.catchup = `${base}/catchup/{id}`;
  const descriptor = { format: 'boss-media-addon', version: 1, addonUrl: `${base}/addon.boss`, id: config.id, name: config.name, capabilities, resources, pagination: { mode: 'cursor', parameter: 'after', maximumPageSize: 200 }, security: { access: config.token ? 'bearer-token' : 'public', torrents: false } };
  function send(res, status, body, head) {
    if (res.destroyed || res.headersSent) return;
    const data = JSON.stringify(body);
    if (Buffer.byteLength(data) > 8 * 1024 * 1024) throw bad('Response exceeds 8 MB');
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store', 'Access-Control-Allow-Origin': '*', 'X-Content-Type-Options': 'nosniff' });
    res.end(head ? undefined : data);
  }
  return http.createServer((req, res) => {
    const controller = new AbortController();
    const stop = () => controller.abort(); res.once('close', stop);
    (async () => {
      if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,HEAD,OPTIONS', 'Access-Control-Allow-Headers': 'Authorization' }); return res.end(); }
      if (!['GET', 'HEAD'].includes(req.method)) throw bad('Method not allowed', 405);
      const url = new URL(req.url, base);
      if (!url.pathname.startsWith(`${pathname}/`)) throw bad('Resource not found', 404);
      if (url.pathname === `${pathname}/healthz`) return send(res, 200, { ok: true }, req.method === 'HEAD');
      if (config.token) {
        const expected = Buffer.from(`Bearer ${config.token}`), actual = Buffer.from(req.headers.authorization || '');
        if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw bad('Invalid addon credentials', 401);
      }
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]);
      const context = { signal };
      if (url.pathname === `${pathname}/addon` || url.pathname === `${pathname}/addon.boss`) {
        if (url.pathname.endsWith('.boss')) res.setHeader('Content-Disposition', 'attachment; filename="addon.boss"');
        return send(res, 200, descriptor, req.method === 'HEAD');
      }
      if (url.pathname === `${pathname}/guide`) {
        if (!capabilities.epg) throw bad('Resource is not supported', 422);
        res.setHeader('Content-Type', 'application/xml; charset=utf-8');
        res.setHeader('Cache-Control', 'private, no-store');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        if (req.method === 'HEAD') return res.end();
        const events = await handlers.guide({}, context);
        if (!events || (!events[Symbol.asyncIterator] && !events[Symbol.iterator])) throw bad('Guide handler must return an iterable');
        const write = async (chunk) => { signal.throwIfAborted(); if (!res.write(chunk)) await once(res, 'drain', { signal }); };
        await write('<?xml version="1.0" encoding="UTF-8"?><tv generator-info-name="Boss Addon SDK">');
        for await (const event of events) await write(programme(event));
        return res.end('</tv>');
      }
      if (url.pathname === `${pathname}/categories`) {
        if (!capabilities.categories) throw bad('Resource is not supported', 422);
        const limit = Number(url.searchParams.get('limit') || 100), type = url.searchParams.get('type'), after = url.searchParams.get('after');
        if (!Number.isInteger(limit) || limit < 1 || limit > 200 || !['movie', 'series', 'channel', 'event'].includes(type) || (after != null && (!after || after.length > 8192))) throw bad('Invalid category parameters');
        const page = await handlers.categories({ type, after, limit }, context);
        if (!Array.isArray(page?.categories) || page.categories.length > limit || (page.next != null && (typeof page.next !== 'string' || !page.next || page.next.length > 8192 || page.next === after))) throw bad('Invalid category response');
        const categories = page.categories.map(category);
        if (categories.some(item => item.type !== type) || new Set(categories.map(item => item.id)).size !== categories.length) throw bad('Invalid category response');
        return send(res, 200, { categories, next: page.next ?? null }, req.method === 'HEAD');
      }
      if (url.pathname === `${pathname}/catalogue`) {
        const limit = Number(url.searchParams.get('limit') || 100), skip = Number(url.searchParams.get('skip') || 0), search = url.searchParams.get('search') || '';
        if (!Number.isInteger(limit) || limit < 1 || limit > 200 || !Number.isSafeInteger(skip) || skip < 0 || search.length > 200) throw bad('Invalid catalogue parameters');
        const handler = search ? handlers.search : handlers.catalogue;
        const categoryId = url.searchParams.get('categoryId');
        if (categoryId != null && (!categoryId || categoryId.length > 256)) throw bad('Invalid category ID');
        if (categoryId != null && !capabilities.categories) throw bad('Categories are not supported', 422);
        if (!handler) throw bad('Resource is not supported', 422);
        const page = await handler({ type: url.searchParams.get('type'), after: url.searchParams.get('after'), seriesId: url.searchParams.get('seriesId'), search, skip, limit, categoryId }, context);
        if (!Array.isArray(page.items) || page.items.length > limit || (page.next != null && typeof page.next !== 'string')) throw bad('Invalid catalogue response');
        return send(res, 200, { ...page, items: page.items.map(media) }, req.method === 'HEAD');
      }
      const match = url.pathname.slice(pathname.length).match(/^\/(media|playback|subtitles|catchup)\/([^/]+)$/);
      if (!match || !handlers[match[1]]) throw bad('Resource not found', 404);
      const id = decodeURIComponent(match[2]);
      const input = { id };
      if (match[1] === 'catchup') {
        if (!capabilities.catchup) throw bad('Archive playback is not supported', 422);
        const start = Number(url.searchParams.get('start')), end = Number(url.searchParams.get('end'));
        if (!url.searchParams.has('start') || !url.searchParams.has('end') || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > Date.now() + 60000 || end - start > 86400000) throw bad('Invalid archive interval');
        const channel = await handlers.media({ id }, context);
        const days = Number(channel?.channel?.catchupDays);
        if (channel?.type !== 'channel' || channel.id !== id || !Number.isFinite(days) || days <= 0 || days > 365 || start < Date.now() - days * 86400000) throw bad('Requested archive is not available', 422);
        Object.assign(input, { start, end });
      }
      const result = await handlers[match[1]](input, context);
      if (match[1] === 'media') {
        if (!result) throw bad('Media not found', 404);
        return send(res, 200, { media: media(result) }, req.method === 'HEAD');
      }
      const field = match[1] === 'subtitles' ? 'subtitles' : 'resources';
      if (!Array.isArray(result) || result.length > 200 || result.some((item) => !httpResource(item.url) || ['infoHash', 'info_hash', 'magnet', 'torrent', 'torrentUrl', 'fileIdx', 'drm', 'requiresDrm'].some((key) => item[key] != null))) throw bad('Only authorized non-DRM HTTP resources are supported', 422);
      return send(res, 200, { id, [field]: result }, req.method === 'HEAD');
    })().catch((error) => {
      if (res.headersSent) res.destroy();
      else send(res, error.status || 502, { error: error.status ? error.message : 'Addon operation failed' }, req.method === 'HEAD');
    }).finally(() => res.off('close', stop));
  });
}
