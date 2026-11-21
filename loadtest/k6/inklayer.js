// Inklayer load test (k6). Four kinds of traffic run side by side, so each shows its own limits:
//   reads  - opening pages and docs: comment lists, a comment, the doc tree, doc search, /api/me. Some of the page
//            loads are of one busy page covered in drawings (every drawing's points come back in its comment list).
//   writes - posting comments and replies (SQLite has one writer: this is where SQLITE_BUSY shows up)
//   live   - extension tabs holding the presence WebSocket open and moving the cursor (memory per connection)
//   docs   - people typing in docs through the docs hub: an edit saved every 250 ms while typing, snapshots in the
//            pauses, carets relayed. Usually the heaviest writer, and several people share each doc.
//   media  - screenshots and recordings: uploading them with a comment, playing recordings the way a video player
//            asks (Range: bytes=0-, then seeks), and making issues that carry them to a tracker (a fake GitLab).
//            Large bodies: this is where memory runs out first. MEDIA=off leaves it out.
//
// PROFILE picks the shape (see docs/load-testing.md):
//   ci       - fixed, modest load for ~2 minutes with pass/fail thresholds. Catches regressions on every push.
//   capacity - steps the load up until it breaks; report.py turns the per-step numbers into a capacity figure.
//   soak     - holds one rate for a long time: CPU credits running out, memory growth, WAL growth.
import http from 'k6/http';
import { check, fail, sleep } from 'k6';
import { WebSocket } from 'k6/websockets';
import { Counter, Trend } from 'k6/metrics';
import { randomBytes } from 'k6/crypto';
import encoding from 'k6/encoding';

const BASE_URL = (__ENV.BASE_URL || 'https://inklayer.internal').replace(/\/$/, '');
const PROFILE = __ENV.PROFILE || 'ci';
const OIDC_METADATA = __ENV.OIDC_METADATA || 'http://oidc:8080/loadtest/.well-known/openid-configuration';
const SEED_COMMENTS = int('SEED_COMMENTS', 400);
const SEED_DOCS = int('SEED_DOCS', 40);
const PAGES = 25;
// One page marked up heavily: BUSY_DRAWINGS freehand drawings of DRAWING_KB each (a few seconds of scribbling is
// 5-30 KB). Its comment list carries all of them, so it's the heaviest read; BUSY_PAGE_SHARE of reads load it.
const BUSY_DRAWINGS = int('BUSY_DRAWINGS', 60);
const DRAWING_KB = int('DRAWING_KB', 20);
const BUSY_PAGE_SHARE = parseFloat(__ENV.BUSY_PAGE_SHARE || '0.1');
const BUSY_PAGE = 'https://shop.loadtest.example/checkout/review';
// Editors share this many docs, so several people are in each one (edits relayed to the others, snapshots racing).
const EDITED_DOCS = int('EDITED_DOCS', 5);
const MEDIA = (__ENV.MEDIA || 'on') !== 'off';
const MB = 1024 * 1024;
// A recording is at most 40 MB; a minute or so of a tab is about 20 MB.
const VIDEO_BYTES = int('VIDEO_MB', 20) * MB;
const FULLPAGE_BYTES = int('FULLPAGE_MB', 4) * MB;
const SCREENSHOT_BYTES = int('SCREENSHOT_KB', 300) * 1024;
const SEED_MEDIA_COMMENTS = int('SEED_MEDIA_COMMENTS', 4);
const FAKE_GITLAB = __ENV.FAKE_GITLAB || 'https://gitlab.internal';

const liveErrors = new Counter('live_errors');
const liveMessages = new Counter('live_messages');
// Time from sending an edit (or snapshot) to the server confirming it was stored.
const docSave = new Trend('doc_save_duration', true);
const docSnapshot = new Trend('doc_snapshot_duration', true);
const docErrors = new Counter('doc_errors');

