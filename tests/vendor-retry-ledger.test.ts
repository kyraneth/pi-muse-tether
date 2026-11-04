import {it,expect} from "vitest";
import {mkdtemp,readFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {MuseLedger,flushMuseLedger,museLedgerPath} from "../src/request-ledger.js";
it("records vendor retry metadata without counting it as another model request",async()=>{
 const prior=process.env.XDG_STATE_HOME;
 process.env.XDG_STATE_HOME=await mkdtemp(join(tmpdir(),"vendor-retry-ledger-"));
 try {
  const wire=JSON.parse(await readFile(new URL("./fixtures/vendor-retry.json",import.meta.url),"utf8"));
  const ledger=new MuseLedger("pi-fixture","echo");ledger.opened(wire.retry.params.sessionId);ledger.beginEpisode();ledger.observe(wire.retry);await flushMuseLedger();
  const rows=(await readFile(museLedgerPath(),"utf8")).trim().split("\n").map(x=>JSON.parse(x));
  const row=rows.find(x=>x.type==="vendor_retry_scheduled");
  expect(row).toMatchObject({method:"turn/modelRetryScheduled",attempt:1,nextAttempt:2,maxAttempts:10,retryDelayMs:60000,httpStatus:503,errorKind:"server",system:"meta",turnId:wire.retry.params.turnId,sourceRange:wire.retry.params.sourceRange});
  expect(rows.filter(x=>x.type==="request")).toEqual([]);
 } finally {await flushMuseLedger();if(prior===undefined)delete process.env.XDG_STATE_HOME;else process.env.XDG_STATE_HOME=prior;}
});
