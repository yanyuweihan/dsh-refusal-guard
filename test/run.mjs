import { pathToFileURL } from "node:url";
import { CORPUS } from "./corpus.mjs";

const target = process.argv[2];
const mod = await import(pathToFileURL(target).href);

let ok = 0,
  bad = [];
for (const c of CORPUS) {
  const got = mod.isRefusalReply(c.text, 220);
  const pass = got === c.expect;
  if (pass) ok += 1;
  else bad.push({ ...c, got });
}

console.log(`语料 ${CORPUS.length} 条，通过 ${ok}，失败 ${bad.length}`);
if (bad.length) {
  console.log("\n--- 失败项 ---");
  for (const b of bad) {
    const kind = b.expect ? "漏判真拒绝" : "误判事实诊断";
    console.log(`[${kind}] got=${b.got} ${JSON.stringify(b.text.slice(0, 70))}`);
  }
}
console.log("\n--- retryText ---");
console.log(mod.DEFAULTS.retryText);
process.exitCode = bad.length ? 1 : 0;
