import fs from 'node:fs';
const cfg = JSON.parse(fs.readFileSync('C:/Users/noapi/AppData/Local/Programs/QQ Agent DSH/data/config.json','utf8'));
const keys = cfg.dshProviderKeys || {};
const p = (cfg.providers || []).find((x) => String(x.baseURL).includes('gptplus'));
const key = keys[p.id] || p.apiKey;
const base = 'https://az.gptplus5.com/v1';
const out = {};
try {
  const r = await fetch(base + '/models', { headers: { authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(15000) });
  const j = await r.json();
  const ids = (j.data || []).map((x) => x.id);
  out.modelsStatus = r.status;
  out.embeddingModels = ids.filter((x) => /embed|bge|m3e|jina|voyage/i.test(x));
  out.totalModels = ids.length;
} catch (e) { out.modelsError = String(e?.message || e); }
const candidates = ['text-embedding-ada-002','text-embedding-3-large','jina-embeddings-v3','bge-large-zh','m3e-base','BAAI/bge-m3'];
out.tries = [];
for (const m of candidates) {
  try {
    const r = await fetch(base + '/embeddings', { method:'POST', headers:{'content-type':'application/json',authorization:'Bearer '+key}, body: JSON.stringify({model:m,input:['你好']}), signal: AbortSignal.timeout(15000) });
    const t = await r.text();
    let dims=0; try { dims = JSON.parse(t)?.data?.[0]?.embedding?.length || 0; } catch {}
    out.tries.push({m, status:r.status, dims, msg:t.slice(0,90)});
  } catch (e) { out.tries.push({m, error:String(e?.message||e).slice(0,80)}); }
}
console.log(JSON.stringify(out,null,1));
