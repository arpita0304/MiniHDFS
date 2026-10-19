import { useEffect, useState, useCallback } from "react";

const fmt = (b) => b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(2)} MB`;
const api = async (url, opts) => {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "Request failed.");
  return r;
};
const STATUS = { healthy: "bg-green-50 text-ok border-green-200", "under-replicated": "bg-amber-50 text-warn border-amber-200", missing: "bg-red-50 text-bad border-red-200" };
const Pill = ({ s }) => <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${STATUS[s]}`}>{s}</span>;
const Card = ({ title, children, right }) => (
  <section className="rounded-lg border border-line bg-white p-5">
    <div className="mb-4 flex items-center justify-between gap-3"><h2 className="font-display text-lg font-bold">{title}</h2>{right}</div>{children}
  </section>
);
const Btn = ({ kind = "solid", className = "", ...p }) => (
  <button {...p} className={`rounded-md px-3.5 py-2 text-sm font-medium transition disabled:opacity-50 ${kind === "solid" ? "bg-brand text-white hover:bg-blue-700" : "border border-line bg-white hover:bg-paper"} ${className}`} />
);

function Replication({ stats, refresh }) {
  const post = async (url, body) => { await api(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) }); refresh(); };
  return (
    <Card title="Auto re-replication" right={
      <div className="flex gap-2">
        <Btn kind="ghost" onClick={() => post("/api/replication/run")}>Heal now</Btn>
        <Btn kind="ghost" onClick={() => post("/api/replication/auto", { enabled: !stats.autoHeal })}>{stats.autoHeal ? "Turn off" : "Turn on"}</Btn>
      </div>}>
      <p className="mb-3 text-sm text-muted">{stats.autoHeal ? "On. Every 8 seconds the controller copies under-replicated blocks to healthy nodes." : "Off. Under-replicated blocks stay as they are until you turn this on."}</p>
      <ul className="max-h-40 space-y-1 overflow-auto text-sm">
        {stats.events.map((e, i) => <li key={i} className="flex gap-3"><span className="font-mono text-xs text-muted">{new Date(e.t).toLocaleTimeString()}</span><span>{e.msg}</span></li>)}
        {!stats.events.length && <li className="text-muted">No replication activity yet.</li>}
      </ul>
    </Card>
  );
}

function Dashboard({ stats, refresh }) {
  if (!stats) return null;
  const cards = [["Files", stats.files], ["Storage used", fmt(stats.bytes)], ["Blocks", stats.blocks], ["Nodes online", `${stats.nodesOnline}/${stats.nodesTotal}`]];
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {cards.map(([l, v]) => <div key={l} className="rounded-lg border border-line bg-white p-5"><p className="text-sm text-muted">{l}</p><p className="mt-1 font-display text-3xl font-bold">{v}</p></div>)}
      </div>
      {(stats.missing > 0 || stats.underReplicated > 0) && (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-bad">
          {stats.missing > 0 && <p>{stats.missing} block(s) have no online replica. Affected files can't be downloaded.</p>}
          {stats.underReplicated > 0 && <p>{stats.underReplicated} block(s) are down to a single replica.</p>}
        </div>
      )}
      <Replication stats={stats} refresh={refresh} />
      <Card title="Recent uploads">
        {stats.recent.length === 0 ? <p className="text-sm text-muted">No files yet. Upload one to see it split into blocks.</p> :
          <table className="w-full text-left text-sm"><thead className="text-muted"><tr><th className="pb-2 font-medium">Name</th><th className="font-medium">Size</th><th className="font-medium">Blocks</th><th className="font-medium">Uploaded</th></tr></thead>
            <tbody>{stats.recent.map((f) => <tr key={f.id} className="border-t border-line"><td className="py-2">{f.name}</td><td>{fmt(f.size)}</td><td>{f.blocks}</td><td>{new Date(f.createdAt).toLocaleString()}</td></tr>)}</tbody></table>}
      </Card>
    </div>
  );
}

