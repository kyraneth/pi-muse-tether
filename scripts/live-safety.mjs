/** Proof-only detector. Traverse allowlisted envelope/error fields, NEVER content. */
export function refusal(x, error = false) {
 if (typeof x === 'string' && error && x.includes('Muse login metadata symlink replaced')) return 'private-login-link-replaced';
 if (typeof x === 'string') return error && /\bclient_attestation_denied\b|\bHTTP\s*[:=]?\s*40[23]\b|\b403\s+Forbidden\b|\b(?:plan|usage)\s+(?:usage\s+)?limit\s+(?:reached|exceeded)\b|\b(?:insufficient|exhausted|out of)\s+credits?\b/i.test(x) ? 'account-refusal' : null;
 if (!x || typeof x !== 'object' || Array.isArray(x)) return null;
 if (['out','launch'].includes(x.dir)) return null;
 if (x.dir === 'in' || x.dir === 'stderr') return refusal(x.msg);
 if(x.method==='usage/changed' && [x.params?.window?.usedPercent,x.params?.weekly?.usedPercent].some(v=>typeof v==='number' && v>=100)) return 'plan_usage_limit_exceeded'; // Native quota exhausted boundary.
 if (x.type === 'tool_execution_end' || x.role === 'toolResult' || x.role === 'user') return null;
 if (x.role === 'assistant') return x.stopReason === 'error' ? refusal(x.errorMessage,true) : null;
 for (const k of ['status','statusCode','status_code','httpStatus','http_status','http_status_code','code']) if ((k!=='code'||error) && [402,403,'402','403'].includes(x[k])) return 'http-'+x[k];
 for (const k of ['code','error_code','errorCode','kind']) if (['client_attestation_denied','insufficient_credits','credits_exhausted','usage_limit_exceeded','plan_usage_limit_exceeded'].includes(x[k])) return x[k];
 // Muse exec terminal envelopes are trusted error boundaries, not ordinary payloads.
 if (typeof x.payload_type === 'string' && x.payload_type.startsWith('run.terminal.failed')) return refusal(x.payload,true);
 for (const k of ['error','errors','errorMessage','error_message','failure','failureReason']) {
  const hit = Array.isArray(x[k]) ? x[k].map(v=>refusal(v,true)).find(Boolean) : refusal(x[k],true); if(hit)return hit;
 }
 if(error) { const hit=refusal(x.message,true) || refusal(x.reason,true); if(hit)return hit; }
 for (const k of ['message','params','data','response','result','cause','turn']) if (typeof x[k] === 'object') {const hit=refusal(x[k],error);if(hit)return hit;}
 return null;
}
