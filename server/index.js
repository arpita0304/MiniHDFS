import express from "express";
import cors from "cors";
import multer from "multer";
import mongoose from "mongoose";
import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "storage");
const NODE_NAMES = ["node1", "node2", "node3", "node4"];
const REPLICATION = 2;
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

// --- AES-256-GCM: the whole file is encrypted first, then split into blocks ---
let KEY;
const encrypt = (buf) => {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const ct = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
};
const decrypt = (buf) => {
  const d = crypto.createDecipheriv("aes-256-gcm", KEY, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]);
};

const NodeM = mongoose.model("Node", new mongoose.Schema({ name: String, online: { type: Boolean, default: true } }));
const FileM = mongoose.model("File", new mongoose.Schema({
  name: String, size: Number, mime: String, blockSize: Number, sha256: String, encrypted: Boolean,
  blocks: [{ index: Number, id: String, size: Number, sha256: String, nodes: [String] }],
}, { timestamps: true }));

// --- storage layer (swap these two for WebHDFS in phase 4) ---
const writeBlock = (node, id, buf) => fs.writeFile(path.join(ROOT, node, id + ".blk"), buf);
const readBlock = (node, id) => fs.readFile(path.join(ROOT, node, id + ".blk"));

async function onlineSet() {
  return new Set((await NodeM.find({ online: true })).map((n) => n.name));
}
function blockStatus(block, online) {
  const live = block.nodes.filter((n) => online.has(n)).length;
  return live === 0 ? "missing" : live < REPLICATION ? "under-replicated" : "healthy";
}
const view = (f, online) => ({
  ...f.toObject(),
  blocks: f.blocks.map((b) => ({ ...b.toObject(), status: blockStatus(b, online) })),
});

// --- auto re-replication (like the HDFS replication monitor) ---
let autoHeal = true, healing = false;
const events = [];
const log = (msg) => { events.unshift({ t: new Date().toISOString(), msg }); events.length = Math.min(events.length, 30); };

async function heal() {
  if (healing) return { copied: 0, trimmed: 0 };
  healing = true;
  let copied = 0, trimmed = 0;
  try {
    const online = await onlineSet();
    const load = Object.fromEntries(NODE_NAMES.map((n) => [n, 0]));
    const files = await FileM.find();
    files.forEach((f) => f.blocks.forEach((b) => b.nodes.forEach((n) => load[n]++)));
    for (const f of files) {
      let dirty = false;
      for (const b of f.blocks) {
        const live = b.nodes.filter((n) => online.has(n));
        if (live.length > 0 && live.length < REPLICATION) {
          let data = null;
          for (const n of live) {
            try { const d = await readBlock(n, b.id); if (sha(d) === b.sha256) { data = d; break; } } catch { /* try next */ }
          }
          if (!data) continue;
          const targets = [...online].filter((n) => !b.nodes.includes(n)).sort((x, y) => load[x] - load[y]).slice(0, REPLICATION - live.length);
          for (const t of targets) {
            await writeBlock(t, b.id, data); b.nodes.push(t); load[t]++; copied++; dirty = true;
            log(`Re-replicated ${f.name} block ${b.index} to ${t}`);
          }
        } else if (live.length > REPLICATION) {
          const extra = [...live].sort((x, y) => load[y] - load[x]).slice(0, live.length - REPLICATION);
          for (const n of extra) {
            await fs.rm(path.join(ROOT, n, b.id + ".blk"), { force: true });
            b.nodes = b.nodes.filter((x) => x !== n); load[n]--; trimmed++; dirty = true;
            log(`Removed surplus replica of ${f.name} block ${b.index} from ${n}`);
          }
        }
      }
      if (dirty) { f.markModified("blocks"); await f.save(); }
    }
  } finally { healing = false; }
  return { copied, trimmed };
}

async function reconstruct(file) {
  const online = await onlineSet();
  const parts = [], missing = [];
  for (const b of file.blocks) {
    let data = null;
    for (const n of b.nodes.filter((n) => online.has(n))) {
      try { const d = await readBlock(n, b.id); if (sha(d) === b.sha256) { data = d; break; } } catch { /* try next replica */ }
    }
    data ? parts.push(data) : missing.push(b.index);
  }
  if (missing.length) return { missing };
  let buf = Buffer.concat(parts);
  if (file.encrypted) {
    try { buf = decrypt(buf); } catch { return { buf: Buffer.alloc(0), checksum: "decryption-failed", match: false }; }
  }
  return { buf, checksum: sha(buf), match: sha(buf) === file.sha256 };
}

const app = express();
app.use(cors({ exposedHeaders: ["X-Checksum", "X-Checksum-Match"] }), express.json());
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });

