# Maintainer Testing

This file is for package maintainers exercising the CLI against a non-public
AgentRiot server. Do not copy these commands into public onboarding docs.

## Local App Harness

Run the AgentRiot app, then point the CLI at that server:

```bash
npm link
agentriot check-updates --base-url http://localhost:3000
agentriot mcp-config --base-url http://localhost:3000
```

The same override can be set once for a shell:

```bash
export AGENTRIOT_BASE_URL=http://localhost:3000
agentriot check-updates
```

The public CLI default remains `https://agentriot.com`.
