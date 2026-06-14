import OAuthInfo from "@arcgis/core/identity/OAuthInfo.js";
import esriId from "@arcgis/core/identity/IdentityManager.js";
import { PORTAL } from "./config.js";

/**
 * Optional sign-in. Only needed to EDIT private layers or save to a private web
 * map. If PORTAL.appId is empty the app stays anonymous (read-only / public
 * editing only) and this is a no-op.
 *
 * To enable: register an OAuth app at your org → Settings → "Register your app",
 * add your dev + prod URLs as redirect URIs, and paste the client id into
 * config.js PORTAL.appId.
 */
export async function initAuth() {
  // Dev convenience: expose the identity manager so a script can read the portal
  // token the app already holds (handy for one-off enrichment/admin tasks).
  if (import.meta.env?.DEV) window.__esriId = esriId;
  if (!PORTAL.appId) return { signedIn: false };

  const info = new OAuthInfo({
    appId: PORTAL.appId,
    portalUrl: PORTAL.url,
    popup: false, // redirect-based; flips to popup if you prefer
  });
  esriId.registerOAuthInfos([info]);

  try {
    await esriId.checkSignInStatus(PORTAL.url + "/sharing");
    return { signedIn: true };
  } catch {
    return { signedIn: false, signIn: () => esriId.getCredential(PORTAL.url + "/sharing") };
  }
}
