# Notice

Herdr Model Router is a derivative of **agent-router**:

- Source: https://github.com/nidhi-singh02/agent-router
- Forked at commit `fb24d06a62fb33a92c7836b4920ae9f4b1216c63`
- License: MIT, Copyright (c) 2026 Nidhi Singh

The upstream license text is kept in [LICENSE](LICENSE). The upstream Git history is preserved
in this repository. The quota-mode router, Herdr launcher, session store, live effort
switching, coordinator, and heartbeat packages come from upstream; the rules-mode parser,
project policy, native launch, dispatch store, and task commands were added in this fork.

## Design references

The role-table format and the provider/model dispatch conventions follow the public
documentation of **open-pstack** (https://github.com/ericlitman/open-pstack), in particular its
provider-dispatch reference and its issue #141 on environment handling. No open-pstack source
code is included in this repository.

## Third-party packages

Runtime and development dependencies are installed from npm under their own licenses; see
`package-lock.json` for the exact versions.
