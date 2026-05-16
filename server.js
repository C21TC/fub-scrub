const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;

// ---------- HTTPS helper ----------
function httpsRequest(options) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch(e) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ---------- FUB helpers ----------
async function fubGet(apiKey, fubPath) {
  const creds = Buffer.from(apiKey + ':').toString('base64');
  const result = await httpsRequest({
    hostname: 'api.followupboss.com',
    path: '/v1/' + fubPath,
    method: 'GET',
    headers: { 'Authorization': 'Basic ' + creds, 'Accept': 'application/json' }
  });
  if (result.status !== 200) throw new Error('FUB error ' + result.status + ': ' + JSON.stringify(result.body).slice(0, 300));
  return result.body;
}

async function fetchAllPages(apiKey, resource, key, extraParams = '', limit = 100) {
  // First page
  const first = await fubGet(apiKey, resource + '?limit=' + limit + '&offset=0' + extraParams);
  const firstItems = first[key] || [];
  const total = (first._metadata && first._metadata.total) ? parseInt(first._metadata.total) : null;

  if (firstItems.length < limit) return firstItems;

  // Build all remaining offsets up to 25000 or total
  const maxRecords = 25000;
  const cap = total ? Math.min(total, maxRecords) : maxRecords;
  const offsets = [];
  for (let off = limit; off < cap; off += limit) offsets.push(off);

  // Fetch in parallel batches of 5 to stay within rate limits
  let all = [...firstItems];
  const batchSize = 5;
  for (let i = 0; i < offsets.length; i += batchSize) {
    const batch = offsets.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map(off =>
        fubGet(apiKey, resource + '?limit=' + limit + '&offset=' + off + extraParams)
          .then(d => d[key] || []).catch(() => [])
      )
    );
    for (const items of results) {
      all = all.concat(items);
      if (items.length < limit) return all;
    }
  }
  return all;
}

// ---------- Constants ----------
const HOURS_48 = 48 * 60 * 60 * 1000;
const DAYS_7 = 7 * 24 * 60 * 60 * 1000;

const BROWSE_KEYWORDS = [
  'property view','listing view','home view','browse','browsed','viewed listing',
  'portal','property search','search alert','saved search','saved home','favorited',
  'home tour request','schedule tour','property inquiry','zillow','realtor.com',
  'redfin','homes.com','trulia','viewed property','listing inquiry','showing request',
  'website visit','web visit','site visit','visited website','page view',
  'listing alert','new listing alert'
];

const COMM_KEYWORDS = [
  'call','called','text','sms','email','emailed','voicemail','left voicemail',
  'conversation','replied','response','reached out','follow up','follow-up',
  'contacted','spoke','meeting','appointment','showing','chat','message','outreach'
];

function isBrowsing(evt) {
  const type = (evt.type || evt.category || '').toLowerCase();
  const desc = (evt.description || evt.subject || evt.body || evt.note || '').toLowerCase();
  return BROWSE_KEYWORDS.some(k => type.includes(k) || desc.includes(k));
}

function isComm(evt) {
  const type = (evt.type || evt.category || '').toLowerCase();
  const desc = (evt.description || evt.subject || evt.body || evt.note || '').toLowerCase();
  return COMM_KEYWORDS.some(k => type.includes(k) || desc.includes(k));
}

function daysSince(d) { if (!d) return 9999; return (Date.now() - new Date(d).getTime()) / 86400000; }
function hoursSince(d) { if (!d) return 9999; return (Date.now() - new Date(d).getTime()) / 3600000; }

function mapLead(l, agentMap) {
  const agentId = (l.assignedTo && l.assignedTo.id) || (l.agent && l.agent.id) || l.ownerId;
  return {
    id: l.id,
    name: l.name || 'Unknown',
    stage: l.stage || l.status || 'Unknown',
    agent: (l.assignedTo && l.assignedTo.name) || (l.agent && l.agent.name) || agentMap[agentId] || 'Unassigned',
    created: l.created,
    updated: l.updated,
    lastActivity: l.lastActivity,
    email: (l.emails && l.emails[0] && l.emails[0].value) || '',
    phone: (l.phones && l.phones[0] && l.phones[0].value) || '',
    source: l.source || l.leadSource || ''
  };
}

