// Vertical slice: world → campaign → advancement → town → location → map + wiki → invite → navigate.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server.js');

async function boot(file) {
  const server = http.createServer(createApp({ file }).handle);
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;
  const call = async (method, url, body, token) => {
    const res = await fetch(base + url, {
      method,
      headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
      body: body && JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  const ok = async (...a) => {
    const r = await call(...a);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body;
  };
  return { server, call, ok };
}

test('vertical slice with server-enforced visibility', async (t) => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lw-')), 'data.json');
  const { server, call, ok } = await boot(file);
  t.after(() => server.close());

  const gm = (await ok('POST', '/api/users', { name: 'Gm' })).token;
  const player = (await ok('POST', '/api/users', { name: 'Pat' })).token;
  const viewer = (await ok('POST', '/api/users', { name: 'Viv' })).token;

  assert.equal((await call('POST', '/api/worlds', { name: 'X', advancement: 'levels' }, gm)).status, 400);
  const world = await ok('POST', '/api/worlds', { name: 'Aster', advancement: 'xp', npcAutonomy: 'scheduled' }, gm);
  assert.equal(world.settings.advancement, 'xp');

  const campaign = await ok('POST', `/api/worlds/${world.id}/campaigns`, { name: 'Three Weeks' }, gm);
  assert.deepEqual(campaign.advancement, { mode: 'xp', source: 'world' });
  // Switching mode needs explicit confirmation.
  assert.equal((await call('PATCH', `/api/campaigns/${campaign.id}/advancement`, { mode: 'milestone' }, gm)).status, 409);
  const switched = await ok('PATCH', `/api/campaigns/${campaign.id}/advancement`, { mode: 'milestone', confirm: true }, gm);
  assert.deepEqual(switched.advancement, { mode: 'milestone', source: 'campaign' });

  const town = await ok('POST', `/api/locations/${world.rootLocationId}/children`,
    { name: 'Greyhaven', type: 'town', x: 40, y: 60, visibility: 'public' }, gm);
  const tavern = await ok('POST', `/api/locations/${town.id}/children`,
    { name: 'Gilded Gull', type: 'tavern', x: 20, y: 30, visibility: 'party' }, gm);
  await ok('POST', `/api/locations/${town.id}/children`, { name: 'Smugglers Den', type: 'hideout', x: 70, y: 70, visibility: 'gm' }, gm);
  await ok('PATCH', `/api/maps/${town.mapId}`, { imageUrl: 'https://example.com/greyhaven.png' }, gm);
  await ok('PATCH', `/api/pages/${tavern.pageId}`, { body: 'Run by Mara.', gmNotes: 'Mara is a spy.' }, gm);
  assert.equal((await call('PATCH', `/api/maps/${town.mapId}`, { imageUrl: 'javascript:alert(1)' }, gm)).status, 400);

  // Not a member yet: the world does not exist for them.
  assert.equal((await call('GET', `/api/locations/${town.id}`, null, player)).status, 404);

  const inv = await ok('POST', `/api/campaigns/${campaign.id}/invites`, { role: 'player' }, gm);
  await ok('POST', `/api/invites/${inv.code}/accept`, {}, player);
  assert.equal((await call('POST', `/api/invites/${inv.code}/accept`, {}, viewer)).status, 410);
  const sInv = await ok('POST', `/api/campaigns/${campaign.id}/invites`, { role: 'spectator' }, gm);
  await ok('POST', `/api/invites/${sInv.code}/accept`, {}, viewer);

  // Player navigates world map → town → tavern.
  const me = await ok('GET', '/api/me', null, player);
  assert.deepEqual(me.worlds.map((w) => w.role), ['player']);
  const root = await ok('GET', `/api/locations/${world.rootLocationId}`, null, player);
  assert.deepEqual(root.children.map((c) => c.name), ['Greyhaven']);
  const townView = await ok('GET', `/api/locations/${town.id}`, null, player);
  assert.equal(townView.map.imageUrl, 'https://example.com/greyhaven.png');
  assert.deepEqual(townView.children.map((c) => c.name), ['Gilded Gull'], 'GM-only hideout must not reach players');
  const tavernView = await ok('GET', `/api/locations/${tavern.id}`, null, player);
  assert.deepEqual(tavernView.breadcrumbs.map((b) => b.name), ['Aster', 'Greyhaven', 'Gilded Gull']);
  assert.equal(tavernView.page.body, 'Run by Mara.');
  assert.equal(tavernView.page.gmNotes, undefined);

  // Spectator sees less than a player; players cannot edit.
  assert.deepEqual((await ok('GET', `/api/locations/${town.id}`, null, viewer)).children, []);
  assert.equal((await call('GET', `/api/locations/${tavern.id}`, null, viewer)).status, 404);
  assert.equal((await call('PATCH', `/api/pages/${tavern.pageId}`, { body: 'x' }, player)).status, 403);
  assert.equal((await call('POST', `/api/locations/${town.id}/children`, { name: 'Y', x: 1, y: 1 }, player)).status, 403);

  // Rename keeps every link (stable ids); GM still sees notes.
  await ok('PATCH', `/api/locations/${town.id}`, { name: 'Greyhaven Port' }, gm);
  const gmTavern = await ok('GET', `/api/locations/${tavern.id}`, null, gm);
  assert.equal(gmTavern.breadcrumbs[1].name, 'Greyhaven Port');
  assert.equal(gmTavern.page.gmNotes, 'Mara is a spy.');

  // State survives a restart, including the append-only event log.
  const again = createApp({ file });
  assert.equal(again.db.locations.length, 4);
  assert.ok(again.db.events.some((e) => e.type === 'campaign.advancement.changed'));
  assert.ok(!JSON.stringify((await call('GET', '/api/me', null, gm)).body).includes('tokenHash'));
});