function int(name, fallback) {
  const v = parseInt(__ENV[name] || '', 10);
  return Number.isFinite(v) ? v : fallback;
}

// ---------------------------------------------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------------------------------------------

function ciScenarios() {
  const duration = __ENV.DURATION || '2m';
  return {
    reads: { executor: 'constant-arrival-rate', exec: 'reads', rate: int('READ_RPS', 40), timeUnit: '1s', duration, preAllocatedVUs: 20, maxVUs: 200 },
    writes: { executor: 'constant-arrival-rate', exec: 'writes', rate: int('WRITE_RPS', 5), timeUnit: '1s', duration, preAllocatedVUs: 5, maxVUs: 50 },
    live: { executor: 'constant-vus', exec: 'live', vus: int('LIVE_CONNECTIONS', 40), duration },
    docs: { executor: 'constant-vus', exec: 'docEditor', vus: int('DOC_EDITORS', 5), duration },
    ...mediaScenarios({
      uploads: { executor: 'constant-arrival-rate', rate: int('UPLOADS_PER_MIN', 6), timeUnit: '1m', duration, preAllocatedVUs: 2, maxVUs: 10 },
      plays: { executor: 'constant-vus', vus: int('PLAYERS', 4), duration },
      issues: { executor: 'constant-arrival-rate', rate: int('ISSUES_PER_MIN', 4), timeUnit: '1m', duration, preAllocatedVUs: 2, maxVUs: 10 },
    }),
  };
}

// The media scenarios, unless MEDIA=off. Uploads and issues are per minute: each one moves tens of megabytes.
function mediaScenarios({ uploads, plays, issues }) {
  if (!MEDIA) return {};
  return {
    media_uploads: { exec: 'mediaUpload', ...uploads },
    media_plays: { exec: 'mediaPlay', ...plays },
    media_issues: { exec: 'mediaIssue', ...issues },
  };
}

// Equal steps from a tenth of the maximum up to the maximum. Each step lasts STEP_SECONDS; report.py reads them back.
function capacityScenarios() {
  const steps = int('STEPS', 10);
  const stepSeconds = int('STEP_SECONDS', 60);
  const maxReads = int('MAX_READ_RPS', 400);
  const maxWrites = int('MAX_WRITE_RPS', 40);
  const maxLive = int('MAX_LIVE_CONNECTIONS', 400);
  const maxEditors = int('MAX_DOC_EDITORS', 40);
  const maxUploads = int('MAX_UPLOADS_PER_MIN', 30);
  const maxPlayers = int('MAX_PLAYERS', 30);
  const maxIssues = int('MAX_ISSUES_PER_MIN', 30);
  const stages = (max) => {
    const out = [];
    for (let i = 1; i <= steps; i++) {
      const target = Math.max(1, Math.round((max * i) / steps));
      out.push({ target, duration: '5s' }, { target, duration: `${stepSeconds - 5}s` });
    }
    return out;
  };
  return {
    reads: { executor: 'ramping-arrival-rate', exec: 'reads', startRate: 1, timeUnit: '1s', preAllocatedVUs: 50, maxVUs: 2000, stages: stages(maxReads) },
    writes: { executor: 'ramping-arrival-rate', exec: 'writes', startRate: 1, timeUnit: '1s', preAllocatedVUs: 10, maxVUs: 500, stages: stages(maxWrites) },
    live: { executor: 'ramping-vus', exec: 'live', startVUs: 0, stages: stages(maxLive) },
    docs: { executor: 'ramping-vus', exec: 'docEditor', startVUs: 0, stages: stages(maxEditors) },
    ...mediaScenarios({
      uploads: { executor: 'ramping-arrival-rate', startRate: 1, timeUnit: '1m', preAllocatedVUs: 2, maxVUs: 40, stages: stages(maxUploads) },
      plays: { executor: 'ramping-vus', startVUs: 0, stages: stages(maxPlayers) },
      issues: { executor: 'ramping-arrival-rate', startRate: 1, timeUnit: '1m', preAllocatedVUs: 2, maxVUs: 40, stages: stages(maxIssues) },
    }),
  };
}

