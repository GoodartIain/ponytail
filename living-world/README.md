# Living World

Browser tabletop / worldbuilding platform. This folder holds the first vertical slice: worlds, campaigns, advancement settings, invites, and nested map → wiki navigation with server-enforced visibility.

```sh
node server.js            # http://localhost:3000, data in ./data.json (PORT, DATA_FILE override)
node --test test/*.test.js
```

No dependencies; Node 22+. Design: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Status: [docs/MILESTONES.md](docs/MILESTONES.md).
