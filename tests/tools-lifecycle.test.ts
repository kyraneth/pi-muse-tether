import {toolsLifecycleContract} from "./tools-lifecycle.contract.js";

toolsLifecycleContract({
 vendorRetry:new URL("./fixtures/vendor-retry.json",import.meta.url),
 errors:new URL("./fixtures/tool-errors.json",import.meta.url),
 multipartText:new URL("./fixtures/multipart-text.json",import.meta.url),
 multipartImage:new URL("./fixtures/multipart-image.json",import.meta.url),
 redactedRead:new URL("./fixtures/redacted-read.json",import.meta.url),
 redactionOffsets:text=>["sk-","sk-A","sk-SECRET12"].map(value=>Buffer.byteLength(text.slice(0,text.indexOf(value)))),
});
