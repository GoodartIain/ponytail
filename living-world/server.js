// Living World — Milestone 0/1/2 vertical slice server. Node stdlib only.
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ADVANCEMENT = ['milestone', 'xp'];
const AUTONOMY = ['static', 'scheduled', 'reactive', 'simulated', 'ai-assisted'];
const VISIBILITY = ['gm', 'party', 'public']; // gm: GM only, party: players, public: players + spectators
const RANK = { none: 0, spectator: 1, player: 2, gm: 3 };
const SEES = { gm: VISIBILITY, player: ['party', 'public'], spectator: ['public'], none: [] };
const COLLECTIONS = ['users', 'worlds', 'campaigns', 'memberships', 'invites', 'locations', 'maps', 'pages', 'events'];

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const id = () => crypto.randomUUID();
const hash = (t) => crypto.createHash('sha256').update(t).digest('hex');

function str(v, name, max = 200) {
  if (typeof v !== 'string' || !v.trim() || v.length > max) fail(400, `${name} must be a non-empty string up to ${max} chars`);
  return v.trim();
}
function oneOf(v, list, name) {
  if (!list.includes(v)) fail(400, `${name} must be one of: ${list.join(', ')}`);
  return v;
}
function coord(v, name) {
  if (typeof v !== 'number' || !(v >= 0 && v <= 100)) fail(400, `${name} must be a number 0..100`);
  return v;
}

