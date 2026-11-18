// Saves shared grocery lists in the Upstash Redis database connected to this Vercel project.
// GET  /api/list?id=abc123          -> { id, v, items }
// POST /api/list  { items }         -> creates a list, returns { id, v, items }
// POST /api/list?id=abc123 { ops }  -> applies changes, returns { id, v, items }

const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const KEEP_SECONDS = 60 * 60 * 24 * 365;   // lists are kept for a year after the last change
const MAX_ITEMS = 300;
const LANGS = ["en", "ar", "si", "ta"];

// Save only if nobody else saved in the meantime (compares the version number).
const SAVE_IF_SAME_VERSION = `
local cur = redis.call('GET', KEYS[1])
local curV = 0
if cur then curV = cjson.decode(cur).v end
if curV ~= tonumber(ARGV[1]) then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'EX', tonumber(ARGV[3]))
return 1`;

async function redis(cmd) {
  const res = await fetch(URL_, {
    method: "POST",
    headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify(cmd)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(data.error || "database error " + res.status);
  return data.result;
}

const key = id => "list:" + id;
const str = (v, max) => String(v == null ? "" : v).slice(0, max);

function cleanItem(i) {
  if (!i || typeof i !== "object" || !i.id || !i.text) return null;
  const tr = {};
  if (i.tr && typeof i.tr === "object") LANGS.forEach(l => { if (i.tr[l]) tr[l] = str(i.tr[l], 200); });
  return {
    id: str(i.id, 40),
    text: str(i.text, 200),
    lang: LANGS.includes(i.lang) ? i.lang : "en",
    done: !!i.done,
    tr
  };
}

// The same rules the app uses on the phone, so both always agree.
function applyOp(items, op) {
  if (!op || typeof op !== "object") return items;
  switch (op.type) {
    case "add": {
      const item = cleanItem(op.item);
      if (!item || items.some(i => i.id === item.id) || items.length >= MAX_ITEMS) return items;
      return [item, ...items];
    }
    case "toggle":
      return items.map(i => (i.id === op.id ? { ...i, done: !!op.done } : i));
    case "remove":
      return items.filter(i => i.id !== op.id);
    case "clearDone":
      return items.filter(i => !i.done);
    case "setTr":
      return items.map(i => {
        if (i.id !== op.id || !op.tr || typeof op.tr !== "object") return i;
        const tr = { ...i.tr };
        LANGS.forEach(l => { if (op.tr[l] && !tr[l]) tr[l] = str(op.tr[l], 200); });
        return { ...i, tr };
      });
    default:
      return items;
  }
}

function newId() {
  const abc = "abcdefghijkmnpqrstuvwxyz23456789";   // no look-alike letters such as l/1, o/0
  let s = "";
  for (let k = 0; k < 6; k++) s += abc[Math.floor(Math.random() * abc.length)];
  return s;
}

async function readList(id) {
  const raw = await redis(["GET", key(id)]);
  return raw ? JSON.parse(raw) : null;
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!URL_ || !TOKEN) return res.status(503).json({ error: "no_database" });

  try {
    const id = typeof req.query.id === "string" ? req.query.id.toLowerCase() : "";
    if (id && !/^[a-z0-9]{4,12}$/.test(id)) return res.status(400).json({ error: "bad_id" });

    if (req.method === "GET") {
      if (!id) return res.status(400).json({ error: "missing_id" });
      const list = await readList(id);
      if (!list) return res.status(404).json({ error: "not_found" });
      return res.status(200).json({ id, v: list.v, items: list.items });
    }

    if (req.method !== "POST") return res.status(405).json({ error: "method" });
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});

    // Create a new shared list.
    if (!id) {
      const items = (Array.isArray(body.items) ? body.items : []).map(cleanItem).filter(Boolean).slice(0, MAX_ITEMS);
      for (let attempt = 0; attempt < 5; attempt++) {
        const nid = newId();
        const doc = { v: 1, items };
        const ok = await redis(["SET", key(nid), JSON.stringify(doc), "EX", String(KEEP_SECONDS), "NX"]);
        if (ok === "OK") return res.status(200).json({ id: nid, v: 1, items });
      }
      return res.status(500).json({ error: "id_busy" });
    }

    // Apply changes to an existing list, retrying if two phones save at the same moment.
    const ops = Array.isArray(body.ops) ? body.ops.slice(0, 100) : [];
    for (let attempt = 0; attempt < 6; attempt++) {
      const list = await readList(id);
      if (!list) return res.status(404).json({ error: "not_found" });
      const items = ops.reduce(applyOp, list.items);
      const doc = { v: list.v + 1, items };
      const saved = await redis(["EVAL", SAVE_IF_SAME_VERSION, "1", key(id), String(list.v), JSON.stringify(doc), String(KEEP_SECONDS)]);
      if (saved === 1) return res.status(200).json({ id, v: doc.v, items });
    }
    return res.status(409).json({ error: "busy" });
  } catch (e) {
    return res.status(500).json({ error: "server", detail: String(e.message || e) });
  }
};

module.exports.applyOp = applyOp;
