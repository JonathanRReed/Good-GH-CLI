# Execution model review

The new failures fit the current boundaries. Keep those boundaries and remove
duplicate handling where the same failure can arrive through more than one path.

Publication uses one upstream helper for repository creation and PR creation.
The single-branch-clone fix now applies to both paths. A real private PR recovered
from a confirmed push, and the existing publication suite verifies the repository
path, preserved fetch settings and repeated setup without duplicate mappings.

Native entry-point cleanup now uses one closed-pipe handler for POSIX SIGPIPE,
Windows stdout EPIPE and a synchronous EPIPE rejection. The POSIX terminal checks
passed after the change. Windows must qualify the same exact artifact in ConPTY.

The journal's atomic writer now removes incomplete files across write, sync,
close and rename failures. A synthetic ENOSPC check proves commit/index/HEAD
preservation and cleanup at the actual file-write boundary.

No additional execution framework is needed for these cases. The publication
plan, confirmed steps, remaining steps and metadata-only recovery intent already
express them. Keep independent Git effects in those services and avoid adding
a generic wrapper that would hide their different recovery rules.
