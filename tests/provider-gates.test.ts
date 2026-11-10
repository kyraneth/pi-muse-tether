import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/host.js", () => ({ openMuseHost: vi.fn() }));
import { openMuseHost } from "../src/host.js";
import { createMuseProvider, streamViaMuse as qualifiedStream } from "../src/provider.js";
const {streamViaMuse}=createMuseProvider(); // Explicit unqualified recipe must still refuse.
const model = { id: "echo", provider: "pi-muse-tether" };
const message = { role: "user", content: "synthetic" };
afterEach(() => {
  vi.clearAllMocks();
  delete process.env.PI_MUSE_TETHER_SYSTEM_PROMPT;
});
describe("pre-spawn Muse boundaries", () => {
  it("fails an unqualified live model loudly instead of silently dropping Pi instructions",async()=>{
    const result=await qualifiedStream({...model,id:"not-a-muse-model"},{messages:[message],tools:[]}).result();
    expect(result.stopReason).toBe("error");expect(result.errorMessage).toContain("not qualified");expect(openMuseHost).not.toHaveBeenCalled();
  });
  it("labels contributor response identity as derived, never as observed telemetry",async()=>{
    const rejected=createMuseProvider({modelAllowed:()=>false});
    const result:any=await rejected.streamViaMuse({...model,id:"muse-spark-1.3"},{messages:[message],tools:[]}).result();
    expect(result.model).toBe("muse-spark-1.3");expect(result.responseModel).toBe("muse-spark-1.3-contributor");expect(result.responseModelSource).toBe("derived:fixed-contributor-on-recipe");expect(openMuseHost).not.toHaveBeenCalled();
  });
  it("rejects tools-empty raw completion before spawn", async () => {
    const result = await streamViaMuse(
      model,
      { messages: [message], tools: [] },
      {},
    ).result();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toMatch(/compaction/);
    expect(openMuseHost).not.toHaveBeenCalled();
  });
  it("rejects unsupported system mode before spawn", async () => {
    process.env.PI_MUSE_TETHER_SYSTEM_PROMPT = "replace";
    const result = await streamViaMuse(
      model,
      { messages: [message], tools: [{ name: "fixture" }] },
      {},
    ).result();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toMatch(/Unsupported system prompt/);
    expect(openMuseHost).not.toHaveBeenCalled();
  });
});