function soakScenarios() {
  const duration = __ENV.DURATION || '60m';
  return {
    reads: { executor: 'constant-arrival-rate', exec: 'reads', rate: int('READ_RPS', 100), timeUnit: '1s', duration, preAllocatedVUs: 50, maxVUs: 1000 },
    writes: { executor: 'constant-arrival-rate', exec: 'writes', rate: int('WRITE_RPS', 10), timeUnit: '1s', duration, preAllocatedVUs: 10, maxVUs: 200 },
    live: { executor: 'constant-vus', exec: 'live', vus: int('LIVE_CONNECTIONS', 100), duration },
    docs: { executor: 'constant-vus', exec: 'docEditor', vus: int('DOC_EDITORS', 10), duration },
    ...mediaScenarios({
      uploads: { executor: 'constant-arrival-rate', rate: int('UPLOADS_PER_MIN', 3), timeUnit: '1m', duration, preAllocatedVUs: 2, maxVUs: 10 },
      plays: { executor: 'constant-vus', vus: int('PLAYERS', 3), duration },
      issues: { executor: 'constant-arrival-rate', rate: int('ISSUES_PER_MIN', 2), timeUnit: '1m', duration, preAllocatedVUs: 2, maxVUs: 10 },
    }),
  };
}

const scenarios = { ci: ciScenarios, capacity: capacityScenarios, soak: soakScenarios }[PROFILE];
if (!scenarios) {
  throw new Error(`Unknown PROFILE '${PROFILE}' (ci, capacity or soak)`);
}

// CI fails the build on these. Capacity and soak runs record them but are judged by report.py.
const ciThresholds = {
  'http_req_failed{kind:read}': ['rate<0.01'],
  'http_req_failed{kind:write}': ['rate<0.01'],
  'http_req_duration{kind:read}': [`p(95)<${int('READ_P95_MS', 300)}`],
  'http_req_duration{kind:write}': [`p(95)<${int('WRITE_P95_MS', 600)}`],
  checks: ['rate>0.99'],
  live_errors: ['count<1'],
  doc_save_duration: [`p(95)<${int('DOC_SAVE_P95_MS', 600)}`],
  doc_errors: ['count<1'],
  ...(MEDIA ? {
    'http_req_failed{kind:media}': ['rate<0.01'],
    // Whole recordings and uploads of tens of megabytes: generous, it's the failures that matter.
    'http_req_duration{kind:media}': [`p(95)<${int('MEDIA_P95_MS', 10000)}`],
  } : {}),
};