const BlockTable = ({ blocks }) => (
  <div className="overflow-x-auto"><table className="w-full text-left text-sm">
    <thead className="text-muted"><tr><th className="pb-2 font-medium">Block</th><th className="font-medium">ID</th><th className="font-medium">Size</th><th className="font-medium">Stored on</th><th className="font-medium">SHA-256</th><th className="font-medium">Status</th></tr></thead>
    <tbody>{blocks.map((b) => <tr key={b.id} className="border-t border-line"><td className="py-2">Block {b.index}</td><td className="font-mono text-xs">{b.id}</td><td>{fmt(b.size)}</td><td>{b.nodes.join(", ")}</td><td className="font-mono text-xs">{b.sha256.slice(0, 12)}…</td><td><Pill s={b.status || "healthy"} /></td></tr>)}</tbody>
  </table></div>
);

function Upload({ onDone }) {
  const [file, setFile] = useState(null), [mb, setMb] = useState("4"), [busy, setBusy] = useState(false), [res, setRes] = useState(null), [err, setErr] = useState("");
  const send = async () => {
    setBusy(true); setErr(""); setRes(null);
    const fd = new FormData(); fd.append("blockSizeMB", mb); fd.append("file", file);
    try { setRes(await (await api("/api/files", { method: "POST", body: fd })).json()); onDone(); } catch (e) { setErr(e.message); }
    setBusy(false);
  };
  return (
    <div className="space-y-5">
      <Card title="Upload a file">
        <div className="flex flex-wrap items-end gap-4">
          <label className="min-w-60 flex-1 text-sm font-medium">File
            <input type="file" onChange={(e) => setFile(e.target.files[0])} className="mt-1 block w-full rounded-md border border-line p-2 text-sm" /></label>
          <label className="text-sm font-medium">Block size (MB)
            <input type="number" min="0.001" step="any" value={mb} onChange={(e) => setMb(e.target.value)} className="mt-1 block w-32 rounded-md border border-line p-2" /></label>
          <Btn disabled={!file || busy} onClick={send}>{busy ? "Splitting…" : "Upload and split"}</Btn>
        </div>
        {err && <p role="alert" className="mt-3 text-sm text-bad">{err}</p>}
      </Card>
      {res && <Card title={`${res.name} split into ${res.blocks.length} block(s)`}><BlockTable blocks={res.blocks} /></Card>}
    </div>
  );
}

function Files({ files, refresh }) {
  const [open, setOpen] = useState(null), [msg, setMsg] = useState({});
  const set = (id, m) => setMsg((p) => ({ ...p, [id]: m }));
  const download = async (f) => {
    try {
      const r = await api(`/api/files/${f._id}/download`); const blob = await r.blob();
      Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: f.name }).click();
      const ok = r.headers.get("X-Checksum-Match") === "true";
      set(f._id, { ok, t: ok ? "Downloaded. Checksum matches the original." : "Downloaded, but the checksum doesn't match." });
    } catch (e) { set(f._id, { ok: false, t: e.message }); }
  };
  const verify = async (f) => {
    const v = await (await api(`/api/files/${f._id}/verify`)).json();
    set(f._id, v.missing ? { ok: false, t: `Can't verify: blocks ${v.missing.join(", ")} are unavailable.` } : { ok: v.ok, t: v.ok ? `Verified. SHA-256 ${v.original.slice(0, 16)}… matches.` : "Checksum mismatch." });
  };
  const del = async (f) => { await api(`/api/files/${f._id}`, { method: "DELETE" }); refresh(); };
  if (!files.length) return <Card title="Files"><p className="text-sm text-muted">Nothing stored yet. Upload a file to explore its blocks.</p></Card>;
  return (
    <div className="space-y-4">
      {files.map((f) => (
        <Card key={f._id} title={f.name} right={f.blocks.some((b) => b.status === "missing") && <Pill s="missing" />}>
          <p className="mb-3 text-sm text-muted">{fmt(f.size)} · {f.blocks.length} blocks · SHA-256 <span className="font-mono text-xs">{f.sha256.slice(0, 16)}…</span>{f.encrypted && " · AES-256 encrypted"}</p>
          <div className="flex flex-wrap gap-2">
            <Btn onClick={() => download(f)}>Reconstruct and download</Btn>
            <Btn kind="ghost" onClick={() => verify(f)}>Verify integrity</Btn>
            <Btn kind="ghost" onClick={() => setOpen(open === f._id ? null : f._id)}>{open === f._id ? "Hide blocks" : "Show blocks"}</Btn>
            <Btn kind="ghost" onClick={() => del(f)}>Delete</Btn>
          </div>
          {msg[f._id] && <p role="status" className={`mt-3 text-sm ${msg[f._id].ok ? "text-ok" : "text-bad"}`}>{msg[f._id].t}</p>}
          {open === f._id && <div className="mt-4"><BlockTable blocks={f.blocks} /></div>}
        </Card>
      ))}
    </div>
  );
}

