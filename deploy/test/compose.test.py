"""Checks the hardening and shape of deploy/compose.yaml and deploy/Caddyfile.template.

Dependency-free: the compose file is read through `docker compose config --no-interpolate
--format json` (falling back to the standalone `docker-compose`), so variable references stay
literal, and deploy/.env.example is parsed directly.

Run: python3 -m unittest deploy/test/compose.test.py
(unittest imports that path as deploy.test.compose.test, which deploy/test/compose/test.py
provides by loading this file.)
"""
import json
import os
import re
import shutil
import subprocess
import tempfile
import unittest

DEPLOY = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
COMPOSE = os.path.join(DEPLOY, "compose.yaml")
ENV_EXAMPLE = os.path.join(DEPLOY, ".env.example")
CADDYFILE = os.path.join(DEPLOY, "Caddyfile.template")
MANIFEST = os.path.join(os.path.dirname(DEPLOY), "hub", "services.json")

ZERO_DIGEST = "0" * 64
DIGEST_IMAGE = re.compile(r"^[a-z0-9][a-z0-9._/:-]*@sha256:[0-9a-f]{64}$")
VARIABLE = re.compile(r"^\$\{([A-Z][A-Z0-9_]*)(?::?[?-][^}]*)?\}$")
AUTH_HOST_REF = re.compile(r"\$\{AUTH_PUBLIC_HOST(?::\?[^}]*)?\}")
# Literal environment values that are never secret.
LITERAL_ENV = {"PORT"}


def compose_command():
    if shutil.which("docker"):
        probe = subprocess.run(["docker", "compose", "version"], capture_output=True)
        if probe.returncode == 0:
            return ["docker", "compose"]
    if shutil.which("docker-compose"):
        return ["docker-compose"]
    raise RuntimeError("docker compose (or docker-compose) is required for this test")


