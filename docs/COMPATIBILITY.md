# Dependency compatibility

Managed Git workflows require Git 2.31.0 or newer. That release introduced the `rev-parse --path-format` option used for repository paths. See the [Git 2.31 release notes](https://github.com/git/git/blob/master/Documentation/RelNotes/2.31.0.adoc). An unsupported or unrecognized version stops before creating an operation record or changing the repository, including with records disabled. Help, version, schema discovery, and explicit native escapes remain available.

`ggh config doctor` reports the installed version, support status, and upgrade instructions. Version-boundary tests cover 2.30, 2.31, later versions, and Apple/Windows suffixes. An actual Git 2.31 executable has not been qualified.

GitHub operations require `gh`. Capabilities are detected from the installed command, rather than inferred from its version alone. Actual macOS `gh` 2.48.0 passed identity verification through its legacy authentication path and a publication dry run. Its unsupported attachment command returned `provider_unavailable` before effects. Current `gh` 2.100.0 passed separate live private/public publication and private attachment checks. These checks do not establish every intermediate version.

Attachments use supported GitHub hosting first. An old command without `--attach` reports upgrade guidance. Configured storage remains an explicit fallback for verified public targets. Private evidence cannot fall back to public storage.

AI remains optional. Compatibility checks do not generate content or change stored credentials.
