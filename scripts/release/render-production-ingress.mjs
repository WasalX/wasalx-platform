import {requiredOperatorInput} from "./operator-input.mjs";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";


export function renderProductionIngress({ namespace }) {
  const fragment = JSON.parse(readFileSync(new URL(requiredOperatorInput("WASALX_INGRESS_FRAGMENT"), import.meta.url)));
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(namespace ?? "")) {
    throw new Error("A Kubernetes application namespace is required");
  }
  // Native remotely managed tunnel configuration request body. Tunnel identity
  // belongs in the API URL; connector credentials never belong in this artifact.
  return { config: {
    ingress: fragment.ingress.map(rule => {
      if (rule.service === "http_status:404") return { ...rule };
      const origin = new URL(rule.service);
      if (origin.hostname === requiredOperatorInput("WASALX_INGRESS_ROUTER_HOST")) {
        if (origin.protocol !== "https:" || origin.port !== "") throw new Error("Unexpected tenant ingress service");
        return { ...rule };
      }
      const serviceHosts = process.env.WASALX_INGRESS_SERVICE_HOSTS === undefined
        ? ["wasalx-api", "wasalx-keycloak", "wasalx-portal"]
        : requiredOperatorInput("WASALX_INGRESS_SERVICE_HOSTS").split(",");
      if (!serviceHosts.includes(origin.hostname)) {
        throw new Error("Unexpected application ingress service");
      }
      origin.hostname += `.${namespace}.svc.cluster.local`;
      return { ...rule, service: origin.href.replace(/\/$/, "") };
    }),
  } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [namespace, output, ...extra] = process.argv.slice(2);
    if (!output || extra.length) throw new Error("Use namespace output.json");
    writeFileSync(output, `${JSON.stringify(renderProductionIngress({ namespace }), null, 2)}\n`, { flag: "wx" });
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
