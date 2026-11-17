require "yaml"

objects = YAML.load_stream(File.read(ENV.fetch("WASALX_TUNNEL_MANIFEST"))).compact
abort "unexpected production tunnel resources" unless objects.map { _1.fetch("kind") } == %w[Namespace Deployment NetworkPolicy]

deployment = objects[1].fetch("spec")
pod = deployment.dig("template", "spec")
containers = pod.fetch("containers")
abort "unexpected tunnel containers" unless containers.length == 1
container = containers.first
abort "production tunnel must use one bounded replica" unless deployment.fetch("replicas") == 1
abort "production tunnel image must be digest-pinned" unless container.fetch("image").match?(/@sha256:[0-9a-f]{64}\z/)
abort "tunnel token must be read from a mounted Secret" unless container.fetch("args").last(2) == ["--token-file", "/etc/cloudflared/token"]
abort "tunnel token must not be an environment variable" if container.key?("env")
abort "service-account token must be disabled" unless pod.fetch("automountServiceAccountToken") == false
abort "container is not read-only" unless container.dig("securityContext", "readOnlyRootFilesystem") == true
abort "container can elevate privileges" unless container.dig("securityContext", "allowPrivilegeEscalation") == false
abort "container capabilities are not dropped" unless container.dig("securityContext", "capabilities", "drop") == ["ALL"]
abort "resource limits are required" unless container.dig("resources", "limits") == { "cpu" => "250m", "memory" => "128Mi" }
abort "readiness endpoint changed" unless %w[startupProbe readinessProbe livenessProbe].all? { |probe| container.dig(probe, "httpGet") == { "path" => "/ready", "port" => "metrics" } }
mounts = container.fetch("volumeMounts")
abort "unexpected tunnel mounts" unless mounts == [
  { "name" => "token", "mountPath" => "/etc/cloudflared", "readOnly" => true },
  { "name" => "ca", "mountPath" => "/etc/wasalx-ca", "readOnly" => true },
]
raw_volumes = pod.fetch("volumes")
abort "unexpected tunnel volumes" unless raw_volumes.length == 2
volumes = raw_volumes.to_h { [_1.fetch("name"), _1] }
abort "unexpected tunnel volumes" unless volumes.keys.sort == %w[ca token]
abort "unexpected tunnel Secret" unless volumes.fetch("token").fetch("secret") == {
  "secretName" => ENV.fetch("WASALX_TUNNEL_SECRET_NAME"),
  "defaultMode" => 256,
  "items" => [{ "key" => "token", "path" => "token" }],
}
abort "unexpected tunnel CA" unless volumes.fetch("ca").fetch("configMap") == {
  "name" => ENV.fetch("WASALX_INTERNAL_CA_CONFIG_MAP_NAME"),
  "defaultMode" => 292,
  "items" => [{ "key" => "ca.crt", "path" => "ca.crt" }],
}

policy = objects[2].fetch("spec")
abort "tunnel policy must restrict egress" unless policy.fetch("policyTypes") == ["Egress"]
edge_blocks = policy.fetch("egress").flat_map { |rule| rule.fetch("to", []).filter_map { _1.dig("ipBlock", "cidr") } }
abort "Cloudflare edge allowlist changed" unless edge_blocks == %w[198.41.192.0/24 198.41.200.0/24]
abort "tunnel policy opened all networks" if edge_blocks.any? { _1 == "0.0.0.0/0" }

puts "Production cloudflared manifest checks passed"