export const options = {
  scenarios: scenarios(),
  thresholds: PROFILE === 'ci' ? ciThresholds : {
    'http_req_duration{kind:read}': ['p(95)<100000'],
    'http_req_duration{kind:write}': ['p(95)<100000'],
    doc_save_duration: ['p(95)<100000'],
    ...(MEDIA ? { 'http_req_duration{kind:media}': ['p(95)<1000000'] } : {}),
  },
  setupTimeout: '5m',
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

// ---------------------------------------------------------------------------------------------------------------
// Setup: sign in once, create an organisation and project, and seed comments and docs to read.
// ---------------------------------------------------------------------------------------------------------------

function pageUrl(i) {
  return `https://shop.loadtest.example/products/${i}`;
}

// The presence hub identifies a page by 64 lowercase hex characters.
function pageKey(i) {
  return (i.toString(16).padStart(8, '0')).repeat(8);
}

function annotationBody(url, text) {
  return JSON.stringify({
    url,
    kind: 'Pin',
    body: text,
    anchor: { element: { path: ['main', 'h1'], tag: 'h1' } },
    geometry: { kind: 'Pin', point: { x: Math.random(), y: Math.random() } },
    viewportWidth: 1280,
  });
}

// The containers start in any order and the provider (a JVM) takes a while: wait for both to answer.
function waitUntilReady() {
  const deadline = Date.now() + 120000;
  for (;;) {
    const server = http.get(`${BASE_URL}/health/ready`, { tags: { kind: 'setup' }, responseCallback: http.expectedStatuses(200, 503) });
    const provider = http.get(OIDC_METADATA, { tags: { kind: 'setup' }, responseCallback: http.expectedStatuses(200) });
    if (server.status === 200 && provider.status === 200) return;
    if (Date.now() > deadline) fail(`Not ready after 2 minutes: server ${server.status}, sign-in provider ${provider.status}`);
    sleep(2);
  }
}

export function setup() {
  waitUntilReady();

  // Sign in through the stand-in OIDC provider: /auth/login -> provider -> /auth/callback -> session cookie.
  let login = http.get(`${BASE_URL}/auth/login?provider=loadtest&returnUrl=%2F`, { tags: { kind: 'setup' } });
  // The provider answers with a self-submitting form (response_mode=form_post); a browser's script posts it back.
  if (login.status === 200 && login.html('form').size() > 0) {
    login = login.submitForm({ formSelector: 'form', params: { tags: { kind: 'setup' } } });
  }
  const jar = http.cookieJar().cookiesForURL(BASE_URL);
  const cookie = Object.keys(jar).map((name) => `${name}=${jar[name][0]}`).join('; ');
  const headers = { Cookie: cookie, 'Content-Type': 'application/json', 'X-Inklayer-Csrf': '1' };

  const me = http.get(`${BASE_URL}/api/me`, { headers, tags: { kind: 'setup' } });
  if (me.status !== 200) {
    fail(`Sign-in failed: /auth/login ended at ${login.url} (${login.status}); /api/me answered ${me.status}`);
  }

  const post = (path, body) => {
    const res = http.post(`${BASE_URL}${path}`, JSON.stringify(body), { headers, tags: { kind: 'setup' } });
    if (res.status !== 201 && res.status !== 200) {
      fail(`POST ${path} answered ${res.status}: ${res.body}`);
    }
    return res.json();
  };

  const org = post('/api/orgs', { name: `Load test ${Date.now()}` });
  const project = post(`/api/orgs/${org.id}/projects`, { name: 'Shop' });

  const commentIds = [];
  const batchSize = 20;
  for (let start = 0; start < SEED_COMMENTS; start += batchSize) {
    const requests = [];
    for (let i = start; i < Math.min(start + batchSize, SEED_COMMENTS); i++) {
      requests.push(['POST', `${BASE_URL}/api/projects/${project.id}/live/annotations`,
        annotationBody(pageUrl(i % PAGES), `Seed comment ${i}: the button overlaps the price on narrow screens.`),
        { headers, tags: { kind: 'setup' } }]);
    }
    for (const res of http.batch(requests)) {
      if (res.status !== 201) fail(`Seeding a comment answered ${res.status}: ${res.body}`);
      commentIds.push(res.json().id);
    }
  }

  // The busy page: drawings stored as the extension stores them, [x, y, pressure] with 4 decimals (about 22 bytes a point).
  const points = [];
  for (let i = 0; i < Math.floor((DRAWING_KB * 1024) / 22); i++) {
    points.push([Math.round(Math.random() * 1e4) / 1e4, Math.round(Math.random() * 1e4) / 1e4, 0.5]);
  }
  for (let start = 0; start < BUSY_DRAWINGS; start += batchSize) {
    const requests = [];
    for (let i = start; i < Math.min(start + batchSize, BUSY_DRAWINGS); i++) {
      requests.push(['POST', `${BASE_URL}/api/projects/${project.id}/live/annotations`, JSON.stringify({
        url: BUSY_PAGE, kind: 'Ink', body: `Drawing ${i}: this whole section needs more spacing.`,
        anchor: { element: { path: ['main'], tag: 'main' } }, geometry: { kind: 'Ink', size: 4, points }, viewportWidth: 1280,
      }), { headers, tags: { kind: 'setup' } }]);
    }
    for (const res of http.batch(requests)) {
      if (res.status !== 201) fail(`Seeding a drawing answered ${res.status}: ${res.body}`);
    }
  }

  const docIds = [];
  for (let i = 0; i < SEED_DOCS; i++) {
    docIds.push(post(`/api/orgs/${org.id}/docs`, { folder: i % 2 ? 'Guides' : 'Specs', title: `Checkout spec ${i}` }).id);
  }

  let media = { trackerId: null, commentIds: [] };
  if (MEDIA) {
    const tracker = post(`/api/projects/${project.id}/issue-trackers`,
      { kind: 'gitlab', token: 'load-test', settings: { site: FAKE_GITLAB, projectKey: 'acme/shop' } });
    for (let i = 0; i < SEED_MEDIA_COMMENTS; i++) {
      media.commentIds.push(commentWithMedia({ cookie }, project.id, 'setup'));
    }
    media = { trackerId: tracker.id, commentIds: media.commentIds };
  }

  return { cookie, orgId: org.id, projectId: project.id, commentIds, docIds, media };
}

// ---------------------------------------------------------------------------------------------------------------
// Traffic
// ---------------------------------------------------------------------------------------------------------------

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function headersFor(data) {
  return { Cookie: data.cookie, 'Content-Type': 'application/json', 'X-Inklayer-Csrf': '1' };
}

function get(data, path, name) {
  const res = http.get(`${BASE_URL}${path}`, { headers: headersFor(data), tags: { kind: 'read', name } });
  check(res, { [`${name}: 200`]: (r) => r.status === 200 });
  return res;
}

// One request per iteration, weighted roughly like real use: comment lists dominate (every page load in the extension).
export function reads(data) {
  if (BUSY_DRAWINGS > 0 && Math.random() < BUSY_PAGE_SHARE) {
    get(data, `/api/live/annotations?url=${encodeURIComponent(BUSY_PAGE)}`, 'busy page comments');
    return;
  }
  const roll = Math.random();
  if (roll < 0.45) {
    get(data, `/api/live/annotations?url=${encodeURIComponent(pageUrl(Math.floor(Math.random() * PAGES)))}`, 'page comments');
  } else if (roll < 0.65) {
    get(data, `/api/annotations/${pick(data.commentIds)}`, 'comment');
  } else if (roll < 0.75) {
    get(data, '/api/me', 'me');
  } else if (roll < 0.85) {
    get(data, `/api/orgs/${data.orgId}/docs`, 'doc tree');
  } else if (roll < 0.93) {
    get(data, `/api/docs/${pick(data.docIds)}`, 'doc');
  } else {
    get(data, `/api/orgs/${data.orgId}/docs/search?q=checkout`, 'doc search');
  }
}

export function writes(data) {
  const params = { headers: headersFor(data) };
  if (Math.random() < 0.5) {
    const res = http.post(`${BASE_URL}/api/projects/${data.projectId}/live/annotations`,
      annotationBody(pageUrl(Math.floor(Math.random() * PAGES)), 'Load test comment'),
      { ...params, tags: { kind: 'write', name: 'new comment' } });
    check(res, { 'new comment: 201': (r) => r.status === 201 });
  } else {
    const res = http.post(`${BASE_URL}/api/annotations/${pick(data.commentIds)}/replies`,
      JSON.stringify({ body: 'Load test reply' }),
      { ...params, tags: { kind: 'write', name: 'reply' } });
    check(res, { 'reply: 201': (r) => r.status === 201 || r.status === 200 });
  }
}

// A tab with the extension open: holds the presence connection for LIVE_SECONDS, moving the cursor twice a second.
export function live(data) {
  const ticket = http.post(`${BASE_URL}/api/presence/ticket`, null, { headers: headersFor(data), tags: { kind: 'live', name: 'presence ticket' } });
  if (!check(ticket, { 'presence ticket: 200': (r) => r.status === 200 })) {
    liveErrors.add(1);
    sleep(2); // as the extension waits before trying again, rather than hammering a server that's down
    return;
  }

  const RS = '\x1e'; // SignalR JSON protocol record separator
  const page = pageKey(Math.floor(Math.random() * PAGES));
  const holdMs = int('LIVE_SECONDS', 30) * 1000;
  const url = `${BASE_URL.replace(/^http/, 'ws')}/api/presence/hub?access_token=${encodeURIComponent(ticket.json().ticket)}`;
  const ws = new WebSocket(url, null, { tags: { kind: 'live', name: 'presence hub' } });
  let handshakeDone = false;
  let closingOnPurpose = false;
  // The server may close the connection first (overloaded, or it dropped us): stop sending then.
  const send = (message) => {
    if (ws.readyState === 1) ws.send(JSON.stringify(message) + RS);
  };
  let cursorTimer;
  let pingTimer;

  ws.onopen = () => send({ protocol: 'json', version: 1 });

  ws.onmessage = (e) => {
    for (const frame of String(e.data).split(RS).filter(Boolean)) {
      const msg = JSON.parse(frame);
      liveMessages.add(1);
      if (!handshakeDone) {
        handshakeDone = true;
        if (msg.error) {
          liveErrors.add(1);
          closingOnPurpose = true;
          ws.close();
          return;
        }
        send({ type: 1, invocationId: '1', target: 'Join', arguments: [page] });
        cursorTimer = setInterval(() => {
          send({ type: 1, target: 'Cursor', arguments: [page, { x: Math.random() * 1280, y: Math.random() * 4000 }] });
        }, 500);
        pingTimer = setInterval(() => send({ type: 6 }), 10000);
        setTimeout(() => {
          closingOnPurpose = true;
          ws.close();
        }, holdMs);
      } else if (msg.type === 3 && msg.error) {
        liveErrors.add(1); // a hub method failed
      } else if (msg.type === 7) {
        liveErrors.add(1); // the server closed the connection
      }
    }
  };

  ws.onerror = () => liveErrors.add(1);
  ws.onclose = () => {
    if (!closingOnPurpose) liveErrors.add(1); // dropped before the tab was done with it
    clearInterval(cursorTimer);
    clearInterval(pingTimer);
  };
}

// Someone typing in a doc, in the viewer. Like the editor (client/apps/viewer/src/docs/collab.ts): while typing, an edit
// goes out every 250 ms and carets about every 120 ms; after a pause the tab saves a snapshot (merged state + markdown,
// which the server indexes for search and history). Also answers the server's "compact" requests with a snapshot.
// The server never reads the Yjs bytes, so random bytes of a realistic size exercise the same storage path.
export function docEditor(data) {
  const ticket = http.post(`${BASE_URL}/api/presence/ticket`, null, { headers: headersFor(data), tags: { kind: 'live', name: 'presence ticket' } });
  if (!check(ticket, { 'docs ticket: 200': (r) => r.status === 200 })) {
    docErrors.add(1);
    sleep(2);
    return;
  }

  const RS = '\x1e';
  const docId = data.docIds[Math.floor(Math.random() * Math.min(EDITED_DOCS, data.docIds.length))];
  const typingMs = int('TYPING_SECONDS', 8) * 1000;
  const pauseMs = int('PAUSE_SECONDS', 6) * 1000;
  const holdMs = int('EDIT_SECONDS', 45) * 1000;
  const url = `${BASE_URL.replace(/^http/, 'ws')}/api/docs/hub?access_token=${encodeURIComponent(ticket.json().ticket)}`;
  const ws = new WebSocket(url, null, { tags: { kind: 'docs', name: 'docs hub' } });

  const pending = {}; // invocationId -> { kind, at }
  let nextId = 1;
  let seq = 0;
  let opened = false;
  let closingOnPurpose = false;
  let markdown = `# Checkout spec\n\n${'The checkout page shows the order summary next to the payment form. '.repeat(20)}\n`;
  const timers = [];

  const send = (message) => {
    if (ws.readyState === 1) ws.send(JSON.stringify(message) + RS);
  };
  const invoke = (kind, target, args) => {
    const id = String(nextId++);
    pending[id] = { kind, at: Date.now() };
    send({ type: 1, invocationId: id, target, arguments: args });
  };
  const bytes = (n) => encoding.b64encode(randomBytes(n));
  const snapshot = () => {
    if (seq > 0) invoke('snapshot', 'Snapshot', [docId, bytes(Math.min(markdown.length, 60000)), markdown, seq]);
  };

  // Typing bursts and pauses, until it's time to close the tab.
  let typing = false;
  const startTyping = () => {
    typing = true;
    timers.push(setTimeout(() => {
      typing = false;
      timers.push(setTimeout(() => {
        snapshot();
        startTyping();
      }, pauseMs));
    }, typingMs));
  };

  ws.onopen = () => send({ protocol: 'json', version: 1 });

  ws.onmessage = (e) => {
    for (const frame of String(e.data).split(RS).filter(Boolean)) {
      const msg = JSON.parse(frame);
      if (!opened) {
        opened = true;
        if (msg.error) {
          docErrors.add(1);
          closingOnPurpose = true;
          ws.close();
          return;
        }
        invoke('open', 'Open', [docId, Math.floor(Math.random() * 2147483647)]);
        continue;
      }

      if (msg.type === 3) {
        const call = pending[msg.invocationId];
        delete pending[msg.invocationId];
        if (!call) continue;
        if (msg.error) {
          docErrors.add(1, { name: call.kind });
          continue;
        }
        const took = Date.now() - call.at;
        if (call.kind === 'open') {
          const updates = msg.result.updates || [];
          seq = updates.length ? updates[updates.length - 1].seq : msg.result.snapshotSeq;
          startTyping();
          timers.push(setInterval(() => {
            if (!typing) return;
            markdown += 'More detail about the checkout page. '.slice(0, 5 + Math.floor(Math.random() * 30));
            if (markdown.length > 20000) markdown = markdown.slice(0, 4000);
            invoke('edit', 'Update', [docId, bytes(20 + Math.floor(Math.random() * 60))]);
          }, 250));
          timers.push(setInterval(() => {
            if (typing) send({ type: 1, target: 'Awareness', arguments: [docId, bytes(40)] });
          }, 120));
          timers.push(setInterval(() => send({ type: 6 }), 10000));
          timers.push(setTimeout(() => {
            snapshot();
            timers.push(setTimeout(() => {
              closingOnPurpose = true;
              ws.close();
            }, 1000));
          }, holdMs));
        } else if (call.kind === 'edit') {
          docSave.add(took);
          if (msg.result > seq) seq = msg.result;
        } else if (call.kind === 'snapshot') {
          docSnapshot.add(took);
        }
      } else if (msg.type === 1 && msg.target === 'update') {
        const theirs = msg.arguments[1];
        if (theirs > seq) seq = theirs;
      } else if (msg.type === 1 && msg.target === 'compact') {
        snapshot();
      } else if (msg.type === 7) {
        docErrors.add(1, { name: 'server closed' });
      }
    }
  };

  ws.onerror = () => docErrors.add(1, { name: 'socket error' });
  ws.onclose = () => {
    for (const t of timers) {
      clearInterval(t);
      clearTimeout(t);
    }
    if (!closingOnPurpose) docErrors.add(1, { name: 'dropped' });
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------------------------------------------

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const WEBM = [0x1a, 0x45, 0xdf, 0xa3];
const files = {}; // made once per VU, on first use: every VU of every scenario runs this file, most never need them

// A file of the given size starting with the format's signature (the server checks it); the rest is filler.
function file(name, size, signature) {
  if (!files[name]) {
    const bytes = new Uint8Array(size);
    for (let i = signature.length; i < size; i += 4096) bytes[i] = i & 0xff;
    bytes.set(signature);
    files[name] = bytes.buffer;
  }
  return files[name];
}

function put(data, path, body, type, name, kind) {
  const res = http.put(`${BASE_URL}${path}`, body, {
    headers: { Cookie: data.cookie, 'Content-Type': type, 'X-Inklayer-Csrf': '1' },
    tags: { kind, name }, timeout: '180s', responseType: 'none',
  });
  check(res, { [`${name}: 204`]: (r) => r.status === 204 });
}

// A comment as someone who recorded the bug makes it: the comment, its screenshot, full page, recording and its still.
function commentWithMedia(data, projectId, kind) {
  const created = http.post(`${BASE_URL}/api/projects/${projectId}/live/annotations`,
    annotationBody(pageUrl(Math.floor(Math.random() * PAGES)), 'Recorded: the menu jumps when scrolling'),
    { headers: headersFor(data), tags: { kind, name: 'new comment' } });
  if (!check(created, { 'media comment: 201': (r) => r.status === 201 })) {
    if (kind === 'setup') fail(`Creating a comment for media answered ${created.status}: ${created.body}`);
    return null;
  }
  const id = created.json().id;
  put(data, `/api/annotations/${id}/screenshot?width=1280&height=800`, file('screenshot', SCREENSHOT_BYTES, PNG), 'image/png', 'upload screenshot', kind);
  put(data, `/api/annotations/${id}/media/fullpage?width=1280&height=9000`, file('fullpage', FULLPAGE_BYTES, PNG), 'image/png', 'upload full page', kind);
  put(data, `/api/annotations/${id}/media/video?width=1280&height=800`, file('video', VIDEO_BYTES, WEBM), 'video/webm', 'upload recording', kind);
  put(data, `/api/annotations/${id}/media/thumbnail?width=640&height=400`, file('thumbnail', 200 * 1024, PNG), 'image/png', 'upload still', kind);
  return id;
}

export function mediaUpload(data) {
  commentWithMedia(data, data.projectId, 'media');
}

// Someone opening a comment's recording: the player asks for "bytes=0-" (the whole file), and sometimes seeks.
export function mediaPlay(data) {
  const id = pick(data.media.commentIds);
  const play = (range, name) => {
    const res = http.get(`${BASE_URL}/api/annotations/${id}/media/video`, {
      headers: { Cookie: data.cookie, Range: range }, tags: { kind: 'media', name }, timeout: '180s', responseType: 'none',
    });
    check(res, { [`${name}: 206`]: (r) => r.status === 206 });
  };
  play('bytes=0-', 'play recording');
  if (Math.random() < 0.5) {
    play(`bytes=${Math.floor(Math.random() * (VIDEO_BYTES - 1))}-`, 'seek recording');
  }
  if (Math.random() < 0.3) {
    const res = http.get(`${BASE_URL}/api/annotations/${id}/media/fullpage`, {
      headers: { Cookie: data.cookie }, tags: { kind: 'media', name: 'full page' }, timeout: '180s', responseType: 'none',
    });
    check(res, { 'full page: 200': (r) => r.status === 200 });
  }
  sleep(1);
}

// An issue made from a comment with a recording: the server sends the screenshot, full page, recording and still to GitLab.
export function mediaIssue(data) {
  const res = http.post(`${BASE_URL}/api/annotations/${pick(data.media.commentIds)}/issues`, JSON.stringify({ connectionId: data.media.trackerId }), {
    headers: headersFor(data), tags: { kind: 'media', name: 'issue with files' }, timeout: '180s',
  });
  check(res, { 'issue with files: 201': (r) => r.status === 201 });
}
