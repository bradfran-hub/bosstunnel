import { createBossAddon } from './boss-addon.mjs';

const baseUrl = process.env.BOSS_PUBLIC_URL;
const mediaUrl = process.env.BOSS_MEDIA_URL;
if (!baseUrl || !mediaUrl) throw new Error('Set BOSS_PUBLIC_URL and BOSS_MEDIA_URL for media you are authorized to serve.');
const item = { id: 'owned-video-1', type: 'movie', title: 'My owned video', genres: ['Personal'], identities: {} };
function catalogue({ type, after, search = '', skip = 0, limit }) {
  const rows = (!type || type === item.type) && item.title.toLowerCase().includes(search.toLowerCase()) ? [item] : [];
  const start = search ? skip : Number(after || 0);
  const items = rows.slice(start, start + limit);
  const more = start + items.length < rows.length;
  return { items, next: more ? String(start + items.length) : null, nextOffset: more ? start + items.length : null };
}
function requireItem(id) {
  if (id !== item.id) throw Object.assign(new Error('Media not found'), { status: 404 });
  return item;
}
const server = createBossAddon({ id: 'com.example.my-owned-library', name: 'My owned library', baseUrl, types: ['movie'], token: process.env.BOSS_ADDON_TOKEN }, {
  catalogue,
  search: catalogue,
  media: ({ id }) => requireItem(id),
  playback: ({ id }) => { requireItem(id); return [{ url: mediaUrl, transport: 'http' }]; }
});
server.listen(Number(process.env.PORT || 3000), '0.0.0.0');
for (const event of ['SIGTERM', 'SIGINT']) process.on(event, () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 20000).unref();
});