// ---------- Scrub logic ----------
async function runFullScrub(fubKey, agentId) {
  const [leads, events, notes, users] = await Promise.all([
    fetchAllPages(fubKey, 'people', 'people', '&sort=-created'),
    fetchAllPages(fubKey, 'events', 'events', '&sort=-created', 200),
    fetchAllPages(fubKey, 'notes', 'notes', '&sort=-created', 200),
    fubGet(fubKey, 'users?limit=200').then(d => d.users || []).catch(() => [])
  ]);

  const agentMap = {};
  users.forEach(u => { agentMap[u.id] = u.name || u.email || 'Agent'; });

  const now = Date.now();
  const cutoff48h = now - HOURS_48;
  const cutoff7d = now - DAYS_7;

  let filteredLeads = leads;
  if (agentId && agentId !== 'all') {
    filteredLeads = leads.filter(l => {
      const aid = (l.assignedTo && l.assignedTo.id) || (l.agent && l.agent.id) || l.ownerId;
      return String(aid) === String(agentId);
    });
  }

  const evtByPerson = {};
  events.forEach(e => {
    const pid = String(e.personId || (e.person && e.person.id) || '');
    if (!pid) return;
    if (!evtByPerson[pid]) evtByPerson[pid] = [];
    evtByPerson[pid].push(e);
  });

  const notesByPerson = {};
  notes.forEach(n => {
    const pid = String(n.personId || (n.person && n.person.id) || '');
    if (!pid) return;
    if (!notesByPerson[pid]) notesByPerson[pid] = [];
    notesByPerson[pid].push(n);
  });

  // New leads (48h)
  const newLeads = filteredLeads
    .filter(l => new Date(l.created).getTime() > cutoff48h)
    .map(l => ({ ...mapLead(l, agentMap), hoursAgo: Math.round(hoursSince(l.created)) }))
    .sort((a, b) => a.hoursAgo - b.hoursAgo);

  // Stage changes (48h)
  const stageChangeLeadIds = new Set();
  const stageChangeDetails = {};
  events.forEach(e => {
    if (new Date(e.created || '').getTime() < cutoff48h) return;
    const type = (e.type || e.category || '').toLowerCase();
    const desc = (e.description || e.subject || '').toLowerCase();
    if (type.includes('stage') || desc.includes('stage') || type.includes('status') || e.stageChanged) {
      const pid = String(e.personId || (e.person && e.person.id) || '');
      if (pid) {
        stageChangeLeadIds.add(pid);
        if (!stageChangeDetails[pid]) stageChangeDetails[pid] = [];
        stageChangeDetails[pid].push({ from: e.stageFrom || '—', to: e.stageTo || e.description || '', when: e.created });
      }
    }
  });
  filteredLeads.forEach(l => {
    if (l.updated && l.created && new Date(l.updated).getTime() > cutoff48h && new Date(l.updated).getTime() > new Date(l.created).getTime() + 60000) {
      stageChangeLeadIds.add(String(l.id));
    }
  });
  const stageChangedLeads = filteredLeads
    .filter(l => stageChangeLeadIds.has(String(l.id)))
    .map(l => ({ ...mapLead(l, agentMap), stageDetails: stageChangeDetails[String(l.id)] || [] }));

  // New notes (48h)
  const recentNotes = notes.filter(n => {
    if (new Date(n.created).getTime() < cutoff48h) return false;
    if (!agentId || agentId === 'all') return true;
    const pid = n.personId || (n.person && n.person.id);
    return filteredLeads.some(l => String(l.id) === String(pid));
  }).map(n => {
    const lead = filteredLeads.find(l => String(l.id) === String(n.personId || (n.person && n.person.id)));
    return {
      leadName: (n.person && n.person.name) || (lead && lead.name) || 'Unknown',
      leadStage: (lead && (lead.stage || lead.status)) || 'Unknown',
      author: (n.createdBy && n.createdBy.name) || 'Agent',
      note: (n.body || n.note || '').slice(0, 200),
      created: n.created
    };
  }).sort((a, b) => new Date(b.created) - new Date(a.created));

  // Home/website activity (7d)
  const browsingLeads = filteredLeads.filter(l => {
    return (evtByPerson[String(l.id)] || []).some(e => isBrowsing(e) && new Date(e.created || '').getTime() > cutoff7d);
  }).map(l => {
    const evts = (evtByPerson[String(l.id)] || []).filter(e => isBrowsing(e) && new Date(e.created || '').getTime() > cutoff7d);
    evts.sort((a, b) => new Date(b.created) - new Date(a.created));
    return { ...mapLead(l, agentMap), latestActivity: (evts[0] && (evts[0].description || evts[0].type)) || 'browsing', activityDate: evts[0] && evts[0].created, activityCount: evts.length };
  }).sort((a, b) => new Date(b.activityDate || 0) - new Date(a.activityDate || 0));

  // Communications (48h)
  const commLeadIds = new Set();
  const commDetails = {};
  events.forEach(e => {
    if (new Date(e.created || '').getTime() < cutoff48h) return;
    if (!isComm(e)) return;
    const pid = String(e.personId || (e.person && e.person.id) || '');
    if (!pid) return;
    commLeadIds.add(pid);
    if (!commDetails[pid]) commDetails[pid] = [];
    commDetails[pid].push({ type: e.type || e.category || 'comm', desc: (e.description || e.subject || '').slice(0, 120), when: e.created });
  });
  const commLeads = filteredLeads
    .filter(l => commLeadIds.has(String(l.id)))
    .map(l => ({ ...mapLead(l, agentMap), comms: (commDetails[String(l.id)] || []).sort((a, b) => new Date(b.when) - new Date(a.when)) }));

  // No contact ever
  const noContactLeads = filteredLeads.filter(l => {
    const evts = evtByPerson[String(l.id)] || [];
    const nts = notesByPerson[String(l.id)] || [];
    return !evts.some(e => isComm(e)) && !nts.length;
  }).map(l => ({ ...mapLead(l, agentMap), daysSinceCreated: Math.round(daysSince(l.created)) }))
    .sort((a, b) => b.daysSinceCreated - a.daysSinceCreated);

  return {
    totals: { total: filteredLeads.length, newLeads: newLeads.length, stageChanges: stageChangedLeads.length, newNotes: recentNotes.length, browsing: browsingLeads.length, comms: commLeads.length, noContact: noContactLeads.length },
    newLeads: newLeads.slice(0, 50),
    stageChangedLeads: stageChangedLeads.slice(0, 50),
    recentNotes: recentNotes.slice(0, 50),
    browsingLeads: browsingLeads.slice(0, 50),
    commLeads: commLeads.slice(0, 50),
    noContactLeads: noContactLeads.slice(0, 50)
  };
}

// ---------- Request body parser ----------
function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', chunk => raw += chunk);
    req.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve({}); } });
  });
}

// ---------- HTTP server ----------
const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url);
  const pathname = parsedUrl.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Serve static HTML
  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  // API: get agents
  if (req.method === 'POST' && pathname === '/api/agents') {
    try {
      const { fubKey } = await readBody(req);
      const data = await fubGet(fubKey, 'users?limit=200');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data.users || []));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // API: full scrub
  if (req.method === 'POST' && pathname === '/api/scrub') {
    try {
      const { fubKey, agentId } = await readBody(req);
      if (!fubKey) throw new Error('FUB API key is required');
      const result = await runFullScrub(fubKey, agentId || 'all');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, "0.0.0.0", () => {
  console.log('FUB Scrub web app running on port ' + PORT);
});
