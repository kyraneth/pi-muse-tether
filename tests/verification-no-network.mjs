/** Test-process backstop. All inherited Pi children get this preload. */
import {appendFileSync} from "node:fs";
globalThis.fetch=async()=>{appendFileSync(process.env.VERIFICATION_NETWORK_ATTEMPTS,"blocked-fetch\n");throw new Error("VERIFICATION OFFLINE NETWORK BACKSTOP: attempted fetch, no network sent");};
