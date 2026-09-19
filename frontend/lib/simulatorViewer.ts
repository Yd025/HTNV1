/** Adapt the native Gazebo page without copying its renderer or mission transport. */
export function simulatorViewerUrls(viewerAddress: string, controlAddress?: string) {
  const viewer = new URL(viewerAddress);
  // This version of GZIface always opens ws://. An HTTPS viewer needs a native
  // wss-capable client before it can be embedded through this adapter.
  if (viewer.protocol !== "http:" || viewer.username || viewer.password || viewer.search || viewer.hash) {
    throw new Error("The simulator viewer must be an HTTP URL without credentials, a query, or a fragment.");
  }
  const control = controlAddress ? new URL(controlAddress) : new URL(viewer.origin);
  if (!controlAddress) control.port = "8090";
  if (!["http:", "https:"].includes(control.protocol) || control.username || control.password || control.search || control.hash) {
    throw new Error("The simulator control address is unsupported.");
  }
  return { viewer, control };
}

function htmlAttribute(value: string) {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function scriptString(value: string) {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

export function prepareSimulatorViewerHtml(html: string, viewerAddress: string, controlAddress?: string) {
  const { viewer, control } = simulatorViewerUrls(viewerAddress, controlAddress);
  const connection = /new\s+GZ3D\.GZIface\(\s*scene\s*\)/g;
  if (!/<head(?:\s[^>]*)?>/i.test(html) || !/<\/body\s*>/i.test(html) || (html.match(connection) ?? []).length !== 1) {
    throw new Error("The simulator returned an unsupported viewer page. Open the native viewer while the integration is updated.");
  }

  const controlBase = control.href.replace(/\/$/, "");
  const controlAssignment = `window.__AS_API=${scriptString(controlBase)};`;
  // The generated page assigns its control API immediately before loading
  // panel.js. Preserve that loader, but replace its location-derived address.
  const assignment = /window\.__AS_API\s*=\s*(?:[^;"']|"[^"]*"|'[^']*')*;/g;
  let adapted = html.replace(assignment, () => controlAssignment);
  adapted = adapted.replace(connection, () => `new GZ3D.GZIface(scene, ${scriptString(viewer.host)})`);
  adapted = adapted.replace(/<base\b[^>]*>/gi, "");
  adapted = adapted.replace(/<head(?:\s[^>]*)?>/i, head => `${head}\n<base href="${htmlAttribute(viewer.href)}">\n<script>${controlAssignment}</script>`);
  // A root-relative src also follows <base>, so resolve against the actual
  // iframe document URL to keep this one script on the frontend's origin.
  const tags = `<script>(function(){var script=document.createElement("script");script.src=new URL("/simulator-tags.js",window.location.href).href;document.body.appendChild(script);})();</script>`;
  return adapted.replace(/<\/body\s*>/i, closing => `${tags}\n${closing}`);
}