// shortcut: whole state in one JSON file, rewritten per mutation; move to PostgreSQL (docs/ARCHITECTURE.md §3) before multi-user hosting.
function openStore(file) {
  let db = Object.fromEntries(COLLECTIONS.map((c) => [c, []]));
  if (file && fs.existsSync(file)) db = { ...db, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  const save = () => {
    if (!file) return;
    fs.writeFileSync(file + '.tmp', JSON.stringify(db));
    fs.renameSync(file + '.tmp', file); // atomic replace so a crash never leaves half a file
  };
  return { db, save };
}

function createApp({ file } = {}) {
  const { db, save } = openStore(file);
  const find = (c, key) => db[c].find((r) => r.id === key) || fail(404, `${c.slice(0, -1)} not found`);

  function record(actor, type, data) {
    db.events.push({ seq: db.events.length + 1, at: new Date().toISOString(), actor, type, data });
    save();
  }

  function roleIn(user, worldId) {
    const world = find('worlds', worldId);
    if (world.ownerId === user.id) return 'gm';
    return db.memberships
      .filter((m) => m.userId === user.id && m.worldId === worldId)
      .reduce((best, m) => (RANK[m.role] > RANK[best] ? m.role : best), 'none');
  }
  function need(user, worldId, min) {
    const role = roleIn(user, worldId);
    if (RANK[role] < RANK[min]) fail(role === 'none' ? 404 : 403, role === 'none' ? 'world not found' : 'not allowed');
    return role;
  }
  const canSee = (role, loc) => SEES[role].includes(loc.visibility);

  function newLocation(worldId, parentId, { name, type, x, y, visibility }) {
    const loc = { id: id(), worldId, parentId, name, type, x, y, visibility, mapId: id(), pageId: id() };
    db.maps.push({ id: loc.mapId, worldId, locationId: loc.id, name: `${name} map`, imageUrl: '' });
    db.pages.push({ id: loc.pageId, worldId, locationId: loc.id, title: name, body: '', gmNotes: '' });
    db.locations.push(loc);
    return loc;
  }

  // Only fields the role may see leave the server; hiding is never left to the client.
  function viewLocation(user, locId) {
    const loc = find('locations', locId);
    const role = need(user, loc.worldId, 'spectator');
    if (!canSee(role, loc)) fail(404, 'location not found');
    const trail = [];
    for (let p = loc; p; p = p.parentId && find('locations', p.parentId)) {
      if (!canSee(role, p)) break; // a hidden ancestor ends the trail rather than leaking its name
      trail.unshift({ id: p.id, name: p.name, type: p.type });
    }
    const page = { ...find('pages', loc.pageId) };
    if (role !== 'gm') delete page.gmNotes;
    return {
      role,
      location: loc,
      breadcrumbs: trail,
      map: find('maps', loc.mapId),
      page,
      children: db.locations.filter((c) => c.parentId === loc.id && canSee(role, c)),
    };
  }

  const routes = {
    'POST /api/users': (_u, b) => {
      const token = crypto.randomBytes(24).toString('hex');
      const user = { id: id(), name: str(b.name, 'name', 60), tokenHash: hash(token) };
      db.users.push(user);
      record(user.id, 'user.created', { userId: user.id });
      return { user: { id: user.id, name: user.name }, token };
    },
    'GET /api/me': (u) => ({
      user: { id: u.id, name: u.name },
      worlds: db.worlds
        .map((w) => ({ id: w.id, name: w.name, role: roleIn(u, w.id) }))
        .filter((w) => w.role !== 'none'),
    }),
    'POST /api/worlds': (u, b) => {
      const world = {
        id: id(),
        ownerId: u.id,
        name: str(b.name, 'name', 120),
        settings: {
          ruleset: 'srd-5.2.1',
          advancement: oneOf(b.advancement, ADVANCEMENT, 'advancement'),
          npcAutonomy: oneOf(b.npcAutonomy ?? 'scheduled', AUTONOMY, 'npcAutonomy'),
          calendar: { name: 'Standard', daysPerWeek: 7, monthsPerYear: 12, daysPerMonth: 30 },
          defaultVisibility: 'party',
        },
      };
      db.worlds.push(world);
      world.rootLocationId = newLocation(world.id, null, { name: world.name, type: 'world', x: 50, y: 50, visibility: 'public' }).id;
      record(u.id, 'world.created', { worldId: world.id, settings: world.settings });
      return world;
    },
    'GET /api/worlds/:id': (u, _b, p) => {
      const role = need(u, p.id, 'spectator');
      const world = find('worlds', p.id);
      const mine = new Set(db.memberships.filter((m) => m.userId === u.id).map((m) => m.campaignId));
      return {
        ...world,
        role,
        campaigns: db.campaigns.filter((c) => c.worldId === p.id && (role === 'gm' || mine.has(c.id))),
      };
    },
    'POST /api/worlds/:id/campaigns': (u, b, p) => {
      need(u, p.id, 'gm');
      const world = find('worlds', p.id);
      const override = b.advancement !== undefined;
      const campaign = {
        id: id(),
        worldId: p.id,
        name: str(b.name, 'name', 120),
        // Copied, not referenced: changing the world default later must not retroactively change this campaign.
        advancement: {
          mode: override ? oneOf(b.advancement, ADVANCEMENT, 'advancement') : world.settings.advancement,
          source: override ? 'campaign' : 'world',
        },
      };
      db.campaigns.push(campaign);
      record(u.id, 'campaign.created', { campaignId: campaign.id, advancement: campaign.advancement });
      return campaign;
    },
    'PATCH /api/campaigns/:id/advancement': (u, b, p) => {
      const campaign = find('campaigns', p.id);
      need(u, campaign.worldId, 'gm');
      const mode = oneOf(b.mode, ADVANCEMENT, 'mode');
      if (mode === campaign.advancement.mode) return campaign;
      if (b.confirm !== true) {
        fail(409, `Switching ${campaign.advancement.mode} → ${mode} keeps every character's current level and history; ` +
          'future awards use the new mode. Resend with confirm: true.');
      }
      const from = campaign.advancement.mode;
      campaign.advancement = { mode, source: 'campaign' };
      record(u.id, 'campaign.advancement.changed', { campaignId: campaign.id, from, to: mode });
      return campaign;
    },
    'POST /api/campaigns/:id/invites': (u, b, p) => {
      const campaign = find('campaigns', p.id);
      need(u, campaign.worldId, 'gm');
      const invite = { id: crypto.randomBytes(9).toString('base64url'), campaignId: campaign.id, worldId: campaign.worldId,
        role: oneOf(b.role ?? 'player', ['player', 'spectator'], 'role'), createdBy: u.id, acceptedBy: null };
      db.invites.push(invite);
      record(u.id, 'invite.created', { campaignId: campaign.id, role: invite.role });
      return { code: invite.id, role: invite.role };
    },
    'POST /api/invites/:id/accept': (u, _b, p) => {
      const invite = find('invites', p.id);
      if (invite.acceptedBy) fail(410, 'invite already used');
      invite.acceptedBy = u.id;
      db.memberships.push({ id: id(), userId: u.id, worldId: invite.worldId, campaignId: invite.campaignId, role: invite.role });
      record(u.id, 'invite.accepted', { campaignId: invite.campaignId, role: invite.role });
      return { worldId: invite.worldId, campaignId: invite.campaignId, role: invite.role };
    },
    'GET /api/locations/:id': (u, _b, p) => viewLocation(u, p.id),
    'POST /api/locations/:id/children': (u, b, p) => {
      const parent = find('locations', p.id);
      need(u, parent.worldId, 'gm');
      const loc = newLocation(parent.worldId, parent.id, {
        name: str(b.name, 'name', 120),
        type: str(b.type ?? 'location', 'type', 40),
        x: coord(b.x, 'x'),
        y: coord(b.y, 'y'),
        visibility: oneOf(b.visibility ?? find('worlds', parent.worldId).settings.defaultVisibility, VISIBILITY, 'visibility'),
      });
      record(u.id, 'location.created', { locationId: loc.id, parentId: parent.id });
      return loc;
    },
  };

  // GM edits: one generic PATCH per collection with a field whitelist. Ids never change, so renames never break links.
  const EDITABLE = {
    locations: { name: (v) => str(v, 'name', 120), visibility: (v) => oneOf(v, VISIBILITY, 'visibility') },
    maps: { name: (v) => str(v, 'name', 120), imageUrl: (v) => (v === '' ? v : safeUrl(v)) },
    pages: { title: (v) => str(v, 'title', 120), body: (v) => text(v, 'body'), gmNotes: (v) => text(v, 'gmNotes') },
  };
  for (const c of Object.keys(EDITABLE)) {
    routes[`PATCH /api/${c}/:id`] = (u, b, p) => {
      const row = find(c, p.id);
      need(u, row.worldId, 'gm');
      const changes = {};
      for (const [k, check] of Object.entries(EDITABLE[c])) if (b[k] !== undefined) changes[k] = check(b[k]);
      if (!Object.keys(changes).length) fail(400, `nothing to change; editable: ${Object.keys(EDITABLE[c]).join(', ')}`);
      Object.assign(row, changes);
      record(u.id, `${c.slice(0, -1)}.updated`, { id: row.id, fields: Object.keys(changes) });
      return row;
    };
  }

  const table = Object.entries(routes).map(([key, fn]) => {
    const [method, pattern] = key.split(' ');
    return { method, re: new RegExp('^' + pattern.replace(/:id/g, '([\\w-]+)') + '$'), fn };
  });

  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(path.join(__dirname, 'public', 'index.html')));
    }
    try {
      const route = table.find((r) => r.method === req.method && r.re.test(url.pathname)) || fail(404, 'no such route');
      const params = { id: url.pathname.match(route.re)[1] };
      const body = req.method === 'GET' ? {} : await readJson(req);
      const anonymous = req.method === 'POST' && url.pathname === '/api/users';
      const user = anonymous ? null : authenticate(req);
      send(res, 200, route.fn(user, body, params));
    } catch (e) {
      if (!e.status) console.error(e);
      send(res, e.status || 500, { error: e.status ? e.message : 'internal error' });
    }
  }

  function authenticate(req) {
    const token = (req.headers.authorization || '').replace(/^Bearer /, '');
    const h = token && hash(token);
    return (h && db.users.find((u) => u.tokenHash === h)) || fail(401, 'sign in first');
  }

  return { handle, db };
}

function text(v, name) {
  if (typeof v !== 'string' || v.length > 20000) fail(400, `${name} must be a string up to 20000 chars`);
  return v;
}
function safeUrl(v) {
  let u;
  try { u = new URL(v); } catch { fail(400, 'imageUrl must be an absolute URL'); }
  if (!['https:', 'http:'].includes(u.protocol)) fail(400, 'imageUrl must be http(s)');
  return u.href;
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 64 * 1024) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); }
    });
    req.on('end', () => {
      try { const v = raw ? JSON.parse(raw) : {}; resolve(v && typeof v === 'object' && !Array.isArray(v) ? v : {}); }
      catch { reject(Object.assign(new Error('invalid JSON'), { status: 400 })); }
    });
  });
}
function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body, (k, v) => (k === 'tokenHash' ? undefined : v)));
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const { handle } = createApp({ file: process.env.DATA_FILE || path.join(__dirname, 'data.json') });
  http.createServer(handle).listen(port, () => console.log(`Living World on http://localhost:${port}`));
}

module.exports = { createApp };
