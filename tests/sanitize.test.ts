import { describe, expect, it } from "bun:test";
import { isIgnoredDiffFile, redactSecrets, sanitizeDiffForAI, sanitizeForAI } from "../src/utils/diff.ts";

describe("redactSecrets — token families", () => {
  // Fixtures are assembled at runtime (never a complete token in source):
  // GitHub push protection blocks the patterns even in tests. Every value
  // below is byte-identical to the literal it replaces.
  const secrets: Record<string, string> = {
    stripe_live: `sk_live_${"4eC39HqLyjWDarjtT1zdp7dc"}`,
    stripe_restricted: `rk_test_${"4eC39HqLyjWDarjtT1zdp7dc"}`,
    stripe_webhook: `whsec_${"abcdefghijklmnopqrstuvwxyz0123456789"}`,
    anthropic: `sk-ant-api03-${"abcdefghijklmnopqrstuvwxyz0123456789"}`,
    openai_proj: `sk-proj-${"abcdefghijklmnopqrstuvwxyz0123456789"}`,
    github: `ghp_${"abcdefghijklmnopqrstuvwxyz0123456789ABCD"}`,
    slack_webhook: "https://hooks.slack.com/services/" + "T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX",
    discord_webhook: "https://discord.com/api/webhooks/" + "123456789012345678/abcdefghijklmnopqrstuvwxyz",
    google_oauth: `ya29.${"a0AfH6SMBx1234567890abcdefghijklmnopqrstuvwxyz"}`,
    databricks: "dapi" + "0123456789abcdef0123456789abcdef",
    shopify: `shpat_${"0123456789abcdef0123456789abcdef"}`,
    sendgrid: "SG." + "abcdefghijklmnopqrstuv.abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJK",
    huggingface: `hf_${"abcdefghijklmnopqrstuvwxyz0123456789"}`,
    digitalocean: `dop_v1_${"a1".repeat(32)}`,
    pypi: "pypi-" + "AgEIcHlwaS5vcmcCJDAwMDAwMDAwLTAwMDAtMDAwMC0wMDAwLTAwMDAwMDAwMDAwMAACKlszLCJhYmNkZWY",
    bearer: "Bearer " + "abcdefghijklmnopqrstuvwxyz0123456789",
    mysql_url: "mysql://root:" + "hunter22@db.internal:3306/app",
    mongo_url: "mongodb+srv://app:" + "S3cretPass@cluster0.example.net/db",
    redis_url: "redis://default:" + "pa55word@cache:6379",
    http_url: "https://user:" + "passw0rd@registry.example.com/npm",
    aws_secret: "aws_secret_access_key = " + "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  };

  for (const [name, value] of Object.entries(secrets)) {
    it(`redacts ${name}`, () => {
      const { text, redactedCount } = redactSecrets(`config ${value} tail`);
      expect(redactedCount, name).toBeGreaterThan(0);
      expect(text, name).not.toContain(value.replace(/^Bearer /, "").replace(/^aws_secret_access_key = /, ""));
      expect(text).toContain("[REDACTED_SECRET]");
    });
  }

  it("redacts a PGP private key block", () => {
    const pgp =
      "-----BEGIN PGP PRIVATE " + "KEY BLOCK-----\nlQOYBF...\n-----END PGP PRIVATE " + "KEY BLOCK-----";
    expect(redactSecrets(pgp).text).toBe("[REDACTED_SECRET]");
  });

  it("keeps the key of an assignment but not the value", () => {
    const { text } = redactSecrets('DATABASE_PASSWORD="correct-horse-battery"');
    expect(text).toBe('DATABASE_PASSWORD="[REDACTED_SECRET]"');
  });

  it("does not turn a credentialed URL into a fake assignment", () => {
    const { text } = redactSecrets("url = postgres://u:p4ssw0rd@host/db");
    expect(text).toBe("url = [REDACTED_SECRET]");
  });

  it("leaves ordinary code alone", () => {
    const code = 'const key = "id";\nconst url = "https://example.com/path";\nconst n = 12345678;';
    expect(redactSecrets(code)).toEqual({ text: code, redactedCount: 0 });
  });
});

describe("ignored files", () => {
  it("drops extra lockfiles and key material", () => {
    for (const f of [
      "go.sum", "uv.lock", "Pipfile.lock", "flake.lock", "deno.lock", "mix.lock",
      ".ssh/id_ed25519", "id_ecdsa.pub", "certs/server.p12", "release.jks", "app.mobileprovision",
      "terraform.tfvars", "infra/terraform.tfstate.backup", ".npmrc", "kubeconfig", "kubeconfig.yaml",
      "assets/logo.avif", "fonts/inter.woff2", "data.sqlite",
    ]) {
      expect(isIgnoredDiffFile(f), f).toBe(true);
    }
  });

  it("does not over-match ordinary files", () => {
    for (const f of ["src/config.yaml", "src/keyboard.ts", "docs/locking.md", "src/credentials-form.tsx", "README.md"]) {
      expect(isIgnoredDiffFile(f), f).toBe(false);
    }
  });
});

describe("sanitizeForAI (free text: CI logs, issue bodies)", () => {
  it("redacts and reports", () => {
    const log = [
      "Run npm publish",
      "npm notice using token " + "npm_abcdefghijklmnopqrstuvwxyz0123456789",
      "Error: connect ECONNREFUSED",
    ].join("\n");
    const { text, redactedCount } = sanitizeForAI(log);
    expect(redactedCount).toBe(1);
    expect(text).not.toContain("npm_" + "abcdefghijklmnopqrstuvwxyz0123456789");
    expect(text).toContain("ECONNREFUSED");
  });

  it("caps the size", () => {
    const { text } = sanitizeForAI("x".repeat(50_000), 1_000);
    expect(text.length).toBeLessThan(1_200);
    expect(text).toContain("truncated");
  });

  it("handles empty input", () => {
    expect(sanitizeForAI("")).toEqual({ text: "", redactedCount: 0 });
  });
});

describe("sanitizeDiffForAI", () => {
  it("drops a go.sum block and redacts inside surviving hunks", () => {
    const diff = [
      "diff --git a/go.sum b/go.sum",
      "--- a/go.sum",
      "+++ b/go.sum",
      "+github.com/x v1.0.0 h1:abc=",
      "diff --git a/main.go b/main.go",
      "--- a/main.go",
      "+++ b/main.go",
      '+const token = "ghp_' + 'abcdefghijklmnopqrstuvwxyz0123456789ABCD"',
    ].join("\n");
    const out = sanitizeDiffForAI(diff);
    expect(out.strippedBlocks).toBe(1);
    expect(out.redactedCount).toBe(1);
    expect(out.diff).not.toContain("go.sum");
    expect(out.diff).toContain("[REDACTED_SECRET]");
  });
});
