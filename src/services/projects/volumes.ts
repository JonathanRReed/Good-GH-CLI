import { lstatSync, realpathSync, statSync } from "node:fs";
import { dirname, parse, resolve } from "node:path";
import { run } from "../../utils/exec.ts";
import { within } from "./discovery.ts";

interface Mount { path: string; type: string }
function unescapePath(path: string): string { return path.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8))); }
export function parseMounts(output: string): Mount[] {
  return output.split(/\r?\n/).filter(Boolean).map(line => {
    const linux = /^.+ on (.+) type (\S+) \(/.exec(line);
    const mac = /^.+ on (.+) \(([^, )]+)/.exec(line);
    const match = linux ?? mac;
    if (!match?.[1] || !match[2]) throw new Error("Unrecognized mount table entry");
    return { path: resolve(unescapePath(match[1])), type: match[2].toLowerCase() };
  });
}
export async function volumeAvailable(path: string): Promise<boolean> {
  try {
    const canonical = resolve(path);
    let ancestor = canonical;
    for (;;) {
      try { lstatSync(ancestor); break; }
      catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") return false;
        const parent = dirname(ancestor); if (parent === ancestor) return false; ancestor = parent;
      }
    }
    if (ancestor === parse(canonical).root) return false;
    // A symlink must not turn an unmounted prefix into an apparently local path.
    if (realpathSync.native(ancestor) !== ancestor) return false;
    if (process.platform === "win32") return ancestor !== parse(canonical).root;
    const mounts = parseMounts((await run("mount", [], { timeoutMs: 3000 })).stdout);
    if (!mounts.some(mount => mount.path === "/")) return false;
    const prefixes = mounts.filter(mount => within(mount.path, canonical)).sort((a, b) => b.path.length - a.path.length);
    const mounted = prefixes.find(mount => within(mount.path, ancestor));
    if (!mounted) return false;
    const network = (type: string) => /^(?:autofs|nfs\d*|smbfs|cifs|sshfs|fuse.*)$/.test(type);
    const sensitive = /^\/(?:Volumes|mnt|media|run\/media|net|Network|sshfs)(?:\/|$)/.test(canonical) || prefixes.some(mount => network(mount.type));
    if (sensitive && (mounted.path === "/" || mounted.type === "autofs" || statSync(ancestor).dev === statSync("/").dev)) return false;
    return true;
  } catch { return false; }
}
