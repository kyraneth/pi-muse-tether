/** No Muse1.4.14 MSP field declares cache TTL/expiry. Warm hits are not TTL:
 * the tether parks prompt-cache refresh ("until-Pi-retires") and never
 * refreshes by issuing a billed model ping, because cache loss alone is not
 * history corruption and must not trigger a replay.
 */
export const MUSE_CACHE_POLICY = {
  ttlSeconds: null,
  ttlSource: "unknown:MSP1.4.14 exposes no expiry",
  parking: "until-Pi-retires",
  billedKeepalive: false,
} as const;