def load_compose():
    result = subprocess.run(
        compose_command() + ["-f", COMPOSE, "--env-file", ENV_EXAMPLE,
                             "config", "--no-interpolate", "--format", "json"],
        capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError("compose config failed: " + result.stderr.strip())
    return json.loads(result.stdout)


def load_resolved(overrides=None):
    """The compose model with variables interpolated: .env.example plus `overrides`, as an .env
    written by the setup CLI would be. Variables of the calling shell never leak in."""
    with open(ENV_EXAMPLE, encoding="utf-8") as handle:
        text = handle.read()
    text += "".join("%s=%s\n" % item for item in (overrides or {}).items())
    environment = {k: v for k, v in os.environ.items() if not k.startswith(("LAWOSS_", "AUTH_", "HUB_"))}
    with tempfile.TemporaryDirectory() as directory:
        env_file = os.path.join(directory, "env")
        with open(env_file, "w", encoding="utf-8") as handle:
            handle.write(text)
        result = subprocess.run(
            compose_command() + ["-f", COMPOSE, "--env-file", env_file, "config", "--format", "json"],
            capture_output=True, text=True, env=environment)
    if result.returncode != 0:
        raise RuntimeError("compose config failed: " + result.stderr.strip())
    return json.loads(result.stdout)


def published(model):
    """The proxy's published ports as (host_ip or None, published, target, protocol), sorted."""
    return sorted((p.get("host_ip"), str(p["published"]), int(p["target"]), p["protocol"])
                  for p in model["services"]["proxy"]["ports"])


def load_env_example():
    values = {}
    with open(ENV_EXAMPLE, encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            name, _, value = line.partition("=")
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
                value = value[1:-1]
            values[name.strip()] = value
    return values


class ComposeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.compose = load_compose()
        cls.services = cls.compose["services"]
        cls.env = load_env_example()
        with open(COMPOSE, encoding="utf-8") as handle:
            cls.raw = handle.read()

    def test_services_are_proxy_auth_and_hub(self):
        self.assertEqual(sorted(self.services), ["auth", "hub", "proxy"])

    def test_only_proxy_publishes_ports(self):
        for name, service in self.services.items():
            if name != "proxy":
                self.assertEqual(service.get("ports", []), [], name + " must not publish ports")
        self.assertTrue(self.services["proxy"].get("ports"))

    def test_default_env_publishes_exactly_80_and_443_on_all_addresses(self):
        # An .env written by 0.1.0 has none of the LAWOSS_*_PORT or LAWOSS_PROXY_BIND keys.
        model = load_resolved()
        self.assertEqual(published(model), [(None, "443", 443, "tcp"), (None, "443", 443, "udp"), (None, "80", 80, "tcp")])
        for name, service in model["services"].items():
            if name != "proxy":
                self.assertEqual(service.get("ports", []), [], name)

    def test_empty_keys_mean_the_defaults(self):
        model = load_resolved({"LAWOSS_HTTP_PORT": "", "LAWOSS_HTTPS_PORT": "", "LAWOSS_PROXY_BIND": ""})
        self.assertEqual(published(model), [(None, "443", 443, "tcp"), (None, "443", 443, "udp"), (None, "80", 80, "tcp")])

    def test_custom_env_moves_the_host_ports_and_binds_the_address(self):
        model = load_resolved({"LAWOSS_HTTP_PORT": "8080", "LAWOSS_HTTPS_PORT": "8443", "LAWOSS_PROXY_BIND": "127.0.0.1"})
        self.assertEqual(published(model), [("127.0.0.1", "8080", 80, "tcp"), ("127.0.0.1", "8443", 443, "tcp"),
                                            ("127.0.0.1", "8443", 443, "udp")])
        for name, service in model["services"].items():
            if name != "proxy":
                self.assertEqual(service.get("ports", []), [], name)

    def test_an_ipv6_bind_address_is_accepted(self):
        model = load_resolved({"LAWOSS_PROXY_BIND": "::1"})
        self.assertEqual({p[0] for p in published(model)}, {"::1"})

    def test_only_the_proxy_targets_are_80_and_443(self):
        for _, _, target, _ in published(load_resolved()):
            self.assertIn(target, {80, 443})

    def test_every_service_is_hardened(self):
        for name, service in self.services.items():
            with self.subTest(service=name):
                self.assertIs(service.get("read_only"), True)
                self.assertEqual(service.get("cap_drop"), ["ALL"])
                self.assertIn("no-new-privileges:true", service.get("security_opt", []))
                self.assertTrue(service.get("mem_limit"), "memory limit")
                self.assertGreater(int(service.get("pids_limit", 0)), 0, "pids limit")
                self.assertFalse(service.get("privileged", False))
                self.assertIn("/tmp", [m.split(":")[0] for m in service.get("tmpfs", [])])

    def test_only_proxy_adds_a_capability_and_only_net_bind_service(self):
        self.assertEqual(self.services["proxy"].get("cap_add"), ["NET_BIND_SERVICE"])
        self.assertFalse(self.services["auth"].get("cap_add"))
        self.assertFalse(self.services["hub"].get("cap_add"))

    def test_images_are_variables_pinned_by_digest_in_the_example(self):
        for name, service in self.services.items():
            with self.subTest(service=name):
                match = VARIABLE.match(service["image"])
                self.assertIsNotNone(match, name + " image must be a ${VARIABLE}")
                example = self.env.get(match.group(1), "")
                self.assertRegex(example, DIGEST_IMAGE)
        proxy = self.env[VARIABLE.match(self.services["proxy"]["image"]).group(1)]
        self.assertTrue(proxy.startswith("caddy:2."), "official Caddy 2 image")
        self.assertFalse(proxy.endswith(ZERO_DIGEST), "the proxy image is pinned by its real digest")

    def test_no_literal_secret_values(self):
        for name, service in self.services.items():
            for key, value in (service.get("environment") or {}).items():
                with self.subTest(service=name, variable=key):
                    if key in LITERAL_ENV:
                        self.assertRegex(str(value), r"^[0-9]+$")
                    else:
                        self.assertRegex(str(value), VARIABLE, "only ${VARIABLE} references")
            self.assertNotIn("env_file", service, "each service gets only its own variables")
        self.assertNotRegex(self.raw, r"(?i)(secret|password|token|key)\s*[:=]\s*['\"]?[A-Za-z0-9+/_-]{16,}")

    def test_example_secrets_are_unmistakable_placeholders(self):
        for name in ("AUTH_CONFIG_JSON", "HUB_CONFIG_JSON"):
            self.assertIn("REPLACE", self.env.get(name, ""), name)
        for name, value in self.env.items():
            if re.search(r"(SECRET|PASSWORD|KEY|TOKEN)", name):
                self.assertEqual(value, "", name + " stays empty in the example")

    def test_auth_healthcheck_uses_the_public_host(self):
        check = " ".join(self.services["auth"]["healthcheck"]["test"])
        self.assertRegex(check, AUTH_HOST_REF)
        self.assertIn("/health", check)
        self.assertIn("x-forwarded-proto", check.lower())
        self.assertIn("/health", " ".join(self.services["hub"]["healthcheck"]["test"]))

    def test_no_service_mounts_the_docker_socket(self):
        self.assertNotIn("docker.sock", self.raw)
        for name, service in self.services.items():
            for volume in service.get("volumes", []):
                self.assertNotIn("docker.sock", json.dumps(volume), name)

    def test_named_volumes_hold_the_writable_data(self):
        self.assertEqual(sorted(self.compose.get("volumes", {})), ["auth-data", "caddy-data", "hub-data"])
        expected = {"auth": "auth-data", "hub": "hub-data", "proxy": "caddy-data"}
        for name, volume in expected.items():
            mounts = {(m.get("source"), m.get("target")) for m in self.services[name].get("volumes", [])
                      if m.get("type") == "volume"}
            self.assertEqual(mounts, {(volume, "/data")}, name)

    def test_auth_reads_brand_packs_from_a_read_only_host_directory(self):
        binds = [m for m in self.services["auth"].get("volumes", []) if m.get("type") == "bind"]
        self.assertEqual(len(binds), 1, binds)
        brand = binds[0]
        self.assertEqual(os.path.basename(brand["source"]), "brand")
        self.assertEqual(brand["target"], "/brand")
        self.assertIs(brand.get("read_only"), True)
        self.assertIs(brand.get("bind", {}).get("create_host_path"), False)
        self.assertEqual([m for m in self.services["hub"].get("volumes", []) if m.get("type") == "bind"], [])

    def test_hub_receives_exactly_the_allowlisted_provider_keys(self):
        with open(MANIFEST, encoding="utf-8") as handle:
            manifest = json.load(handle)
        allowlisted = {name for service in manifest["services"].values() for name in service.get("env", [])}
        environment = self.services["hub"]["environment"]
        self.assertEqual(set(environment), allowlisted | {"HUB_CONFIG_JSON", "PORT"})
        for name in allowlisted:
            self.assertEqual(environment[name], "${%s:-}" % name, name)
        self.assertTrue(allowlisted.isdisjoint(self.services["auth"].get("environment", {})))
        for name, service in self.services.items():
            self.assertNotIn("env_file", service, name)

    def test_proxy_carries_the_auth_host_alias_on_the_internal_network(self):
        networks = self.compose["networks"]
        internal = [n for n, spec in networks.items() if spec.get("internal") is True]
        self.assertEqual(len(internal), 1, "one internal network")
        net = internal[0]
        aliases = self.services["proxy"]["networks"][net].get("aliases") or []
        self.assertTrue(any(AUTH_HOST_REF.fullmatch(alias) for alias in aliases), aliases)
        self.assertIn(net, self.services["auth"]["networks"])
        self.assertIn(net, self.services["hub"]["networks"])

    def test_auth_has_no_route_out_and_the_hub_reaches_public_portals(self):
        networks = self.compose["networks"]
        self.assertTrue(all(networks[n].get("internal") is True for n in self.services["auth"]["networks"]))
        self.assertTrue(any(networks[n].get("internal") is not True for n in self.services["hub"]["networks"]),
                        "runtimes call public portals")


class CaddyfileTemplateTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with open(CADDYFILE, encoding="utf-8") as handle:
            cls.template = handle.read()

    def render(self, auth_host, service_hosts, acme_email="ops@example.com"):
        """The rendering the setup CLI performs: one copy of the service section per enabled service."""
        section = re.compile(r"^# \{\{#SERVICES\}\}\n(.*?)^# \{\{/SERVICES\}\}\n", re.S | re.M)
        match = section.search(self.template)
        self.assertIsNotNone(match, "one {{#SERVICES}} ... {{/SERVICES}} section")
        blocks = "".join(match.group(1).replace("{{SERVICE_HOST}}", host) for host in service_hosts)
        text = self.template[:match.start()] + blocks + self.template[match.end():]
        return text.replace("{{AUTH_HOST}}", auth_host).replace("{{ACME_EMAIL}}", acme_email)

    def site_blocks(self, text):
        return re.findall(r"^(\S+) \{\n(.*?)^\}", text, re.S | re.M)

    def test_rendered_sites_proxy_auth_and_each_service_host(self):
        text = self.render("auth.example.com", ["crz.example.com", "orsr.example.com"])
        self.assertNotIn("{{", text)
        sites = dict(self.site_blocks(text))
        self.assertEqual(sorted(sites), ["auth.example.com", "crz.example.com", "orsr.example.com"])
        self.assertRegex(sites["auth.example.com"], r"reverse_proxy auth:3000\b")
        for host in ("crz.example.com", "orsr.example.com"):
            self.assertRegex(sites[host], r"reverse_proxy hub:3000\b")

    def test_global_options_carry_the_certificate_contact_email(self):
        text = self.render("auth.example.com", ["crz.example.com"], "ops@example.com")
        match = re.search(r"^\{\n(.*?)^\}\n", text, re.S | re.M)
        self.assertIsNotNone(match, "a global options block")
        self.assertEqual(match.group(1).strip(), "email ops@example.com")
        self.assertLess(match.start(), text.index("auth.example.com {"), "global options come first")

    def test_host_header_passes_through_and_tls_stays_automatic(self):
        directives = "\n".join(line for line in self.template.splitlines() if not line.lstrip().startswith("#"))
        self.assertNotRegex(directives, r"(?i)header_up\s+\+?-?Host")
        self.assertNotRegex(directives, r"(?i)X-Forwarded-Host")
        self.assertNotRegex(directives, r"(?i)auto_https\s+off|tls\s+internal|http://")


if __name__ == "__main__":
    unittest.main()