function Nodes({ nodes, refresh }) {
  const max = Math.max(1, ...nodes.map((n) => n.used));
  const toggle = async (n) => { await api(`/api/nodes/${n.name}/toggle`, { method: "POST" }); refresh(); };
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {nodes.map((n) => (
        <Card key={n.name} title={n.name} right={<Btn kind="ghost" onClick={() => toggle(n)}>{n.online ? "Simulate failure" : "Bring online"}</Btn>}>
          <p className={`mb-2 flex items-center gap-2 text-sm font-medium ${n.online ? "text-ok" : "text-bad"}`}>
            <span className={`h-2 w-2 rounded-full ${n.online ? "bg-ok" : "bg-bad"}`} />{n.online ? "Online" : "Offline"}</p>
          <div className="mb-1 h-2 rounded bg-paper"><div className="h-2 rounded bg-brand" style={{ width: `${(n.used / max) * 100}%` }} /></div>
          <p className="mb-3 text-xs text-muted">{fmt(n.used)} across {n.blocks.length} blocks</p>
          <ul className="max-h-40 space-y-1 overflow-auto text-sm">
            {n.blocks.map((b) => <li key={b.id} className="flex justify-between gap-2"><span>{b.file} · Block {b.index}</span><span className="font-mono text-xs text-muted">{b.id}</span></li>)}
            {!n.blocks.length && <li className="text-muted">No blocks stored.</li>}
          </ul>
        </Card>
      ))}
    </div>
  );
}

export default function App() {
  const [tab, setTab] = useState("Dashboard"), [stats, setStats] = useState(null), [files, setFiles] = useState([]), [nodes, setNodes] = useState([]), [err, setErr] = useState("");
  const refresh = useCallback(async () => {
    try {
      const [s, f, n] = await Promise.all(["stats", "files", "nodes"].map((p) => api(`/api/${p}`).then((r) => r.json())));
      setStats(s); setFiles(f); setNodes(n); setErr("");
    } catch { setErr("Can't reach the API. Start the server and MongoDB, then reload."); }
  }, []);
  useEffect(() => { refresh(); const id = setInterval(refresh, 4000); return () => clearInterval(id); }, [refresh]);
  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div><h1 className="font-display text-3xl font-bold">MiniHDFS</h1><p className="text-sm text-muted">Split, replicate, and rebuild files across storage nodes.</p></div>
        <nav className="flex gap-1 rounded-lg border border-line bg-white p-1">
          {["Dashboard", "Upload", "Files", "Nodes"].map((t) => <button key={t} onClick={() => { setTab(t); refresh(); }} className={`rounded-md px-3.5 py-1.5 text-sm font-medium ${tab === t ? "bg-brand text-white" : "text-muted hover:text-ink"}`}>{t}</button>)}
        </nav>
      </header>
      {err && <p role="alert" className="mb-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-bad">{err}</p>}
      {tab === "Dashboard" && <Dashboard stats={stats} refresh={refresh} />}
      {tab === "Upload" && <Upload onDone={refresh} />}
      {tab === "Files" && <Files files={files} refresh={refresh} />}
      {tab === "Nodes" && <Nodes nodes={nodes} refresh={refresh} />}
    </div>
  );
}