app.post("/api/files", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file received." });
  const blockSize = Math.max(1024, Math.round(parseFloat(req.body.blockSizeMB || "4") * 1024 * 1024));
  const online = [...(await onlineSet())];
  if (online.length < 1) return res.status(503).json({ error: "No storage nodes are online." });
  const plain = req.file.buffer, buf = encrypt(plain), blocks = [];
  const load = Object.fromEntries(NODE_NAMES.map((n) => [n, 0]));
  for (const f of await FileM.find()) f.blocks.forEach((b) => b.nodes.forEach((n) => load[n]++));
  for (let i = 0, off = 0; ; i++, off += blockSize) {
    const chunk = buf.subarray(off, off + blockSize);
    const id = `blk_${crypto.randomBytes(5).toString("hex")}`;
    const targets = [...online].sort((a, b) => load[a] - load[b]).slice(0, REPLICATION);
    await Promise.all(targets.map((n) => writeBlock(n, id, chunk)));
    targets.forEach((n) => load[n]++);
    blocks.push({ index: i, id, size: chunk.length, sha256: sha(chunk), nodes: targets });
    if (off + blockSize >= buf.length) break;
  }
  const doc = await FileM.create({
    name: req.file.originalname, size: plain.length, mime: req.file.mimetype, blockSize, sha256: sha(plain), encrypted: true, blocks,
  });
  res.json(view(doc, await onlineSet()));
});

app.get("/api/files", async (_req, res) => {
  const online = await onlineSet();
  res.json((await FileM.find().sort({ createdAt: -1 })).map((f) => view(f, online)));
});

app.get("/api/files/:id/download", async (req, res) => {
  const f = await FileM.findById(req.params.id);
  if (!f) return res.status(404).json({ error: "File not found." });
  const r = await reconstruct(f);
  if (r.missing) return res.status(409).json({ error: `Blocks ${r.missing.join(", ")} have no online replica. Bring a node back online and retry.`, missing: r.missing });
  res.set({ "Content-Type": f.mime || "application/octet-stream", "Content-Disposition": `attachment; filename="${encodeURIComponent(f.name)}"`, "X-Checksum": r.checksum, "X-Checksum-Match": String(r.match) });
  res.send(r.buf);
});

app.get("/api/files/:id/verify", async (req, res) => {
  const f = await FileM.findById(req.params.id);
  if (!f) return res.status(404).json({ error: "File not found." });
  const r = await reconstruct(f);
  if (r.missing) return res.json({ ok: false, missing: r.missing, original: f.sha256 });
  res.json({ ok: r.match, original: f.sha256, reconstructed: r.checksum });
});

app.delete("/api/files/:id", async (req, res) => {
  const f = await FileM.findByIdAndDelete(req.params.id);
  if (f) for (const b of f.blocks) for (const n of b.nodes) await fs.rm(path.join(ROOT, n, b.id + ".blk"), { force: true });
  res.json({ ok: true });
});

app.get("/api/nodes", async (_req, res) => {
  const [nodes, files] = await Promise.all([NodeM.find().sort({ name: 1 }), FileM.find()]);
  res.json(nodes.map((n) => {
    const held = files.flatMap((f) => f.blocks.filter((b) => b.nodes.includes(n.name)).map((b) => ({ id: b.id, size: b.size, file: f.name, index: b.index })));
    return { name: n.name, online: n.online, blocks: held, used: held.reduce((s, b) => s + b.size, 0) };
  }));
});

app.post("/api/nodes/:name/toggle", async (req, res) => {
  const n = await NodeM.findOne({ name: req.params.name });
  if (!n) return res.status(404).json({ error: "Node not found." });
  n.online = !n.online; await n.save(); res.json(n);
});

app.post("/api/replication/auto", (req, res) => {
  autoHeal = !!req.body.enabled; log(`Auto re-replication turned ${autoHeal ? "on" : "off"}`); res.json({ autoHeal });
});
app.post("/api/replication/run", async (_req, res) => {
  const r = await heal(); if (!r.copied && !r.trimmed) log("Heal run: nothing to do"); res.json(r);
});

app.get("/api/stats", async (_req, res) => {
  const [nodes, files] = await Promise.all([NodeM.find(), FileM.find()]);
  const online = new Set(nodes.filter((n) => n.online).map((n) => n.name));
  const statuses = files.flatMap((f) => f.blocks).map((b) => blockStatus(b, online));
  res.json({
    files: files.length, bytes: files.reduce((s, f) => s + f.size, 0), blocks: statuses.length,
    nodesOnline: online.size, nodesTotal: nodes.length, autoHeal, events,
    missing: statuses.filter((s) => s === "missing").length,
    underReplicated: statuses.filter((s) => s === "under-replicated").length,
    recent: [...files].sort((a, b) => b.createdAt - a.createdAt).slice(0, 5).map((f) => ({ id: f._id, name: f.name, size: f.size, blocks: f.blocks.length, createdAt: f.createdAt })),
  });
});

await mongoose.connect(process.env.MONGO_URI || "mongodb://127.0.0.1:27017/minihdfs");
for (const name of NODE_NAMES) {
  await fs.mkdir(path.join(ROOT, name), { recursive: true });
  await NodeM.updateOne({ name }, { $setOnInsert: { name, online: true } }, { upsert: true });
}
try { KEY = Buffer.from(await fs.readFile(path.join(ROOT, "..", ".key"), "utf8"), "hex"); }
catch { KEY = crypto.randomBytes(32); await fs.writeFile(path.join(ROOT, "..", ".key"), KEY.toString("hex")); }
setInterval(() => { if (autoHeal) heal().catch((e) => console.error("heal failed", e.message)); }, 8000);
app.listen(5000, () => console.log("MiniHDFS API on http://localhost:5000"));